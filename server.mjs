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
import { AcpClient, extractSessionId } from "./lib/acp.mjs";
import { detectLanIp, isTrustedLanPeer, listLanCandidates, normalizePeerIp } from "./lib/lan.mjs";
import { attachAcpProxy } from "./lib/ws-proxy.mjs";
import { buildHistory, buildMeta, findUpdatesFile, parseUpdateLine, renameSession, deleteSessionDir, readPlanMarkdown, readPlanState, listDiskSessions, appendPromptHistory, listRewindPoints, historyContainsPrompt, searchSessionText } from "./lib/history.mjs";
import { listWorkspace, searchWorkspace } from "./lib/fs-browse.mjs";
import { kickAcpBridge, bridgeHealthy, ACP_BRIDGE_HTTP_PORT, isLocalSystem, liveSessionAlive } from "./lib/leader.mjs";

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
const STARTED_AT = Date.now();

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

function getBridgeUsage(force, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const reqPath = "/usage" + (force ? "?force=1" : "");
    const req = http.get(
      { host: "127.0.0.1", port: ACP_BRIDGE_HTTP_PORT, path: reqPath, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error("usage bad json"));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("usage timeout"));
    });
  });
}

async function loadAccountUsageApi(force) {
  const failOpen = (err) => ({
    ok: false,
    error: String(err?.message || err || "usage unavailable")
      .replace(/Bearer\s+\S+/gi, "Bearer ***")
      .slice(0, 200),
  });
  const localFallback = async () => {
    if (isLocalSystem()) return failOpen("bridge unavailable");
    const authFile = path.join(GROK_HOME, "auth.json");
    try {
      fs.accessSync(authFile, fs.constants.R_OK);
    } catch {
      return failOpen("bridge unavailable");
    }
    const { fetchAccountUsage } = await import("./lib/account-usage.mjs");
    return fetchAccountUsage({ force: true });
  };
  try {
    return await getBridgeUsage(force);
  } catch (err) {
    log("account usage bridge fail", err.code || err.message);
    kickAcpBridge();
    await new Promise((r) => setTimeout(r, 2000));
    try {
      return await getBridgeUsage(force);
    } catch (err2) {
      log("account usage bridge retry fail", err2.code || err2.message);
      try {
        return await localFallback();
      } catch (err3) {
        return failOpen(err3.message || err2.message);
      }
    }
  }
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
  bridgeUp: false,
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
    lastTurnSummaryPromptId: s.lastTurnSummaryPromptId || s.last_turn_summary_prompt_id || "",
    lastCaption: s.lastCaption || "",
    subagents: s.subagents && Number(s.subagents.running) > 0 ? s.subagents : { running: 0, names: [] },
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
            lastCaption: s.lastCaption || prev.lastCaption || "",
          });
        }
      } catch (err) {
        log("acp roster error", err.message);
      }
    }
    const sessions = [...byId.values()];
    sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const prev = new Map(state.sessions.map((s) => [s.sessionId, s]));
    const firstPass = !state.rosterPrimed;
    if (!state.turnPromptId) state.turnPromptId = {};
    state.sessions = sessions;
    state.lastRosterAt = Date.now();
    state.rosterPrimed = true;
    for (const s of sessions) {
      if (headless.has(s.sessionId) && liveSessionAlive(s.sessionId)) closeHeadless(s.sessionId);
      const old = prev.get(s.sessionId);
      const recapId = String(s.lastTurnSummaryPromptId || s.lastTurnSummary || "").trim();
      const prevRecap = state.turnPromptId[s.sessionId] || "";
      if (recapId) state.turnPromptId[s.sessionId] = recapId;
      const key = `${s.sessionId}:${s.activity}`;
      if (firstPass || !old) continue;
      if (isNeedsYouActivity(s.activity) && !isNeedsYouActivity(old.activity)) {
        if (state.lastNotify[key] && Date.now() - state.lastNotify[key] < 20_000) continue;
        state.lastNotify[key] = Date.now();
        broadcast({
          type: "needs_input",
          sessionId: s.sessionId,
          title: s.title,
          activity: s.activity,
          summary: s.lastTurnSummary,
          at: Date.now(),
        });
      }
      const plan = readPlanState(s.sessionId);
      if (!state.planAwait) state.planAwait = {};
      const wasAwaiting = !!state.planAwait[s.sessionId];
      state.planAwait[s.sessionId] = !!plan.awaiting;
      if (!firstPass && plan.awaiting && !wasAwaiting) {
        broadcast({
          type: "plan_ready",
          sessionId: s.sessionId,
          title: s.title,
          summary: plan.hasPlan ? "Review the plan to continue" : "No plan written yet — review to continue",
          at: Date.now(),
        });
      } else if (!firstPass && wasAwaiting && !plan.awaiting) {
        broadcast({
          type: "plan_cleared",
          sessionId: s.sessionId,
          title: s.title,
          at: Date.now(),
        });
      }
      const permOpen = state.permOpen?.has(s.sessionId);
      if (recapId && prevRecap && recapId !== prevRecap && !plan.awaiting && !permOpen) {
        const doneKey = `${s.sessionId}:done`;
        if (state.lastNotify[doneKey] && Date.now() - state.lastNotify[doneKey] < 30_000) continue;
        state.lastNotify[doneKey] = Date.now();
        broadcast({
          type: "turn_complete",
          sessionId: s.sessionId,
          title: s.title,
          activity: s.activity,
          summary: s.lastTurnSummary,
          at: Date.now(),
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

function queueEntryText(e) {
  if (!e || typeof e !== "object") return "";
  if (typeof e.text === "string" && e.text.trim()) return e.text;
  if (typeof e.prompt === "string") return e.prompt;
  const blocks = Array.isArray(e.prompt) ? e.prompt : Array.isArray(e.content) ? e.content : null;
  if (blocks) {
    return blocks.map((p) => (typeof p === "string" ? p : p?.text || p?.content || "")).join("");
  }
  return String(e.caption || e.message || "");
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
      const text = queueEntryText(e);
      const id = String(e.id || e.entryId || e.entry_id || e.promptId || e.prompt_id || i);
      const index = e.position != null ? Number(e.position) : e.index != null ? Number(e.index) : i;
      return {
        id,
        text,
        source: /app|remote/i.test(String(e.source || "")) ? "app" : "pc",
        index,
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
const headless = new Map();
const headlessOpen = new Map();

function sessionCwd(sessionId) {
  const row = state.sessions.find((s) => s.sessionId === sessionId);
  const cwd = row?.cwd && String(row.cwd).trim();
  return cwd || DEFAULT_CWD;
}

function closeHeadless(sessionId) {
  const slot = headless.get(sessionId);
  if (!slot) return;
  headless.delete(sessionId);
  if (slot.idle) clearTimeout(slot.idle);
  const err = new Error("headless closed");
  const perm = slot.pendingPerm;
  const plan = slot.pendingPlan;
  slot.pendingPerm = null;
  slot.pendingPlan = null;
  try { perm?.reject(err); } catch { /* ignore */ }
  try { plan?.reject(err); } catch { /* ignore */ }
  try { slot.client?.close(); } catch { /* ignore */ }
}

function scheduleHeadlessIdle(sessionId) {
  const slot = headless.get(sessionId);
  if (!slot) return;
  if (slot.idle) clearTimeout(slot.idle);
  slot.idle = setTimeout(() => {
    const cur = headless.get(sessionId);
    if (!cur || cur.pendingPerm || cur.pendingPlan) return;
    log("headless idle", sessionId.slice(0, 8));
    closeHeadless(sessionId);
  }, 10 * 60 * 1000);
}

function headlessOptionId(key, options, kind) {
  const list = Array.isArray(options) ? options : [];
  const idOf = (o) => String(o?.optionId || o?.id || "");
  const find = (re) => {
    const hit = list.find((o) => re.test(idOf(o)));
    return hit ? hit.optionId || hit.id : "";
  };
  if (key === "1") return find(/allow_always/i) || "allow_always";
  if (key === "2") {
    if (kind === "command") return find(/allow_bash|bash/i) || find(/allow_edits|edits/i) || "allow_bash";
    return find(/allow_edits|edits/i) || find(/allow_bash|bash/i) || "allow_edits_for_session";
  }
  if (key === "3") return find(/allow_once/i) || "allow_once";
  return find(/reject_once/i) || find(/reject|deny/i) || "reject_once";
}

function isHeadlessPlan(method, params) {
  if (/exit_plan_mode/i.test(method || "")) return true;
  const tool = params?.toolCall || {};
  const name = [tool.title, tool.kind, tool.name, params?.title].filter(Boolean).join(" ");
  return /exit[_\s-]*plan|exit_plan/i.test(name);
}

function armPermCard(sessionId, params) {
  const tool = params?.toolCall || {};
  const toolCallId = String(tool.toolCallId || params?.toolCallId || ("perm-" + Date.now()));
  const input = tool.rawInput || {};
  const pathName = String(input.path || input.file_path || input.target_file || "").trim();
  const command = String(input.command || input.cmd || "").trim();
  const kind = command || /bash|shell|terminal|command/i.test(String(tool.title || tool.kind || "")) ? "command" : "edit";
  if (!state.permWait) state.permWait = new Map();
  if (state.permWait.has(toolCallId)) {
    clearTimeout(state.permWait.get(toolCallId));
    state.permWait.delete(toolCallId);
  }
  if (!state.permSent) state.permSent = new Set();
  state.permSent.add(toolCallId);
  if (!state.permOpen) state.permOpen = new Set();
  state.permOpen.add(sessionId);
  const row = state.sessions.find((s) => s.sessionId === sessionId);
  broadcast({
    type: "perm_wait",
    sessionId,
    toolCallId,
    kind,
    title: tool.title || (kind === "command" ? "Command" : "Edit"),
    path: pathName,
    command: command.slice(0, 240),
    sessionTitle: row?.title || "",
    at: Date.now(),
  });
  return { toolCallId, kind };
}

function finishPermCard(sessionId, toolCallId) {
  if (toolCallId && state.permWait?.has(toolCallId)) {
    clearTimeout(state.permWait.get(toolCallId));
    state.permWait.delete(toolCallId);
  }
  if (toolCallId) state.permSent?.delete(toolCallId);
  state.permOpen?.delete(sessionId);
  if (toolCallId) broadcast({ type: "perm_clear", sessionId, toolCallId, at: Date.now() });
}

function holdHeadlessPerm(sessionId, params) {
  const slot = headless.get(sessionId);
  if (!slot) return Promise.reject(new Error("no headless session"));
  const card = armPermCard(sessionId, params);
  return new Promise((resolve, reject) => {
    slot.pendingPerm = { resolve, reject, params, toolCallId: card.toolCallId, kind: card.kind };
  });
}

function answerHeadlessPerm(sessionId, key, feedback) {
  const slot = headless.get(sessionId);
  const pending = slot?.pendingPerm;
  if (!pending) return false;
  slot.pendingPerm = null;
  const optionId = headlessOptionId(key, pending.params?.options, pending.kind);
  const outcome = { outcome: "selected", optionId };
  if (key === "4" && feedback) outcome._meta = { feedback, reject_reason: feedback };
  finishPermCard(sessionId, pending.toolCallId);
  pending.resolve({ outcome });
  return true;
}

function holdHeadlessPlan(sessionId, params) {
  const slot = headless.get(sessionId);
  if (!slot) return Promise.reject(new Error("no headless session"));
  const row = state.sessions.find((s) => s.sessionId === sessionId);
  broadcast({
    type: "plan_ready",
    sessionId,
    title: row?.title || "",
    summary: "Review the plan to continue",
    at: Date.now(),
  });
  return new Promise((resolve, reject) => {
    slot.pendingPlan = {
      resolve,
      reject,
      params,
      permission: !!(params?.toolCall || (Array.isArray(params?.options) && params.options.length)),
    };
  });
}

function answerHeadlessPlan(sessionId, action) {
  const slot = headless.get(sessionId);
  const pending = slot?.pendingPlan;
  if (!pending) return false;
  slot.pendingPlan = null;
  const options = pending.params?.options || [];
  if (pending.permission) {
    const optionId = action === "approve"
      ? headlessOptionId("3", options, "edit")
      : headlessOptionId("4", options, "edit");
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }
  const outcome = action === "approve" ? "approved" : action === "quit" ? "abandoned" : "rejected";
  pending.resolve({ outcome, feedback: "" });
  return true;
}

function wireHeadlessClient(client, sessionId) {
  client.onNotification = (msg) => {
    const method = String(msg.method || "");
    if (/queue\/changed/i.test(method)) {
      applyQueueNotification(msg.params);
      return;
    }
    if (method === "session/update" || method === "_x.ai/session/update" || method === "x.ai/session/update") {
      const sid = msg.params?.sessionId || sessionId;
      const update = msg.params?.update || msg.params;
      if (!update) return;
      noteLivePerm(sid, update);
      const eventId = msg.params?._meta?.eventId || update._meta?.eventId || "";
      broadcast({ type: "update", sessionId: sid, eventId, update, at: Date.now() });
    }
  };
  client.onAgentRequest = async (method, params) => {
    if (isHeadlessPlan(method, params)) return holdHeadlessPlan(sessionId, params || {});
    if (method === "session/request_permission") return holdHeadlessPerm(sessionId, params || {});
    return undefined;
  };
  client.onClose = () => {
    const cur = headless.get(sessionId);
    if (cur?.client !== client) return;
    headless.delete(sessionId);
    if (cur.idle) clearTimeout(cur.idle);
    const err = new Error("headless closed");
    const perm = cur.pendingPerm;
    const plan = cur.pendingPlan;
    cur.pendingPerm = null;
    cur.pendingPlan = null;
    try { perm?.reject(err); } catch { /* ignore */ }
    try { plan?.reject(err); } catch { /* ignore */ }
  };
}

async function openHeadless(sessionId) {
  if (liveSessionAlive(sessionId)) throw new Error("session is open on the PC");
  const prev = headless.get(sessionId);
  if (prev) closeHeadless(sessionId);
  if (!(await bridgeHealthy())) {
    kickAcpBridge();
    await new Promise((r) => setTimeout(r, 600));
  }
  const url = `ws://127.0.0.1:${HTTP_PORT}/acp?server-key=${encodeURIComponent(state.secret)}`;
  const client = new AcpClient(url, { log: (...a) => log("[headless]", sessionId.slice(0, 8), ...a) });
  const slot = { client, cwd: sessionCwd(sessionId), pendingPerm: null, pendingPlan: null, idle: null };
  headless.set(sessionId, slot);
  wireHeadlessClient(client, sessionId);
  try {
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
    try {
      await client.request(
        "authenticate",
        { methodId: "cached_token", _meta: { headless: true } },
        { timeoutMs: 15000 }
      );
    } catch (err) {
      log("headless auth", sessionId.slice(0, 8), err.message);
    }
    if (liveSessionAlive(sessionId)) throw new Error("session is open on the PC");
    const resumed = await client.request(
      "session/resume",
      { sessionId, cwd: slot.cwd, mcpServers: [] },
      { timeoutMs: 20000 }
    );
    const id = extractSessionId(resumed, sessionId);
    if (id && id !== sessionId) throw new Error("resume returned a different session");
    if (liveSessionAlive(sessionId)) throw new Error("session is open on the PC");
    client.sessionId = sessionId;
    if (headless.get(sessionId)?.client !== client) throw new Error("session is open on the PC");
    log("headless resume", sessionId.slice(0, 8));
    return slot;
  } catch (err) {
    if (headless.get(sessionId)?.client === client) closeHeadless(sessionId);
    throw err;
  }
}

async function ensureHeadless(sessionId) {
  const existing = headless.get(sessionId);
  if (existing?.client?.ready) {
    if (existing.idle) {
      clearTimeout(existing.idle);
      existing.idle = null;
    }
    return existing;
  }
  const inflight = headlessOpen.get(sessionId);
  if (inflight) return inflight;
  const job = openHeadless(sessionId).finally(() => {
    if (headlessOpen.get(sessionId) === job) headlessOpen.delete(sessionId);
  });
  headlessOpen.set(sessionId, job);
  return job;
}

async function resumeGatewaySession(sessionId) {
  const owned = headless.get(sessionId);
  if (owned?.client?.ready && !liveSessionAlive(sessionId)) return owned.client;
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

function promptWasQueued(text) {
  if (!text) return false;
  const needle = String(text).slice(0, 80);
  for (const entries of Object.values(state.pcQueue || {})) {
    if (!Array.isArray(entries)) continue;
    if (entries.some((e) => String(e.text || "").includes(needle))) return true;
  }
  return false;
}

async function waitPromptLanded(sessionId, text, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (promptWasQueued(text) || (text && historyContainsPrompt(sessionId, text))) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return promptWasQueued(text) || (text ? historyContainsPrompt(sessionId, text) : false);
}

function injectViaBridge(sessionId, text, submit = true) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sessionId, text, submit });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: ACP_BRIDGE_HTTP_PORT,
        path: "/inject",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let j = {};
          try {
            j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            /* ignore */
          }
          if (res.statusCode === 200 && j.ok !== false) resolve(j);
          else reject(new Error(j.error || "inject HTTP " + res.statusCode));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("inject timeout"));
    });
    req.end(body);
  });
}

