/**
 * Phone-path e2e: same handshake/resume/prompt the Android client uses.
 * Hard cases: busy TUI, concurrent sockets, session/list during prompt, reconnect.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const secret = fs.readFileSync(path.join(root, ".secret"), "utf8").trim();
const sid = process.argv[2] || "01a09bb0-24b9-7582-a64e-ba543c922706";
const cwd = "C:\\Users\\Jeff\\.grok\\bin";
const stamp = Date.now();
const marker = `[Grok Remote] phone-path ${stamp}`;
const url = "ws://127.0.0.1:2420/acp?server-key=" + encodeURIComponent(secret);
const histFile = path.join(
  os.homedir(),
  ".grok",
  "sessions",
  "C%3A%5CUsers%5CJeff%5C.grok%5Cbin",
  "prompt_history.jsonl"
);

function log(...a) {
  console.log(new Date().toISOString().slice(11, 23), ...a);
}

function openClient(label) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let n = 1;
  const client = {
    label,
    ws,
    closed: false,
    closeReason: "",
    send(method, params, ms = 20000) {
      const id = n++;
      if (ws.readyState !== 1) return Promise.reject(new Error(label + " not open"));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(label + " timeout " + method)), ms);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(t);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(t);
            reject(e);
          },
        });
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  ws.on("close", (code, reason) => {
    client.closed = true;
    client.closeReason = String(code) + " " + String(reason || "");
    for (const [, p] of pending) p.reject(new Error("ws closed"));
    pending.clear();
  });
  ws.on("error", (e) => log(label, "WS_ERR", e.message));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + " connect timeout")), 8000);
    ws.on("open", () => {
      clearTimeout(t);
      resolve(client);
    });
  });
}

async function phoneHandshake(client) {
  await client.send(
    "initialize",
    {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        _meta: { "x.ai/planApproval": true },
      },
      clientInfo: { name: "grok-remote", title: "Grok Remote", version: "0.1.59" },
    },
    30000
  );
  log(client.label, "init_ok");
  try {
    await client.send("authenticate", { methodId: "cached_token" }, 5000);
    log(client.label, "auth_ok");
  } catch (e) {
    log(client.label, "auth_skip", e.message);
  }
  await client.send("session/resume", { sessionId: sid, cwd, mcpServers: [] }, 20000);
  log(client.label, "resume_ok");
}

function historyHas(text) {
  try {
    return fs.readFileSync(histFile, "utf8").includes(text);
  } catch {
    return false;
  }
}

async function waitHistory(text, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (historyHas(text)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return historyHas(text);
}

const results = [];
function pass(name) {
  results.push({ name, ok: true });
  log("PASS", name);
}
function fail(name, err) {
  results.push({ name, ok: false, err: String(err.message || err) });
  log("FAIL", name, err.message || err);
}

try {
  log("http health");
  const health = await fetch("http://127.0.0.1:2420/api/health").then((r) => r.json());
  log("health", health.version, "bridgeUp", health.bridgeUp);
  if (!health.bridgeUp) fail("bridgeUp health", new Error("bridgeUp false"));
  else pass("bridgeUp health");

  log("idle TCP probe must not kill bridge");
  await new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port: 2421 }, () => {
      s.end();
      resolve();
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("probe connect timeout")), 2000);
  });
  await new Promise((r) => setTimeout(r, 1500));
  const healthy = await fetch("http://127.0.0.1:2422/health").then((r) => r.json()).catch(() => null);
  if (healthy?.ok) pass("bridge survived TCP probe");
  else fail("bridge survived TCP probe", new Error("2422/health down"));

  const httpMarker = `[Grok Remote] http-send ${stamp}`;
  const secretQs = encodeURIComponent(secret);
  const httpRes = await fetch(
    `http://127.0.0.1:2420/api/sessions/${encodeURIComponent(sid)}/prompt?secret=${secretQs}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: httpMarker }),
    }
  );
  const httpBody = await httpRes.json().catch(() => ({}));
  log("http prompt", httpRes.status, JSON.stringify(httpBody));
  const httpLanded = httpBody.landed || (await waitHistory(httpMarker, 8000));
  if (httpRes.ok && httpLanded) pass("HTTP prompt landed");
  else if (httpRes.ok && httpBody.accepted) fail("HTTP prompt landed", new Error("accepted but not in history"));
  else fail("HTTP prompt landed", new Error(httpBody.error || ("HTTP " + httpRes.status)));

  log("ws phone path");
  const a = await openClient("phone");
  log("ws_open phone");
  await phoneHandshake(a);
  pass("phone handshake");

  const b = await openClient("concurrent");
  log("ws_open concurrent");
  try {
    await phoneHandshake(b);
    pass("concurrent handshake");
  } catch (e) {
    fail("concurrent handshake", e);
  }

  try {
    await a.send("session/list", {}, 8000);
    pass("session/list during live");
  } catch (e) {
    fail("session/list during live", e);
  }

  try {
    a.send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: marker }] }, 8000).catch((e) =>
      log("prompt_async", e.message)
    );
    const landed = await waitHistory(marker, 10000);
    if (landed) pass("prompt landed while TUI busy");
    else fail("prompt landed while TUI busy", new Error("not in prompt_history.jsonl"));
  } catch (e) {
    fail("prompt send", e);
  }

  if (a.closed) fail("phone ws stayed open", new Error(a.closeReason || "closed"));
  else pass("phone ws stayed open");

  a.close();
  await new Promise((r) => setTimeout(r, 500));
  const c = await openClient("reconnect");
  await phoneHandshake(c);
  const marker2 = `[Grok Remote] phone-reconn ${stamp}`;
  c.send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: marker2 }] }, 8000).catch((e) =>
    log("reconn_prompt_async", e.message)
  );
  const landed2 = await waitHistory(marker2, 10000);
  if (landed2) pass("reconnect prompt landed");
  else fail("reconnect prompt landed", new Error("not in prompt_history.jsonl"));
  c.close();
  try {
    b.close();
  } catch {
    /* ignore */
  }
} catch (e) {
  fail("fatal", e);
}

const failed = results.filter((r) => !r.ok);
log("SUMMARY", JSON.stringify(results));
if (failed.length) {
  log("E2E_FAIL", failed.map((f) => f.name).join(", "));
  process.exit(2);
}
log("E2E_PASS");
process.exit(0);
