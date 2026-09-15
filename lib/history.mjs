import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function grokHome() {
  return path.join(os.homedir(), ".grok");
}
function sessionRoot() {
  return path.join(grokHome(), "sessions");
}
function readActiveSessionIds() {
  const rows = readJsonFile(path.join(grokHome(), "active_sessions.json"), []);
  const ids = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.session_id) ids.add(String(r.session_id));
  }
  return ids;
}

export function findUpdatesFile(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return null;
  const p = path.join(dir, "updates.jsonl");
  return fs.existsSync(p) ? p : null;
}

export function listDiskSessions() {
  const root = sessionRoot();
  const out = [];
  const live = readActiveSessionIds();
  if (!fs.existsSync(root)) return out;
  for (const cwdEnc of fs.readdirSync(root)) {
    const cwdDir = path.join(root, cwdEnc);
    let st;
    try {
      st = fs.statSync(cwdDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let cwd = cwdEnc;
    try {
      cwd = decodeURIComponent(cwdEnc);
    } catch {
      /* keep encoded */
    }
    let ids = [];
    try {
      ids = fs.readdirSync(cwdDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const dir = path.join(cwdDir, id);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (fs.existsSync(path.join(dir, "STALE.txt"))) continue;
      const summaryFile = path.join(dir, "summary.json");
      const updatesFile = path.join(dir, "updates.jsonl");
      if (!fs.existsSync(summaryFile) && !fs.existsSync(updatesFile)) continue;
      const summary = readJsonFile(summaryFile, {});
      if (String(summary.session_kind || "").toLowerCase() === "subagent") continue;
      const title = String(summary.generated_title || summary.session_summary || "").trim();
      const msgs = Number(summary.num_messages || 0);
      if (!title && msgs < 2) continue;
      const signals = readJsonFile(path.join(dir, "signals.json"), {});
      let mtime = st.mtime;
      try {
        mtime = fs.statSync(fs.existsSync(updatesFile) ? updatesFile : dir).mtime;
      } catch {
        /* keep */
      }
      const resident = live.has(id);
      const ageMs = Date.now() - new Date(mtime).getTime();
      const working = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 12000;
      out.push({
        sessionId: id,
        title: title || "Untitled",
        cwd: summary.info?.cwd || cwd,
        updatedAt: summary.updated_at || summary.last_active_at || mtime.toISOString(),
        activity: working ? "working" : resident ? "live" : "idle",
        resident,
        modelId: summary.current_model_id || signals.primaryModelId || null,
        reasoningEffort: summary.reasoning_effort || null,
        lastTurnSummary: summary.last_turn_summary || summary.session_summary || "",
        origin: "disk",
      });
    }
  }
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out;
}

export function findSessionDir(sessionId) {
  const root = sessionRoot();
  if (!fs.existsSync(root) || !sessionId) return null;
  for (const cwdEnc of fs.readdirSync(root)) {
    const dir = path.join(root, cwdEnc, sessionId);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return null;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeTodo(t) {
  if (!t) return null;
  if (typeof t === "string") return { content: t, status: "pending" };
  const content = t.content || t.title || t.text || t.id || "";
  if (!content) return null;
  return { content, status: t.status || "pending", priority: t.priority || "" };
}

export function todosFromPlan(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.todos)) return plan.todos.map(normalizeTodo).filter(Boolean);
  if (plan.todos && typeof plan.todos === "object") {
    return Object.values(plan.todos).map(normalizeTodo).filter(Boolean);
  }
  if (Array.isArray(plan.entries)) return plan.entries.map(normalizeTodo).filter(Boolean);
  return [];
}

export function buildMeta(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return { ok: false, error: "session not found" };
  const summary = readJsonFile(path.join(dir, "summary.json"), {});
  const signals = readJsonFile(path.join(dir, "signals.json"), {});
  const plan = readJsonFile(path.join(dir, "plan.json"), {});
  const used = Number(signals.contextTokensUsed || 0);
  const win = Number(signals.contextWindowTokens || 0);
  const percent =
    signals.contextWindowUsage != null
      ? Number(signals.contextWindowUsage)
      : win
        ? Math.round((used / win) * 100)
        : null;
  return {
    ok: true,
    sessionId,
    title: summary.generated_title || summary.session_summary || "",
    modelId: summary.current_model_id || signals.primaryModelId || null,
    effort: summary.reasoning_effort || "",
    usage: {
      percent,
      tokensUsed: used,
      windowTokens: win,
      turns: signals.turnCount || 0,
      tools: signals.toolCallCount || 0,
    },
    todos: todosFromPlan(plan),
  };
}

export function readPlanMarkdown(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return { ok: false, error: "session not found" };
  const file = path.join(dir, "plan.md");
  let markdown = "";
  try {
    if (fs.existsSync(file)) markdown = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const trimmed = String(markdown || "").trim();
  return { ok: true, sessionId, file, empty: !trimmed, markdown: trimmed };
}

export function renameSession(sessionId, title) {
  const dir = findSessionDir(sessionId);
  if (!dir) return { ok: false, error: "session not found" };
  const file = path.join(dir, "summary.json");
  const summary = readJsonFile(file, {});
  summary.generated_title = title;
  summary.session_summary = title;
  summary.title_is_manual = true;
  fs.writeFileSync(file, JSON.stringify(summary, null, 2), "utf8");
  return { ok: true, title };
}

export function deleteSessionDir(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return { ok: false, error: "session not found" };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, sessionId };
}

function textOf(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.text) return content.text;
  if (Array.isArray(content)) return content.map(textOf).join("");
  return "";
}

export function isRemotePrompt(text) {
  return /^\[Grok Remote\]\s*/i.test(String(text || ""));
}

export function stripRemotePrefix(text) {
  return String(text || "").replace(/^\[Grok Remote\]\s*/i, "");
}

function tsOf(u) {
  return Number(u?._meta?.agentTimestampMs || 0) || null;
}

function stampWorked(items, endTs) {
  let turnStart = null;
  let lastAgent = null;
  let lastTs = null;
  for (const it of items) {
    if (it.kind === "user") {
      if (lastAgent && turnStart && lastTs) {
        lastAgent.workedMs = Math.max(0, lastTs - turnStart);
      }
      turnStart = null;
      lastAgent = null;
      lastTs = it.at || lastTs;
      continue;
    }
    const ts = it.startedAt || it.at || it.endedAt || null;
    if ((it.kind === "think" || it.kind === "tool" || it.kind === "agent") && !turnStart) {
      turnStart = ts || lastTs;
    }
    if (it.kind === "agent") lastAgent = it;
    if (ts) lastTs = ts;
  }
  const end = endTs || lastTs;
  if (lastAgent && turnStart && end) {
    lastAgent.workedMs = Math.max(0, end - turnStart);
  }
}

function closeThink(items, ts) {
  const last = items[items.length - 1];
  if (!last || last.kind !== "think") return;
  last.live = false;
  if (last.startedAt && ts && ts >= last.startedAt) {
    last.durationMs = ts - last.startedAt;
  }
}

function collectPrompts(items) {
  const list = [];
  for (const it of items) {
    if (it.kind !== "user") continue;
    const text = stripRemotePrefix(it.text).trim();
    if (!text) continue;
    list.push({ text, source: it.source || "pc" });
  }
  const out = [];
  const seen = new Set();
  for (let i = list.length - 1; i >= 0; i--) {
    if (seen.has(list[i].text)) continue;
    seen.add(list[i].text);
    out.push(list[i]);
  }
  return out;
}

export function parseUpdateLine(line) {
  if (!line || !String(line).trim()) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const params = o.params || {};
  const u = params.update || o.update;
  if (!u || typeof u !== "object") return null;
  const meta = { ...(params._meta || {}), ...(u._meta || {}) };
  if (Object.keys(meta).length) u._meta = meta;
  if (params.sessionId && !u.sessionId) u.sessionId = params.sessionId;
  return u;
}

export function buildHistory(sessionId) {
  const file = findUpdatesFile(sessionId);
  if (!file) return { ok: false, error: "session not found", items: [] };
  const items = [];
  const tools = new Map();
  let lastTodos = [];
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\n/)) {
    const u = parseUpdateLine(line);
    if (!u) continue;
    const kind = u.sessionUpdate;
    const ts = tsOf(u);
    if (kind === "user_message_chunk") {
      closeThink(items, ts);
      const raw = textOf(u.content);
      const source = isRemotePrompt(raw) ? "app" : "pc";
      const t = stripRemotePrefix(raw);
      const last = items[items.length - 1];
      if (last && last.kind === "user") {
        last.text += t;
        if (ts) last.at = ts;
      } else items.push({ kind: "user", text: t, source, at: ts });
    } else if (kind === "agent_message_chunk") {
      closeThink(items, ts);
      const t = textOf(u.content);
      const last = items[items.length - 1];
      if (last && last.kind === "agent") {
        last.text += t;
        if (ts) last.at = ts;
      } else items.push({ kind: "agent", text: t, at: ts });
    } else if (kind === "agent_thought_chunk") {
      const t = textOf(u.content);
      const last = items[items.length - 1];
      if (last && last.kind === "think") {
        last.text += t;
        if (ts) last.endedAt = ts;
      } else {
        items.push({ kind: "think", text: t, startedAt: ts, endedAt: ts, live: false });
      }
    } else if (kind === "tool_call") {
      closeThink(items, ts);
      const id = u.toolCallId;
      const card = {
        kind: "tool",
        id,
        title: u.title || u.kind || id,
        toolKind: u.kind || u._meta?.["x.ai/tool"]?.kind || "",
        status: u.status || "running",
      };
      tools.set(id, card);
      items.push(card);
    } else if (kind === "tool_call_update") {
      const card = tools.get(u.toolCallId);
      if (card) {
        if (u.status) card.status = u.status;
        if (u.title) card.title = u.title;
      }
    } else if (kind === "plan") {
      closeThink(items, ts);
      lastTodos = (u.entries || [])
        .map((e) => ({
          content: e.content || e.title || "",
          status: e.status || "pending",
          priority: e.priority || "",
        }))
        .filter((e) => e.content);
      if (lastTodos.length) items.push({ kind: "plan", text: lastTodos.map((e) => e.content).join("\n") });
    }
  }
  closeThink(items, null);
  stampWorked(items, null);
  const prompts = collectPrompts(items);
  return {
    ok: true,
    sessionId,
    file,
    items,
    prompts,
    todos: lastTodos,
    counts: {
      user: items.filter((i) => i.kind === "user").length,
      agent: items.filter((i) => i.kind === "agent").length,
      tool: items.filter((i) => i.kind === "tool").length,
      think: items.filter((i) => i.kind === "think").length,
    },
  };
}