function permToolKind(update) {
  const label = [update?.title, update?.kind, update?._meta?.["x.ai/tool"]?.name, update?._meta?.["x.ai/tool"]?.kind]
    .filter(Boolean)
    .join(" ");
  if (/run_terminal|bash|shell|execute/i.test(label)) return "command";
  if (/search_replace|edit|write/i.test(label) && !/read_file|grep/i.test(label)) return "edit";
  return "";
}

function noteLivePerm(sessionId, update) {
  if (!update) return;
  if (!state.permWait) state.permWait = new Map();
  if (!state.permSent) state.permSent = new Set();
  if (update.sessionUpdate === "tool_call" && permToolKind(update)) {
    const id = update.toolCallId;
    if (!id || state.permWait.has(id) || state.permSent.has(id)) return;
    const kind = permToolKind(update);
    const input = update.rawInput || {};
    const path = String(input.path || input.file_path || input.target_file || "").trim();
    const command = String(input.command || input.cmd || "").trim();
    const timer = setTimeout(() => {
      state.permWait.delete(id);
      state.permSent.add(id);
      if (!state.permOpen) state.permOpen = new Set();
      state.permOpen.add(sessionId);
      const row = state.sessions.find((s) => s.sessionId === sessionId);
      broadcast({
        type: "perm_wait",
        sessionId,
        toolCallId: id,
        kind,
        title: update.title || (kind === "command" ? "Command" : "Edit"),
        path,
        command: command.slice(0, 240),
        sessionTitle: row?.title || "",
        at: Date.now(),
      });
    }, 700);
    state.permWait.set(id, timer);
    return;
  }
  if (update.sessionUpdate === "tool_call_update" && update.toolCallId) {
    const id = update.toolCallId;
    const timer = state.permWait.get(id);
    if (timer) {
      clearTimeout(timer);
      state.permWait.delete(id);
    }
    if (state.permSent.has(id)) {
      if (headless.get(sessionId)?.pendingPerm?.toolCallId === id) return;
      state.permSent.delete(id);
      state.permOpen?.delete(sessionId);
      broadcast({ type: "perm_clear", sessionId, toolCallId: id, at: Date.now() });
    }
  }
}

