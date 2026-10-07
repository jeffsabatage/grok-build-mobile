#!/usr/bin/env node
/**
 * Grok Remote LAN gateway.
 * Serves the mobile UI on :2420 and (if needed) starts `grok agent serve` on :2419.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, spawnSync, execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AcpClient } from "./lib/acp.mjs";
import { detectLanIp, isTrustedLanPeer, listLanCandidates, normalizePeerIp } from "./lib/lan.mjs";
import { attachAcpProxy } from "./lib/ws-proxy.mjs";
import { buildHistory, buildMeta, findUpdatesFile, parseUpdateLine, renameSession, deleteSessionDir, readPlanMarkdown, listDiskSessions } from "./lib/history.mjs";
import { listWorkspace, searchWorkspace } from "./lib/fs-browse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DOWNLOADS = path.join(ROOT, "downloads");
const SECRET_FILE = path.join(ROOT, ".secret");
const MANIFEST_FILE = path.join(ROOT, "app-manifest.json");
const CHANGELOG_FILE = path.join(ROOT, "changelog.json");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const GROK_BIN = process.env.GROK_BIN || path.join(GROK_HOME, "bin", process.platform === "win32" ? "grok.exe" : "grok");
const HTTP_PORT = Number(process.env.GROK_REMOTE_HTTP_PORT || 2420);
const ACP_PORT = Number(process.env.GROK_REMOTE_ACP_PORT || 2419);
const DEFAULT_CWD = process.env.GROK_REMOTE_CWD || process.cwd();
const BIND_HOST = process.env.GROK_REMOTE_BIND || "0.0.0.0";

function readGrokBuildVersion() {
  try {
    const r = spawnSync(GROK_BIN, ["--version"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    const t = String(r.stdout || r.stderr || "").trim();
    const m = t.match(/grok\s+([\d.]+)/i) || t.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : t.split(/\s+/)[1] || t.slice(0, 40);
  } catch {
    return "";
  }
}
const GROK_BUILD = readGrokBuildVersion();

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadSecret() {
  if (process.env.GROK_REMOTE_SECRET) return process.env.GROK_REMOTE_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, "utf8").trim();
  const s = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(SECRET_FILE, s, { encoding: "utf8" });
  try {
    fs.chmodSync(SECRET_FILE, 0o600);
  } catch {
    /* windows */
  }
  return s;
}

function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(800, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function mime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".apk": "application/vnd.android.package-archive",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json",
    }[ext] || "application/octet-stream"
  );
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Grok-Remote-Secret");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function unauthorized(req, secret) {
  const u = new URL(req.url, "http://localhost");
  const q = u.searchParams.get("secret") || u.searchParams.get("server-key");
  const h =
    req.headers["x-grok-remote-secret"] ||
    (String(req.headers.authorization || "").match(/^Bearer\s+(.+)/i) || [])[1];
  const got = String(q || h || "");
  const a = Buffer.from(got);
  const b = Buffer.from(String(secret || ""));
  if (a.length !== b.length) return true;
  return !crypto.timingSafeEqual(a, b);
}

async function waitForAcp(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(ACP_PORT, "127.0.0.1")) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function spawnGrok({ secret, lanIp }) {
  const bind = `${BIND_HOST}:${ACP_PORT}`;
  const args = ["agent", "serve", "--bind", bind, "--secret", secret];
  log("starting", GROK_BIN, args.filter((a) => a !== secret).join(" "), `(bind ${bind})`);
  const child = spawn(GROK_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GROK_AGENT_SECRET: secret },
    windowsHide: true,
  });
  const onLine = (buf) => {
    for (const line of buf.toString().split(/\r?\n/).filter(Boolean)) {
      log("[grok]", line.replace(secret, "…"));
    }
  };
  child.stdout.on("data", onLine);
  child.stderr.on("data", onLine);
  child.on("exit", (code, signal) => {
    log("grok agent exited", code, signal || "");
  });
  return child;
}

const state = {
  secret: "",
  lanIp: null,
  grok: null,
  sidecar: null,
  sessions: [],
  lastRosterAt: 0,
  notifyClients: new Set(),
  lastNotify: {},
  pcQueue: {},
  gatewayAcpSession: "",
};

function isNeedsYouActivity(activity) {
  const a = String(activity || "").toLowerCase();
  if (!a) return false;
  return /needs[_ ]?(you|input)|permission|blocked|waiting[_ ]?(for[_ ]?)?(user|input|approval)/.test(a);
}

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of state.notifyClients) {
    try {
      res.write(line);
    } catch {
      state.notifyClients.delete(res);
    }
  }
}

