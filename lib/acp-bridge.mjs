#!/usr/bin/env node
/**
 * User-session ACP bridge. Must run as the same Windows user as the TUI
 * so grok agent --leader stdio can open the live leader named pipe.
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawn } from "node:child_process";
import { ACP_BRIDGE_PORT, spawnLeaderStdio, findLeaderSocket, GROK_HOME } from "./leader.mjs";
import { fetchAccountUsage } from "./account-usage.mjs";

const logDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "acp-bridge.log");
const log = (...a) => {
  const line = [new Date().toISOString(), ...a].join(" ");
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {
    /* ignore */
  }
};
process.on("uncaughtException", (err) => log("uncaught", err.message || err));
process.on("unhandledRejection", (err) => log("unhandled", err?.message || err));

const sock = findLeaderSocket();
log("acp-bridge listen", ACP_BRIDGE_PORT, "leader", sock || "(none)");

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  let proc = null;
  let closed = false;
  const close = (why) => {
    if (closed) return;
    closed = true;
    log("session close", why || "");
    try {
      proc?.kill();
    } catch {
      /* ignore */
    }
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  };
  const start = () => {
    if (proc || closed) return proc;
    proc = spawnLeaderStdio({ log: (...a) => log("[child]", ...a) });
    proc.stdout.on("data", (buf) => {
      if (closed) return;
      try {
        socket.write(buf);
      } catch (err) {
        close("stdout " + err.message);
      }
    });
    proc.stdout.on("error", (err) => close("stdout " + err.message));
    proc.stdin.on("error", (err) => close("stdin " + err.message));
    proc.stderr.on("error", () => {});
    proc.on("exit", () => close("leader-exit"));
    return proc;
  };
  socket.on("data", (buf) => {
    if (closed) return;
    start();
    try {
      proc.stdin.write(buf);
    } catch (err) {
      close("write " + err.message);
    }
  });
  socket.on("close", () => close("tcp"));
  socket.on("error", (err) => close(err.message));
  socket.setTimeout(4000, () => {
    if (!proc) close("idle-probe");
  });
});

server.on("error", (err) => {
  log("listen error", err.message);
  process.exit(1);
});
server.listen(ACP_BRIDGE_PORT, "127.0.0.1", () => {
  log("ready 127.0.0.1:" + ACP_BRIDGE_PORT);
});

const INJECT_PORT = Number(process.env.GROK_REMOTE_TUI_INJECT || 2422);
const typeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "tui-type.ps1");

function sessionPid(sessionId) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(GROK_HOME, "active_sessions.json"), "utf8"));
    const hit = (rows || []).find((r) => r && r.session_id === sessionId);
    return hit?.pid || 0;
  } catch {
    return 0;
  }
}

function runTypeScript(pid, text, submit = true) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const txt = path.join(dir, "inject-job.txt");
  fs.writeFileSync(txt, text, "utf8");
  return new Promise((resolve, reject) => {
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", typeScript, "-ProcessId", String(pid)],
      { windowsHide: true, env: { ...process.env, TUI_TYPE_FILE: txt, TUI_TYPE_SUBMIT: submit ? "1" : "0" } }
    );
    let out = "";
    ps.stdout.on("data", (b) => {
      out += b;
    });
    ps.stderr.on("data", (b) => {
      out += b;
    });
    ps.on("exit", (code) => {
      const msg = out.trim();
      if (code === 0 && /^ok/i.test(msg)) resolve({ ok: true, pid, out: msg });
      else reject(new Error(msg || "tui-type exit " + code));
    });
  });
}

function injectTui(sessionId, text, submit = true) {
  const pid = sessionPid(sessionId);
  if (!pid) return Promise.reject(new Error("no live TUI pid for session"));
  const body = String(text || "").replace(/\r?\n/g, " ").slice(0, 4000);
  if (!body.trim()) return Promise.reject(new Error("empty"));
  return runTypeScript(pid, body, submit).catch((err) => {
    log("tui-type direct fail", err.message, "— schtasks fallback");
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const job = path.join(dir, "inject-job.json");
    const result = path.join(dir, "inject-job.result");
    try {
      fs.unlinkSync(result);
    } catch {
      /* ignore */
    }
    fs.writeFileSync(job, JSON.stringify({ pid, sessionId, text: body }), "utf8");
    return new Promise((resolve, reject) => {
      const ps = spawn("schtasks.exe", ["/Run", "/TN", "GrokRemoteInject"], { windowsHide: true });
      ps.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error("schtasks GrokRemoteInject exit " + code));
          return;
        }
        const t0 = Date.now();
        const tick = () => {
          if (fs.existsSync(result)) {
            const r = fs.readFileSync(result, "utf8").trim();
            if (/^ok/i.test(r)) resolve({ ok: true, pid, out: r });
            else reject(new Error(r || "inject failed"));
            return;
          }
          if (Date.now() - t0 > 12000) {
            reject(new Error("inject task timeout"));
            return;
          }
          setTimeout(tick, 200);
        };
        setTimeout(tick, 300);
      });
    });
  });
}

http.createServer((req, res) => {
  const raw = String(req.url || "");
  const url = raw.split("?")[0];
  const q = new URL(raw, "http://127.0.0.1").searchParams;
  if (req.method === "GET" && (url === "/health" || url === "/")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ ok: true, pid: process.pid, port: ACP_BRIDGE_PORT })
    );
    return;
  }
  if (req.method === "GET" && url === "/usage") {
    const force = q.get("force") === "1" || q.get("force") === "true";
    fetchAccountUsage({ force })
      .then((snap) => {
        const body = JSON.stringify(snap || { ok: false, error: "usage unavailable" });
        const code = snap?.ok ? 200 : 502;
        res.writeHead(code, { "Content-Type": "application/json" }).end(body);
      })
      .catch((err) => {
        const error = String(err?.message || err || "usage failed")
          .replace(/Bearer\s+\S+/gi, "Bearer ***")
          .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, "[jwt]")
          .slice(0, 240);
        log("usage fail", error);
        res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error }));
      });
    return;
  }
  if (req.method !== "POST" || url !== "/inject") {
    res.writeHead(404).end("not found");
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      res.writeHead(400).end(JSON.stringify({ ok: false, error: "bad json" }));
      return;
    }
    injectTui(body.sessionId, body.text, body.submit !== false)
      .then((r) => {
        log("tui-inject", r.pid, (body.text || "").slice(0, 60));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
      })
      .catch((err) => {
        log("tui-inject fail", err.message);
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: err.message }));
      });
  });
}).listen(INJECT_PORT, "127.0.0.1", () => log("inject http 127.0.0.1:" + INJECT_PORT));