async function deliverByInject(sessionId, text, pid) {
  closeHeadless(sessionId);
  await injectViaBridge(sessionId, text);
  const landed = await waitPromptLanded(sessionId, text, 8000);
  const queued = promptWasQueued(text) || !landed;
  log("prompt inject", sessionId.slice(0, 8), "pid", pid, queued ? "queued" : landed ? "history" : "typed");
  return { ok: true, accepted: true, landed: !!(landed || queued), queued, via: "inject", pid };
}

async function deliverLivePrompt(sessionId, prompt, text) {
  const pid = liveSessionAlive(sessionId);
  if (pid) {
    try {
      return await deliverByInject(sessionId, text, pid);
    } catch (err) {
      if (liveSessionAlive(sessionId)) throw err;
      log("inject stale", sessionId.slice(0, 8), err.message);
    }
  }
  let last = new Error("deliver failed");
  for (let i = 0; i < 4; i++) {
    const now = liveSessionAlive(sessionId);
    if (now) {
      try {
        return await deliverByInject(sessionId, text, now);
      } catch (err) {
        if (liveSessionAlive(sessionId)) throw err;
        log("inject stale", sessionId.slice(0, 8), err.message);
      }
    }
    try {
      if (!(await bridgeHealthy())) kickAcpBridge();
      const slot = await ensureHeadless(sessionId);
      const taken = liveSessionAlive(sessionId);
      if (taken) return await deliverByInject(sessionId, text, taken);
      let failed = null;
      const turn = slot.client.request("session/prompt", { sessionId, prompt }, { timeoutMs: 300000 });
      turn.then(
        () => scheduleHeadlessIdle(sessionId),
        () => scheduleHeadlessIdle(sessionId)
      );
      turn.catch((err) => {
        failed = err;
        log("prompt turn", sessionId.slice(0, 8), err.message);
      });
      const landed = await waitPromptLanded(sessionId, text, 8000);
      if (failed && !landed) throw failed;
      const queued = promptWasQueued(text);
      log("prompt headless", sessionId.slice(0, 8), queued ? "queued" : landed ? "history" : "accepted");
      return { ok: true, accepted: true, landed: !!(landed || queued), queued, via: "headless" };
    } catch (err) {
      last = err;
      log("deliver retry", i + 1, err.message);
      closeHeadless(sessionId);
      kickAcpBridge();
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}

async function openGatewayAcp() {
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
      return;
    }
    if (method === "session/update" || method === "_x.ai/session/update" || method === "x.ai/session/update") {
      const sid = msg.params?.sessionId || state.gatewayAcpSession;
      const update = msg.params?.update || msg.params;
      if (!update) return;
      const eventId = msg.params?._meta?.eventId || update._meta?.eventId || "";
      broadcast({ type: "update", sessionId: sid, eventId, update, at: Date.now() });
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
  try {
    await client.request(
      "authenticate",
      { methodId: "cached_token", _meta: { headless: true } },
      { timeoutMs: 15000 }
    );
  } catch (err) {
    log("acp auth", err.message);
  }
  state.gatewayAcp = client;
  return client;
}

async function ensureGatewayAcp() {
  if (state.gatewayAcp?.ready) return state.gatewayAcp;
  let last = new Error("acp connect failed");
  for (let i = 0; i < 4; i++) {
    try {
      return await openGatewayAcp();
    } catch (err) {
      last = err;
      log("acp retry", i + 1, err.message);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
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
      acpReady: !!state.gatewayAcp?.ready || !!state.sidecar?.ready,
      headless: headless.size,
      bridgeUp: !!state.bridgeUp,
      sessions: state.sessions.length,
      cwd: DEFAULT_CWD,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      startedAt: new Date(STARTED_AT).toISOString(),
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

  if (u.pathname === "/api/account/usage" && req.method === "GET") {
    const force = u.searchParams.get("force") === "1" || u.searchParams.get("force") === "true";
    loadAccountUsageApi(force)
      .then((snap) => {
        sendJson(res, snap?.ok ? 200 : 502, snap || { ok: false, error: "usage unavailable" });
      })
      .catch((err) => {
        sendJson(res, 502, { ok: false, error: String(err?.message || err).slice(0, 200) });
      });
    return true;
  }

  if ((u.pathname === "/api/admin/restart" || u.pathname === "/api/restart") && req.method === "POST") {
    log("admin restart");
    sendJson(res, 200, { ok: true, restarting: true, pid: process.pid, version: PKG.version });
    setTimeout(() => process.exit(0), 250);
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

  if (u.pathname === "/api/search" && req.method === "GET") {
    const q = u.searchParams.get("q") || "";
    sendJson(res, 200, { ok: true, hits: searchSessionText(q) });
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
          const result = await deliverLivePrompt(sessionId, prompt, outbound);
          const row = state.sessions.find((s) => s.sessionId === sessionId);
          broadcast({
            type: result.queued ? "prompt_queued" : "prompt_landed",
            sessionId,
            title: row?.title || "",
            summary: outbound.slice(0, 140),
            at: Date.now(),
          });
          sendJson(res, result.landed ? 200 : 202, result);
        })
        .catch((err) => {
          log("prompt failed", err.message);
          try {
            state.gatewayAcp?.close();
          } catch {
            /* ignore */
          }
          state.gatewayAcp = null;
          state.gatewayAcpSession = "";
          if (!res.writableEnded) sendJson(res, 500, { ok: false, error: err.message });
        });
      return true;
    }
  }

  {
    const qm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/queue$/);
    if (qm && req.method === "GET") {
      const sessionId = decodeURIComponent(qm[1]);
      sendJson(res, 200, { ok: true, entries: state.pcQueue[sessionId] || [] });
      return true;
    }
    if (qm && req.method === "POST") {
      const sessionId = decodeURIComponent(qm[1]);
      readBody(req)
        .then(async (body) => {
          const action = String(body.action || "").toLowerCase();
          const acp = state.queueWatch?.ready ? state.queueWatch : await resumeGatewaySession(sessionId);
          const id = body.id != null ? String(body.id) : "";
          const index = body.index != null ? Number(body.index) : undefined;
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const fromIndex = body.fromIndex != null ? Number(body.fromIndex) : index;
          const toIndex = body.toIndex != null ? Number(body.toIndex) : undefined;
          const withSession = (extra) => ({ sessionId, ...extra });
          const payloads =
            action === "clear"
              ? [withSession({}), {}]
              : action === "reorder"
                ? [
                    withSession({ fromIndex, toIndex }),
                    { fromIndex, toIndex },
                    { from_index: fromIndex, to_index: toIndex },
                    { ids },
                    { order: ids },
                    { id, fromIndex, toIndex },
                  ]
              : action === "interject" || action === "start"
                ? [withSession({ id }), { id }, { entryId: id }, { index }]
                : action === "edit" || action === "hold"
                  ? [withSession({ id }), { id }, { entryId: id }, { index }]
                  : action === "remove" || action === "cancel"
                    ? [withSession({ id }), { id }, { entryId: id }, { index }]
                    : null;
          if (!payloads) {
            sendJson(res, 400, { ok: false, error: "action must be cancel, start, edit, clear, or reorder" });
            return;
          }
          const method =
            action === "clear"
              ? "x.ai/queue/clear"
              : action === "reorder"
                ? "x.ai/queue/reorder"
              : action === "interject" || action === "start"
                ? "x.ai/queue/interject"
              : action === "edit" || action === "hold"
                ? "x.ai/queue/hold_edit"
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
          const key = action === "approve" ? "a" : action === "quit" ? "q" : action === "revise" ? "s" : "";
          if (!key) {
            sendJson(res, 400, { ok: false, error: "action must be approve, revise, or quit" });
            return;
          }
          if (liveSessionAlive(sessionId)) {
            await injectViaBridge(sessionId, key, false);
            sendJson(res, 200, { ok: true, action, sent: key });
            return;
          }
          if (answerHeadlessPlan(sessionId, action)) {
            sendJson(res, 200, { ok: true, action, via: "headless" });
            return;
          }
          sendJson(res, 503, { ok: false, error: "no live PC window for this session" });
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
      return true;
    }
  }

  {
    const prm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/perm-action$/);
    if (prm && req.method === "POST") {
      const sessionId = decodeURIComponent(prm[1]);
      readBody(req)
        .then(async (body) => {
          const key = String(body.key || "").trim();
          if (!/^[1-4]$/.test(key)) {
            sendJson(res, 400, { ok: false, error: "key must be 1-4" });
            return;
          }
          if (!liveSessionAlive(sessionId)) {
            const feedback = String(body.feedback || "").trim();
            if (answerHeadlessPerm(sessionId, key, feedback)) {
              sendJson(res, 200, { ok: true, key, via: "headless" });
              return;
            }
            sendJson(res, 503, { ok: false, error: "no live PC window for this session" });
            return;
          }
          await injectViaBridge(sessionId, key, false);
          const feedback = String(body.feedback || "").trim();
          if (feedback && key === "4") {
            await new Promise((r) => setTimeout(r, 350));
            await injectViaBridge(sessionId, feedback, true);
          }
          sendJson(res, 200, { ok: true, key });
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
          if (body.auto) {
            sendJson(res, 200, renameSession(sessionId, "", { auto: true }));
            return;
          }
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
      sendJson(res, 200, buildHistory(decodeURIComponent(hm[1]), { maxAgeMs: 7 * 24 * 60 * 60 * 1000 }));
      return true;
    }
  }

  {
    const rm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/rewind$/);
    if (rm && req.method === "GET") {
      sendJson(res, 200, listRewindPoints(decodeURIComponent(rm[1])));
      return true;
    }
    if (rm && req.method === "POST") {
      const sessionId = decodeURIComponent(rm[1]);
      readBody(req)
        .then(async (body) => {
          const promptIndex = Number(body.promptIndex);
          if (!Number.isFinite(promptIndex)) {
            sendJson(res, 400, { ok: false, error: "promptIndex required" });
            return;
          }
          const acp = await resumeGatewaySession(sessionId);
          let result;
          try {
            result = await acp.request(
              "x.ai/rewind/execute",
              { sessionId, target_index: promptIndex },
              { timeoutMs: 30000 }
            );
          } catch (err) {
            result = await acp.request(
              "x.ai/rewind/execute",
              { sessionId, prompt_index: promptIndex },
              { timeoutMs: 30000 }
            ).catch(() => {
              throw err;
            });
          }
          sendJson(res, 200, { ok: true, result });
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
      return true;
    }
  }

  {
    const km = u.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
    if (km && req.method === "POST") {
      const sessionId = decodeURIComponent(km[1]);
      readBody(req)
        .then(async () => {
          const acp = await resumeGatewaySession(sessionId);
          try {
            acp.notify("session/cancel", { sessionId });
          } catch {
            await acp.request("session/cancel", { sessionId }, { timeoutMs: 8000 }).catch(() => {});
          }
          sendJson(res, 200, { ok: true });
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
      return true;
    }
  }

  {
    const fm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/fork$/);
    if (fm && req.method === "POST") {
      const sessionId = decodeURIComponent(fm[1]);
      readBody(req)
        .then(async () => {
          const acp = await resumeGatewaySession(sessionId);
          const result = await acp.request("x.ai/session/fork", { sessionId }, { timeoutMs: 30000 });
          const newId =
            extractSessionId(result) ||
            result?.newSessionId ||
            result?.session?.sessionId ||
            null;
          refreshRoster();
          sendJson(res, 200, { ok: true, sessionId: newId, result });
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
      return true;
    }
  }

  {
    const cm = u.pathname.match(/^\/api\/sessions\/([^/]+)\/compact$/);
    if (cm && req.method === "POST") {
      const sessionId = decodeURIComponent(cm[1]);
      readBody(req)
        .then(async (body) => {
          const note = String(body.note || body.context || "").trim();
          const acp = await resumeGatewaySession(sessionId);
          const cmd = note ? "/compact " + note : "/compact";
          const turn = acp.request(
            "session/prompt",
            { sessionId, prompt: [{ type: "text", text: cmd }] },
            { timeoutMs: 180000 }
          );
          sendJson(res, 200, { ok: true, accepted: true });
          turn.catch((err) => log("compact", err.message));
        })
        .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
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
              noteLivePerm(sessionId, update);
              const label = [update.title, update.kind, update._meta?.["x.ai/tool"]?.name].filter(Boolean).join(" ");
              if (update.sessionUpdate === "tool_call" && /exit[_\s-]*plan/i.test(label)) {
                if (!state.planLiveAt) state.planLiveAt = {};
                const prev = state.planLiveAt[sessionId] || 0;
                if (Date.now() - prev > 15000) {
                  state.planLiveAt[sessionId] = Date.now();
                  const row = state.sessions.find((s) => s.sessionId === sessionId);
                  broadcast({
                    type: "plan_ready",
                    sessionId,
                    title: row?.title || "",
                    summary: "Review the plan to continue",
                    at: Date.now(),
                  });
                }
              }
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
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Pragma: "no-cache",
    });
    res.end(fs.readFileSync(fallback));
    return;
  }
  const headers = { "Content-Type": mime(file) };
  if (/\.(html|js|css|webmanifest)$/i.test(file)) {
    headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
    headers.Pragma = "no-cache";
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

async function startQueueWatch() {
  if (state.queueWatch?.ready || state._queueWatchStarting) return;
  state._queueWatchStarting = true;
  const url = `ws://127.0.0.1:${HTTP_PORT}/acp?server-key=${encodeURIComponent(state.secret)}`;
  const client = new AcpClient(url, { log: (...a) => log("[queue]", ...a) });
  client.onNotification = (msg) => {
    const method = String(msg.method || "");
    if (!/queue\/changed/i.test(method)) return;
    log("queue/changed", JSON.stringify(msg.params || {}).slice(0, 400));
    applyQueueNotification(msg.params);
  };
  client.onClose = () => {
    if (state.queueWatch === client) state.queueWatch = null;
    setTimeout(() => {
      startQueueWatch().catch((err) => log("queue watch", err.message));
    }, 4000);
  };
  try {
    await client.connect();
    await client.handshake({ createSession: false });
    state.queueWatch = client;
    log("queue watch ready");
  } catch (err) {
    log("queue watch", err.message);
    try { client.close(); } catch { /* ignore */ }
    setTimeout(() => {
      startQueueWatch().catch((e) => log("queue watch", e.message));
    }, 8000);
  } finally {
    state._queueWatchStarting = false;
  }
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
      try {
        res.writeHead(500).end(String(err.message || err));
      } catch {
        /* headers already sent */
      }
    }
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0;
  attachAcpProxy(server, { secret, log: (...a) => log("[proxy]", ...a) });

  await new Promise((resolve, reject) => {
    let tries = 0;
    const onErr = (err) => {
      if (err.code === "EADDRINUSE" && tries < 20) {
        tries += 1;
        log("port busy, retry", tries);
        setTimeout(() => server.listen(HTTP_PORT, BIND_HOST), 1500);
        return;
      }
      reject(err);
    };
    server.on("error", onErr);
    server.listen(HTTP_PORT, BIND_HOST, () => {
      server.removeListener("error", onErr);
      server.on("error", (e) => log("http", e.message));
      resolve();
    });
  });
  log(`listening http://${lanIp}:${HTTP_PORT}  (phone: open this URL)`);
  log(`secret stored in ${SECRET_FILE}`);

  await refreshRoster();
  log("disk roster", state.sessions.length, "sessions");
  setInterval(() => refreshRoster().catch((e) => log("roster tick", e.message)), 2000);
  log("sidecar ACP disabled — disk roster + phone /acp only");
  startQueueWatch();
  startUacWatch();
  const tickBridge = async () => {
    const up = await bridgeHealthy();
    if (up !== state.bridgeUp) log("bridge", up ? "up" : "down");
    state.bridgeUp = up;
    if (!up) kickAcpBridge();
  };
  void tickBridge();
  setInterval(() => tickBridge().catch((e) => log("bridge tick", e.message)), 5000);

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
  process.on("uncaughtException", (err) => log("uncaught", err.message || err));
  process.on("unhandledRejection", (err) => log("unhandled", err?.message || err));
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
