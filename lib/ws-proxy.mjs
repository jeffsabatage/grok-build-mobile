import net from "node:net";
import readline from "node:readline";
import { WebSocketServer } from "ws";
import { ACP_BRIDGE_PORT, spawnLeaderStdio, kickAcpBridge, isLocalSystem } from "./leader.mjs";

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

function connectBridge({ timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: ACP_BRIDGE_PORT });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("acp-bridge timeout"));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(t);
      sock.setNoDelay(true);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function writeFrame(writable, data) {
  const frame = annotatePromptFrame(data);
  writable.write(frame.endsWith("\n") ? frame : frame + "\n");
}

function attachStreamClient(client, readable, writable, kill, { log, label, early = [] }) {
  const rl = readline.createInterface({ input: readable });
  let closed = false;
  const close = (why) => {
    if (closed) return;
    closed = true;
    log("acp-proxy close", why || "", label || "");
    try { rl.close(); } catch { /* ignore */ }
    try { kill(); } catch { /* ignore */ }
    try { client.close(); } catch { /* ignore */ }
  };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (client.readyState === 1) client.send(line);
  });
  readable.on("error", (err) => close(err.message));
  writable.on("error", (err) => close("write " + err.message));
  for (const data of early) {
    try {
      writeFrame(writable, data);
    } catch (err) {
      log("leader-write", err.message);
      close("write");
      return close;
    }
  }
  client.on("message", (data) => {
    try {
      writeFrame(writable, data);
    } catch (err) {
      log("leader-write", err.message);
      close("write");
    }
  });
  client.on("close", () => close("client"));
  client.on("error", (err) => close(err.message));
  return close;
}

async function connectBridgeRetry(log, client) {
  let last = new Error("acp-bridge down");
  for (let i = 0; i < 10; i++) {
    if (client.readyState !== 1) throw new Error("client closed");
    try {
      return await connectBridge({ timeoutMs: 1500 });
    } catch (err) {
      last = err;
      log("acp-bridge miss", err.message, "try", i + 1);
      if (i === 0 || i === 2 || i === 5) kickAcpBridge();
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

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
    wss.handleUpgrade(req, socket, head, async (client) => {
      const early = [];
      const onEarly = (data) => early.push(data);
      client.on("message", onEarly);
      const dropEarly = () => {
        try { client.off("message", onEarly); } catch { /* ignore */ }
      };
      try {
        const bridge = await connectBridgeRetry(log, client);
        dropEarly();
        const close = attachStreamClient(client, bridge, bridge, () => bridge.destroy(), {
          log,
          label: "jeff-bridge",
          early,
        });
        bridge.on("close", () => close("bridge"));
        bridge.on("error", (err) => close(err.message));
        log("acp-proxy via jeff-bridge --no-leader");
        return;
      } catch (err) {
        log("acp-bridge miss", err.message, isLocalSystem() ? "— not spawning as SYSTEM" : "— spawning local grok");
      }
      if (isLocalSystem()) {
        dropEarly();
        try { client.close(); } catch { /* ignore */ }
        return;
      }
      const proc = spawnLeaderStdio({ log });
      dropEarly();
      attachStreamClient(client, proc.stdout, proc.stdin, () => proc.kill(), { log, label: "local", early });
      proc.on("exit", () => {
        try { client.close(); } catch { /* ignore */ }
      });
      log("acp-proxy local --no-leader");
    });
  });
}