function normalizeSession(s) {
  if (!s) return null;
  const id = s.sessionId || s.session_id;
  if (!id) return null;
  return {
    sessionId: id,
    title: s.title || s.generated_title || "Untitled",
    cwd: s.cwd || DEFAULT_CWD,
    updatedAt: s.updatedAt || s.updated_at || null,
    activity: s.activity || (s.resident ? "live" : "idle"),
    resident: !!s.resident,
    modelId: s.modelId || s.current_model_id || null,
    reasoningEffort: s.reasoningEffort || null,
    lastTurnSummary: s.lastTurnSummary || s.last_turn_summary || "",
    yolo: !!s.yolo,
    origin: s.origin || null,
  };
}

async function refreshRoster() {
  try {
    const disk = listDiskSessions().map(normalizeSession).filter(Boolean);
    const byId = new Map(disk.map((s) => [s.sessionId, s]));
    if (state.sidecar?.ready) {
      try {
        const list = await state.sidecar.listSessions();
        for (const raw of list || []) {
          const s = normalizeSession(raw);
          if (!s) continue;
          const prev = byId.get(s.sessionId) || {};
          byId.set(s.sessionId, {
            ...prev,
            ...s,
            title: s.title && s.title !== "Untitled" ? s.title : prev.title || s.title,
            lastTurnSummary: s.lastTurnSummary || prev.lastTurnSummary || "",
          });
        }
      } catch (err) {
        log("acp roster error", err.message);
      }
    }
    const sessions = [...byId.values()];
    sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const prev = new Map(state.sessions.map((s) => [s.sessionId, s]));
    state.sessions = sessions;
    state.lastRosterAt = Date.now();
    for (const s of sessions) {
      const old = prev.get(s.sessionId);
      const key = `${s.sessionId}:${s.activity}`;
      if (old && old.activity === s.activity) continue;
      if (isNeedsYouActivity(s.activity)) {
        if (state.lastNotify[key] && Date.now() - state.lastNotify[key] < 20_000) continue;
        state.lastNotify[key] = Date.now();
        broadcast({
          type: "needs_input",
          sessionId: s.sessionId,
          title: s.title,
          activity: s.activity,
          summary: s.lastTurnSummary,
        });
      } else if (
        old &&
        /work|runn?ing|busy/i.test(old.activity) &&
        !/work|runn?ing|busy/i.test(s.activity || "")
      ) {
        const doneKey = `${s.sessionId}:done`;
        if (state.lastNotify[doneKey] && Date.now() - state.lastNotify[doneKey] < 30_000) continue;
        state.lastNotify[doneKey] = Date.now();
        broadcast({
          type: "turn_complete",
          sessionId: s.sessionId,
          title: s.title,
          activity: s.activity,
          summary: s.lastTurnSummary,
        });
      }
    }
  } catch (err) {
    log("roster error", err.message);
  }
}

function tasklistHas(image) {
  return new Promise((resolve) => {
    execFile(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq " + image, "/NH"],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        const s = String(stdout || "");
        resolve(/consent/i.test(s) && !/No tasks/i.test(s));
      }
    );
  });
}
async function isUacPromptUp() {
  if (await tasklistHas("consent.exe")) return true;
  if (await tasklistHas("ConsentUX.exe")) return true;
  return false;
}
function startUacWatch() {
  let up = false;
  const tick = async () => {
    try {
      const now = await isUacPromptUp();
      if (now && !up) {
        up = true;
        log("UAC prompt on this PC");
        broadcast({
          type: "uac_prompt",
          title: "UAC on the PC",
          summary: "Windows needs administrator approval on this PC.",
        });
      } else if (!now && up) {
        up = false;
      }
    } catch (err) {
      log("uac watch", err.message);
    }
  };
  setInterval(tick, 2500);
  void tick();
}

