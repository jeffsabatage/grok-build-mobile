import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { WebSocketServer } from "ws";

const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const GROK_BIN = process.env.GROK_BIN || path.join(GROK_HOME, "bin", process.platform === "win32" ? "grok.exe" : "grok");
const DEFAULT_CWD = process.env.GROK_REMOTE_CWD || process.cwd();

export function annotatePromptFrame(raw) {
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    const msg = JSON.parse(text);
    if (msg?.method === "session/prompt" && Array.isArray(msg.params?.prompt)) {
      msg.params.prompt = msg.params.prompt.map((block) => {
        if (block && block.type === "text" && typeof block.text === "string") {
          const t = block.text.trim();
          if (!t || t.startsWith("[Grok Remote]") || t.startsWith("/")) return block;
          return { ...block, text: `[Grok Remote] ${block.text}` };
        }
        return block;
      });
      return JSON.stringify(msg);
    }
    return text;
  } catch {
    return typeof raw === "string" ? raw : raw.toString();
  }
}

export function spawnLeaderStdio({ log = () => {} } = {}) {
  const proc = spawn(GROK_BIN, ["agent", "--leader", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    cwd: DEFAULT_CWD,
    env: {
      ...process.env,
      GROK_BIN,
      GROK_HOME,
      HOME: process.env.HOME || os.homedir(),
    },
  });
  proc.stderr.on("data", (buf) => {
    const line = buf.toString().replace(/\s+/g, " ").slice(0, 240);
    if (line.trim()) log("leader-err", line);
  });
  proc.on("exit", (code, signal) => log("leader-exit", code, signal || ""));
  return proc;
}

/** Each phone WebSocket is a grok agent --leader stdio client of the live TUI leader. */
export function attachAcpProxy(server, { secret, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let u;
    try {
      u = new URL(req.url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (u.pathname !== "/acp" && u.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const key = u.searchParams.get("server-key") || u.searchParams.get("secret") || "";
    if (key !== secret) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const proc = spawnLeaderStdio({ log });
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.method && msg.id !== undefined) log("acp←", msg.method);
        } catch {
          /* ignore */
        }
        if (client.readyState === 1) client.send(line);
      });
      client.on("message", (data) => {
        const frame = annotatePromptFrame(data);
        try {
          proc.stdin.write(frame.endsWith("\n") ? frame : frame + "\n");
        } catch (err) {
          log("leader-write", err.message);
        }
      });
      const closeBoth = (why) => {
        log("acp-proxy close", why || "");
        try {
          rl.close();
        } catch {
          /* ignore */
        }
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        try {
          client.close();
        } catch {
          /* ignore */
        }
      };
      client.on("close", () => closeBoth("client"));
      client.on("error", (err) => closeBoth(err.message));
      proc.on("exit", () => closeBoth("leader-exit"));
      log("acp-proxy leader stdio spawned");
    });
  });
}
