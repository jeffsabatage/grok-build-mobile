import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const secret = fs.readFileSync(path.join(root, ".secret"), "utf8").trim();
const sid = process.argv[2] || "01a09bb0-24b9-7582-a64e-ba543c922706";
const cwd = "C:\\Users\\Jeff\\.grok\\bin";
const marker = "[Grok Remote] e2e ws " + Date.now();
const url = "ws://127.0.0.1:2420/acp?server-key=" + encodeURIComponent(secret);

const ws = new WebSocket(url);
let n = 1;
const pending = new Map();
const send = (method, params, ms = 20000) => {
  const id = n++;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout " + method)), ms);
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
  });
};

ws.on("message", (raw) => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});
ws.on("close", () => {
  for (const [, p] of pending) p.reject(new Error("ws closed"));
  pending.clear();
});
ws.on("error", (e) => console.log("WS_ERR", e.message));

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("ws connect timeout")), 8000);
  ws.on("open", () => { clearTimeout(t); resolve(); });
});
console.log("ws_open");
console.log("MARKER", marker);
try {
  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "e2e-ws-send", version: "0" },
  });
  console.log("init_ok");
  try {
    await send("authenticate", { methodId: "cached_token", _meta: { headless: true } }, 12000);
    console.log("auth_ok");
  } catch (e) {
    console.log("auth_skip", e.message);
  }
  await send("session/resume", { sessionId: sid, cwd, mcpServers: [] }, 20000);
  console.log("resume_ok");
  send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: marker }] }, 8000)
    .then((r) => console.log("prompt_done", r?.stopReason || "ok"))
    .catch((e) => console.log("prompt_async", e.message));
  await new Promise((r) => setTimeout(r, 5000));
  const hist = fs.readFileSync(
    path.join(osHomedir(), ".grok", "sessions", "C%3A%5CUsers%5CJeff%5C.grok%5Cbin", "prompt_history.jsonl"),
    "utf8"
  );
  const landed = hist.includes(marker);
  console.log(landed ? "E2E_PASS" : "E2E_FAIL_NOT_IN_HISTORY");
} catch (e) {
  console.log("E2E_FAIL", e.message);
}
try { ws.close(); } catch {}
process.exit(0);

function osHomedir() {
  return process.env.USERPROFILE || process.env.HOME;
}