function parseQueueChanged(params) {
  const p = params && typeof params === "object" ? params : {};
  const sessionId = String(p.sessionId || p.session_id || state.gatewayAcpSession || "");
  let raw = p.entries || p.queue || p.items || p.prompts || p.rows;
  if (!Array.isArray(raw) && Array.isArray(params)) raw = params;
  if (!Array.isArray(raw)) raw = [];
  const entries = raw
    .map((e, i) => {
      if (e == null) return null;
      if (typeof e === "string") return { id: String(i), text: e, source: "pc", index: i };
      const text = String(e.text || e.prompt || e.content || e.caption || e.message || "");
      const id = String(e.id || e.entryId || e.entry_id || e.promptId || e.prompt_id || i);
      return {
        id,
        text,
        source: /app|remote/i.test(String(e.source || "")) ? "app" : "pc",
        index: e.index != null ? Number(e.index) : i,
        running: !!(e.running || e.status === "running"),
      };
    })
    .filter((e) => e && (e.text || e.id));
  return { sessionId, entries };
}
function applyQueueNotification(params) {
  const q = parseQueueChanged(params);
  const sid = q.sessionId || state.gatewayAcpSession;
  if (!sid) return;
  state.pcQueue[sid] = q.entries;
  broadcast({ type: "queue_changed", sessionId: sid, entries: q.entries });
}
async function resumeGatewaySession(sessionId) {
  const acp = await ensureGatewayAcp();
  if (state.gatewayAcpSession === sessionId && acp.ready) return acp;
  const row = state.sessions.find((s) => s.sessionId === sessionId);
  const cwd = row?.cwd || DEFAULT_CWD;
  try {
    await acp.request("session/resume", { sessionId, cwd, mcpServers: [] }, { timeoutMs: 12000 });
  } catch (err) {
    log("queue resume", err.message);
  }
  state.gatewayAcpSession = sessionId;
  return acp;
}

async function ensureGatewayAcp() {
  if (state.gatewayAcp?.ready) return state.gatewayAcp;
  const secret = state.secret;
  const url = `ws://127.0.0.1:${HTTP_PORT}/acp?server-key=${encodeURIComponent(secret)}`;
  const client = new AcpClient(url, { log: (...a) => log("[acp]", ...a) });
  client.onNotification = (msg) => {
    const method = String(msg.method || "");
    if (/queue\/changed/i.test(method)) {
      if (!state._loggedQueueShape) {
        state._loggedQueueShape = true;
        log("queue/changed", JSON.stringify(msg.params || {}).slice(0, 500));
      }
      applyQueueNotification(msg.params);
    }
  };
  client.onClose = () => {
    if (state.gatewayAcp === client) {
      state.gatewayAcp = null;
      state.gatewayAcpSession = "";
    }
  };
  await client.connect();
  await client.request(
    "initialize",
    {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        _meta: { "x.ai/planApproval": true },
      },
      clientInfo: { name: "grok-remote", title: "Grok Remote", version: PKG.version },
    },
    { timeoutMs: 30_000 }
  );
  state.gatewayAcp = client;
  return client;
}

async function startSidecar(secret) {
  const url = `ws://127.0.0.1:${HTTP_PORT}/acp?server-key=${encodeURIComponent(secret)}`;
  const client = new AcpClient(url, { log: (...a) => log("[sidecar]", ...a) });
  client.onNotification = (msg) => {
    if (
      msg.method === "_x.ai/sessions/changed" ||
      msg.method === "x.ai/sessions/changed"
    ) {
      refreshRoster();
    }
    if (msg.method === "session/update") {
      const u = msg.params?.update || {};
      const kind = String(u.sessionUpdate || "");
      if (/request_permission|needs_input|ask_user_question/i.test(kind)) {
        const sid = msg.params?.sessionId;
        const key = `${sid}:needs`;
        if (!state.lastNotify[key] || Date.now() - state.lastNotify[key] > 20_000) {
          state.lastNotify[key] = Date.now();
          broadcast({
            type: "needs_input",
            sessionId: sid,
            title: "Approval needed",
            activity: "needs_input",
            summary: u.title || u.toolCall?.title || "",
          });
        }
      }
    }
  };
  let attached = false;
  client.onClose = () => {
    if (state.sidecar === client) state.sidecar = null;
    if (attached) log("sidecar closed");
  };
  try {
    await client.connect();
    await client.handshake({ createSession: false });
    attached = true;
    state.sidecar = client;
    await refreshRoster();
  } catch (err) {
    try { client.close(); } catch { /* ignore */ }
    throw err;
  }
}

