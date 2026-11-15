import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
export const GROK_BIN =
  process.env.GROK_BIN || path.join(GROK_HOME, "bin", process.platform === "win32" ? "grok.exe" : "grok");
export const DEFAULT_CWD = process.env.GROK_REMOTE_CWD || process.cwd();
export const ACP_BRIDGE_PORT = Number(process.env.GROK_REMOTE_ACP_BRIDGE || 2421);
export const ACP_BRIDGE_HTTP_PORT = Number(process.env.GROK_REMOTE_TUI_INJECT || 2422);

export function isLocalSystem() {
  const user = String(process.env.USERNAME || process.env.USER || "").toLowerCase();
  const profile = String(process.env.USERPROFILE || "").replace(/\//g, "\\").toLowerCase();
  return user === "system" || profile.includes("system32\\config\\systemprofile");
}

let lastBridgeKick = 0;
export function kickAcpBridge() {
  const now = Date.now();
  if (now - lastBridgeKick < 8000) return;
  lastBridgeKick = now;
  try {
    spawn("schtasks.exe", ["/Run", "/TN", "GrokRemoteAcpBridge"], {
      windowsHide: true,
      stdio: "ignore",
      detached: true,
    }).unref();
  } catch {
    /* ignore */
  }
}

export function bridgeHealthy({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: ACP_BRIDGE_HTTP_PORT, path: "/health", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export function liveSessionPid(sessionId) {
  if (!sessionId) return 0;
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(GROK_HOME, "active_sessions.json"), "utf8"));
    const hit = (rows || []).find((r) => r && r.session_id === sessionId);
    const pid = Number(hit?.pid || 0);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

// Signal 0 checks that the process exists. EPERM means it exists and this
// account cannot signal it. A stale active_sessions.json pid is ESRCH.
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === "EPERM");
  }
}

export function liveSessionAlive(sessionId) {
  const pid = liveSessionPid(sessionId);
  if (!pid || !pidAlive(pid)) return 0;
  return pid;
}

export function findLeaderSocket() {
  if (process.env.GROK_LEADER_SOCKET) return process.env.GROK_LEADER_SOCKET;
  if (process.platform === "win32") {
    try {
      const names = fs.readdirSync("\\\\.\\pipe\\").filter((n) => /^grok-leader-/i.test(n));
      if (names.length) return "\\\\.\\pipe\\" + names[0];
    } catch {
      /* ignore */
    }
  }
  const sock = path.join(GROK_HOME, "leader.sock");
  if (fs.existsSync(sock)) return sock;
  return "";
}

export function spawnLeaderStdio({ log = () => {} } = {}) {
  const sock = findLeaderSocket();
  // --leader is Access Denied on this Windows named pipe. --no-leader +
  // session/resume of an already-open session focuses the live TUI (1.0.33+).
  const args = ["agent", "--no-leader", "stdio"];
  const isWinPipe = /^\\\\[.]\\pipe\\/i.test(sock || "");
  // grok --leader-socket expects a filesystem path (leader.sock). A Windows
  // named pipe here makes grok look for a lock file and exit with os error 2.
  if (sock && !isWinPipe) args.splice(1, 0, "--leader-socket", sock);
  log("leader-stdio", sock || "(no socket found)", isWinPipe ? "pipe-autodiscover" : "");
  const proc = spawn(GROK_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    cwd: DEFAULT_CWD,
    env: {
      ...process.env,
      GROK_BIN,
      GROK_HOME,
      HOME: process.env.HOME || os.homedir(),
      USERPROFILE: process.env.USERPROFILE || os.homedir(),
      ...(sock && !isWinPipe ? { GROK_LEADER_SOCKET: sock } : {}),
    },
  });
  proc.stderr.on("data", (buf) => {
    const line = buf.toString().replace(/\s+/g, " ").slice(0, 240);
    if (line.trim()) log("leader-err", line);
  });
  proc.on("exit", (code, signal) => log("leader-exit", code, signal || ""));
  return proc;
}