function appManifest() {
  const m = readJson(MANIFEST_FILE, {});
  const changelog = readJson(CHANGELOG_FILE, []);
  const latest = changelog[0] || null;
  const apk = path.join(DOWNLOADS, "Grok-Remote.apk");
  return {
    ok: true,
    appId: m.appId || "com.sabatage.grokremote",
    appName: m.appName || "Grok Remote",
    latestVersion: m.latestVersion || PKG.version,
    minVersion: m.minVersion || "0.1.0",
    downloadUrl: m.downloadUrl || "/downloads/Grok-Remote.apk",
    changelogUrl: "/api/app/changelog",
    releaseNotes: m.releaseNotes || (latest ? `${latest.title}: ${ (latest.notes || []).join(" ")}` : ""),
    forceUpdate: !!m.forceUpdate,
    publishedAt: m.publishedAt || latest?.date || null,
    apkPresent: fs.existsSync(apk),
    serverVersion: PKG.version,
    grokBuild: GROK_BUILD,
  };
}

function handleApi(req, res, u, secret, lanIp) {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (u.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      name: "grok-remote",
      version: PKG.version,
      grokBuild: GROK_BUILD,
      lanIp,
      httpPort: HTTP_PORT,
      acpPort: ACP_PORT,
      acpReady: !!state.sidecar?.ready,
      sessions: state.sessions.length,
      cwd: DEFAULT_CWD,
    });
    return true;
  }

  if (u.pathname === "/api/pair") {
    const peer = req.socket?.remoteAddress || "";
    if (!isTrustedLanPeer(peer)) {
      log("pair refused", normalizePeerIp(peer) || "unknown");
      sendJson(res, 403, { ok: false, error: "pairing is limited to the local network" });
      return true;
    }
    sendJson(res, 200, {
      v: 1,
      host: lanIp,
      httpPort: HTTP_PORT,
      acpPort: ACP_PORT,
      secret,
      cwd: DEFAULT_CWD,
      http: `http://${lanIp}:${HTTP_PORT}`,
      ws: `ws://${lanIp}:${HTTP_PORT}/acp?server-key=${encodeURIComponent(secret)}`,
      grokBuild: GROK_BUILD,
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  if (u.pathname === "/api/app/manifest" || u.pathname === "/api/app/mobile-manifest") {
    sendJson(res, 200, appManifest());
    return true;
  }

  if (u.pathname === "/api/app/changelog") {
    sendJson(res, 200, { ok: true, entries: readJson(CHANGELOG_FILE, []) });
    return true;
  }

  if (u.pathname === "/downloads/Grok-Remote.apk" || u.pathname === "/api/app/apk") {
    const apk = path.join(DOWNLOADS, "Grok-Remote.apk");
    if (!fs.existsSync(apk)) {
      sendJson(res, 404, { ok: false, error: "APK not built yet" });
      return true;
    }
    cors(res);
    res.writeHead(200, {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Disposition": 'attachment; filename="Grok-Remote.apk"',
      "Content-Length": fs.statSync(apk).size,
    });
    fs.createReadStream(apk).pipe(res);
    return true;
  }

  if (unauthorized(req, secret) && u.pathname.startsWith("/api/")) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }

  if (u.pathname === "/api/fs") {
    const cwd = u.searchParams.get("cwd") || DEFAULT_CWD;
    const rel = u.searchParams.get("rel") || "";
    const q = u.searchParams.get("q") || "";
    if (q.trim().length >= 2) sendJson(res, 200, searchWorkspace(cwd, q));
    else sendJson(res, 200, listWorkspace(cwd, rel));
    return true;
  }

  if (u.pathname === "/api/sessions") {
    sendJson(res, 200, {
      ok: true,
      sessions: state.sessions,
      updatedAt: state.lastRosterAt,
    });
    return true;
  }

  {
    const sm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
    if (sm && req.method === "POST") {
      const sessionId = decodeURIComponent(sm[1]);
      readBody(req)
        .then(async (body) => {
          const text = String(body.text || "").trim();
          const images = Array.isArray(body.images) ? body.images : [];
          if (!text && !images.length) {
            sendJson(res, 400, { ok: false, error: "text required" });
            return;
          }
          const acp = await resumeGatewaySession(sessionId);
          let outbound = text;
          if (outbound && !outbound.startsWith("[Grok Remote]") && !outbound.startsWith("/")) {
            outbound = "[Grok Remote] " + outbound;
          }
          const prompt = [];
          if (outbound) prompt.push({ type: "text", text: outbound });
          for (const img of images) {
            if (img && img.b64) {
              prompt.push({ type: "image", mimeType: img.mime || "image/png", data: img.b64 });
            }
          }
          const turn = acp.request("session/prompt", { sessionId, prompt }, { timeoutMs: 300000 });
          sendJson(res, 200, { ok: true, accepted: true });
          turn.catch((err) => {
            log("prompt turn", err.message);
            if (/ws closed|WebSocket/i.test(String(err.message || ""))) {
              try {
                state.gatewayAcp?.close();
              } catch {
                /* ignore */
              }
              state.gatewayAcp = null;
            }
          });
        })
        .catch((err) => {
          log("prompt failed", err.message);
          try {
            state.gatewayAcp?.close();
          } catch {
            /* ignore */
          }
          state.gatewayAcp = null;
          if (!res.writableEnded) sendJson(res, 500, { ok: false, error: err.message });
        });
      return true;
    }
  }

  {
    const qm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/queue$/);
    if (qm && req.method === "GET") {
      const sessionId = decodeURIComponent(qm[1]);
      resumeGatewaySession(sessionId)
        .then(() => {
          sendJson(res, 200, { ok: true, entries: state.pcQueue[sessionId] || [] });
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message, entries: [] }));
      return true;
    }
    if (qm && req.method === "POST") {
      const sessionId = decodeURIComponent(qm[1]);
      readBody(req)
        .then(async (body) => {
          const action = String(body.action || "").toLowerCase();
          const acp = await resumeGatewaySession(sessionId);
          const id = body.id != null ? String(body.id) : "";
          const index = body.index != null ? Number(body.index) : undefined;
          const payloads =
            action === "clear"
              ? [{}]
              : action === "interject" || action === "start"
                ? [{ id }, { entryId: id }, { index }]
                : action === "remove" || action === "cancel"
                  ? [{ id }, { entryId: id }, { index }]
                  : null;
          if (!payloads) {
            sendJson(res, 400, { ok: false, error: "action must be cancel, start, or clear" });
            return;
          }
          const method =
            action === "clear"
              ? "x.ai/queue/clear"
              : action === "interject" || action === "start"
                ? "x.ai/queue/interject"
                : "x.ai/queue/remove";
          let lastErr = null;
          for (const params of payloads) {
            try {
              await acp.request(method, params, { timeoutMs: 15000 });
              lastErr = null;
              break;
            } catch (err) {
              lastErr = err;
            }
          }
          if (lastErr) throw lastErr;
          sendJson(res, 200, { ok: true, entries: state.pcQueue[sessionId] || [] });
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
      return true;
    }
  }

  {
    const mm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/meta$/);
    if (mm && req.method === "GET") {
      sendJson(res, 200, buildMeta(decodeURIComponent(mm[1])));
      return true;
    }
  }

  {
    const pm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/plan$/);
    if (pm && req.method === "GET") {
      sendJson(res, 200, readPlanMarkdown(decodeURIComponent(pm[1])));
      return true;
    }
  }

  {
    const pa = u.pathname.match(/^\/api\/sessions\/([^/]+)\/plan-action$/);
    if (pa && req.method === "POST") {
      const sessionId = decodeURIComponent(pa[1]);
      readBody(req)
        .then(async (body) => {
          const action = String(body.action || "").toLowerCase();
          if (!["approve", "quit"].includes(action)) {
            sendJson(res, 400, { ok: false, error: "action must be approve or quit" });
            return;
          }
          if (!state.sidecar?.ready) {
            sendJson(res, 503, { ok: false, error: "sidecar not ready" });
            return;
          }
          await state.sidecar.request("session/resume", { sessionId }, 20000);
          await state.sidecar.request(
            "session/prompt",
            { sessionId, prompt: [{ type: "text", text: "/plan" }] },
            60000
          );
          sendJson(res, 200, { ok: true, action, sent: "/plan" });
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
      return true;
    }
  }

  {
    const rm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/rename$/);
    if (rm && req.method === "POST") {
      const sessionId = decodeURIComponent(rm[1]);
      readBody(req)
        .then((body) => {
          const title = String(body.title || "").trim();
          if (!title) return sendJson(res, 400, { ok: false, error: "title required" });
          sendJson(res, 200, renameSession(sessionId, title));
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
      return true;
    }
  }

  {
    const dm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/delete$/);
    if (dm && req.method === "POST") {
      const sessionId = decodeURIComponent(dm[1]);
      const row = state.sessions.find((s) => s.sessionId === sessionId);
      if (row && (row.resident || /work|run|busy|live/i.test(String(row.activity || "")))) {
        sendJson(res, 409, { ok: false, error: "session is live on the PC — close it there first" });
        return true;
      }
      sendJson(res, 200, deleteSessionDir(sessionId));
      refreshRoster();
      return true;
    }
  }

  {
    const hm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (hm) {
      sendJson(res, 200, buildHistory(decodeURIComponent(hm[1])));
      return true;
    }
  }

  {
    const lm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/live$/);
    if (lm) {
      const sessionId = decodeURIComponent(lm[1]);
      const file = findUpdatesFile(sessionId);
      cors(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      try {
        res.socket?.setNoDelay?.(true);
      } catch {
        /* ignore */
      }
      res.write("retry: 1000\n\n");
      if (!file) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "session not found" })}\n\n`);
        return true;
      }
      let pos = 0;
      try {
        pos = fs.statSync(file).size;
      } catch {
        pos = 0;
      }
      let leftover = "";
      res.write(`data: ${JSON.stringify({ type: "watching", sessionId, size: pos })}\n\n`);
      const tick = () => {
        try {
          const st = fs.statSync(file);
          if (st.size < pos) {
            pos = 0;
            leftover = "";
          }
          if (st.size === pos) return;
          const len = st.size - pos;
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(file, "r");
          fs.readSync(fd, buf, 0, len, pos);
          fs.closeSync(fd);
          pos = st.size;
          leftover += buf.toString("utf8");
          const parts = leftover.split("\n");
          leftover = parts.pop() || "";
          for (const line of parts) {
            const update = parseUpdateLine(line);
            if (update) {
              const eventId = update._meta?.eventId || "";
              res.write(`data: ${JSON.stringify({ type: "update", eventId, update })}\n\n`);
            }
          }
        } catch {
          /* file busy */
        }
      };
      const iv = setInterval(tick, 400);
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* closed */
        }
      }, 15000);
      req.on("close", () => {
        clearInterval(iv);
        clearInterval(ping);
      });
      return true;
    }
  }

  if (u.pathname === "/api/events") {
    cors(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-store",
    });
    res.write("retry: 4000\n\n");
    res.write(`data: ${JSON.stringify({ type: "hello", sessions: state.sessions.length })}\n\n`);
    state.notifyClients.add(res);
    req.on("close", () => state.notifyClients.delete(res));
    return true;
  }

  return false;
}

function serveStatic(req, res, u) {
  let rel = u.pathname === "/" ? "/index.html" : u.pathname;
  if (rel.startsWith("/downloads/")) {
    const file = path.normalize(path.join(DOWNLOADS, rel.slice("/downloads/".length)));
    if (!file.startsWith(DOWNLOADS) || !fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime(file) });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const fallback = path.join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(fallback));
    return;
  }
  const headers = { "Content-Type": mime(file) };
  if (/\.(html|js|css|webmanifest)$/i.test(file)) headers["Cache-Control"] = "no-store";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

async function main() {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.mkdirSync(PUBLIC, { recursive: true });
  const secret = loadSecret();
  state.secret = secret;
  const lanIp = detectLanIp(process.env.GROK_REMOTE_HOST) || "127.0.0.1";
  state.lanIp = lanIp;

  log(`Grok Remote v${PKG.version}  Grok Build ${GROK_BUILD || "?"}`);
  log("LAN IP", lanIp, "ifaces", listLanCandidates().map((c) => c.addr).join(", "));
  log("HTTP", `http://${lanIp}:${HTTP_PORT}/`);
  log("ACP ", `ws://${lanIp}:${HTTP_PORT}/acp  (leader stdio — live TUI sessions)`);

  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url, `http://${lanIp}:${HTTP_PORT}`);
      if (handleApi(req, res, u, secret, lanIp)) return;
      serveStatic(req, res, u);
    } catch (err) {
      res.writeHead(500).end(String(err.message || err));
    }
  });
  attachAcpProxy(server, { secret, log: (...a) => log("[proxy]", ...a) });

  await new Promise((resolve, reject) => {
    server.listen(HTTP_PORT, BIND_HOST, (err) => (err ? reject(err) : resolve()));
  });
  log(`listening http://${lanIp}:${HTTP_PORT}  (phone: open this URL)`);
  log(`secret stored in ${SECRET_FILE}`);

  await refreshRoster();
  log("disk roster", state.sessions.length, "sessions");
  setInterval(() => refreshRoster().catch((e) => log("roster tick", e.message)), 8000);
  log("sidecar ACP disabled — disk roster + phone /acp only");
  startUacWatch();

  const shutdown = () => {
    log("shutdown");
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      state.sidecar?.close();
    } catch {
      /* ignore */
    }
    try {
      if (state.grok) state.grok.kill();
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 400);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function startedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (startedDirectly()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { handleApi };
