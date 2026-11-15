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

const searchBlobs = new Map();

function sessionSearchText(sessionId) {
  const file = findUpdatesFile(sessionId);
  if (!file) return "";
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return "";
  }
  let slot = searchBlobs.get(sessionId);
  if (slot && slot.size === st.size && slot.mtime === st.mtimeMs) return slot.text;
  if (!slot || st.size < slot.size) {
    const len = Math.min(st.size, 180000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    } finally {
      fs.closeSync(fd);
    }
    slot = { size: st.size, mtime: st.mtimeMs, text: buf.toString("utf8") };
    searchBlobs.set(sessionId, slot);
    return slot.text;
  }
  const len = st.size - slot.size;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, len, slot.size);
  } finally {
    fs.closeSync(fd);
  }
  slot.text += buf.toString("utf8");
  if (slot.text.length > 180000) slot.text = slot.text.slice(-180000);
  slot.size = st.size;
  slot.mtime = st.mtimeMs;
  return slot.text;
}

export function searchSessionText(query) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const s of listDiskSessions().slice(0, 40)) {
    const text = sessionSearchText(s.sessionId);
    if (!text) continue;
    const at = text.toLowerCase().lastIndexOf(q);
    if (at < 0) continue;
    let snippet = text.slice(Math.max(0, at - 48), at + q.length + 72);
    snippet = snippet.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    if (snippet.length > 140) snippet = snippet.slice(0, 140);
    hits.push({ sessionId: s.sessionId, title: s.title || "Untitled", snippet });
    if (hits.length >= 20) break;
  }
  return hits;
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
        effort: summary.reasoning_effort || "",
        planMode: String(readJsonFile(path.join(dir, "plan_mode.json"), {}).state || "").toLowerCase() === "active" ? "plan" : "",
        reasoningEffort: summary.reasoning_effort || null,
        lastTurnSummary: summary.last_turn_summary || summary.session_summary || "",
        lastTurnSummaryPromptId: summary.last_turn_summary_prompt_id || "",
        lastCaption: fs.existsSync(updatesFile) ? latestAgentCaption(updatesFile) : "",
        subagents: readSubagents(id),
        origin: "disk",
      });
    }
  }
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out;
}

const subSlots = new Map();

function applySubLine(map, line) {
  if (!line.includes("subagent_")) return;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  const u = row.params?.update || row.update || row;
  const id = u.child_session_id || u.subagent_id;
  if (!id) return;
  if (u.sessionUpdate === "subagent_spawned") {
    map.set(id, String(u.description || "Subagent").slice(0, 80));
  } else if (u.sessionUpdate === "subagent_finished") {
    map.delete(id);
  }
}

function summarizeSubs(map) {
  const names = [...map.values()].slice(0, 3);
  return { running: map.size, names };
}

function readSubagents(sessionId) {
  const file = findUpdatesFile(sessionId);
  if (!file) return { running: 0, names: [] };
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { running: 0, names: [] };
  }
  let slot = subSlots.get(sessionId);
  if (!slot) {
    slot = { map: new Map(), pos: null, leftover: "" };
    subSlots.set(sessionId, slot);
  }
  if (slot.pos != null && slot.size === st.size && slot.mtime === st.mtimeMs) {
    return summarizeSubs(slot.map);
  }
  if (slot.pos == null) {
    const idleMs = Date.now() - st.mtimeMs;
    slot.map = new Map();
    slot.leftover = "";
    slot.pos = idleMs > 60 * 60 * 1000 ? st.size : 0;
  }
  if (st.size < slot.pos) {
    slot.map = new Map();
    slot.pos = 0;
    slot.leftover = "";
  }
  const len = st.size - slot.pos;
  if (len > 0) {
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, len, slot.pos);
    } finally {
      fs.closeSync(fd);
    }
    slot.pos = st.size;
    const parts = ((slot.leftover || "") + buf.toString("utf8")).split("\n");
    slot.leftover = parts.pop() || "";
    for (const line of parts) applySubLine(slot.map, line);
  }
  slot.size = st.size;
  slot.mtime = st.mtimeMs;
  return summarizeSubs(slot.map);
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

function estimateTokens(text) {
  const n = String(text || "").length;
  if (!n) return 0;
  return Math.max(1, Math.round(n / 4));
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function contextSplit(dir, used, win) {
  const system = estimateTokens(readText(path.join(dir, "system_prompt.txt")));
  const tools = estimateTokens(readText(path.join(dir, "tool_definitions.json")));
  const free = win > used ? win - used : 0;
  const known = system + tools;
  if (!(used > 0) || !(win > 0) || known <= 0 || known >= used) {
    return { system: null, tools: null, messages: null, free, estimated: false };
  }
  return {
    system,
    tools,
    messages: used - known,
    free,
    estimated: true,
  };
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
      userTurns: signals.userMessageCount || 0,
      compactions: signals.compactionCount || 0,
      errors: signals.errorCount || 0,
      durationSec: signals.sessionDurationSeconds || 0,
      models: signals.modelsUsed || [],
      toolsUsed: Array.isArray(signals.toolsUsed) ? signals.toolsUsed.slice(0, 16) : [],
      context: contextSplit(dir, used, win),
    },
    plan: readPlanState(sessionId),
    todos: todosFromPlan(plan),
  };
}

export function readPlanState(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return { state: "Inactive", awaiting: false, hasPlan: false };
  const pm = readJsonFile(path.join(dir, "plan_mode.json"), {});
  let hasPlan = false;
  try {
    const file = path.join(dir, "plan.md");
    hasPlan = fs.existsSync(file) && fs.statSync(file).size > 0;
  } catch {
    hasPlan = false;
  }
  return {
    state: String(pm.state || "Inactive"),
    awaiting: !!pm.awaiting_plan_approval,
    hasPlan,
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

export function renameSession(sessionId, title, { auto = false } = {}) {
  const dir = findSessionDir(sessionId);
  if (!dir) return { ok: false, error: "session not found" };
  const file = path.join(dir, "summary.json");
  const summary = readJsonFile(file, {});
  if (auto) {
    summary.title_is_manual = false;
    fs.writeFileSync(file, JSON.stringify(summary, null, 2), "utf8");
    return { ok: true, auto: true, title: summary.generated_title || summary.session_summary || "" };
  }
  const t = String(title || "").trim();
  if (!t) return { ok: false, error: "title required" };
  summary.generated_title = t;
  summary.session_summary = t;
  summary.title_is_manual = true;
  fs.writeFileSync(file, JSON.stringify(summary, null, 2), "utf8");
  return { ok: true, title: t };
}

export function deleteSessionDir(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return { ok: false, error: "session not found" };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, sessionId };
}

function imagesOf(content, out) {
  if (!content || out.length >= 4) return;
  if (Array.isArray(content)) {
    content.forEach((part) => imagesOf(part, out));
    return;
  }
  if (typeof content !== "object") return;
  const type = String(content.type || "");
  const mime = content.mimeType || content.mime || content.source?.media_type || "image/jpeg";
  const data = content.data || content.base64 || content.source?.data || "";
  if ((type === "image" || content.source?.type === "base64") && data) {
    const raw = String(data).replace(/^data:[^,]*,/, "");
    if (raw.length > 80 && raw.length < 1500000) out.push(`data:${mime};base64,${raw}`);
  }
}
function textOf(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.text) return content.text;
  if (Array.isArray(content)) return content.map(textOf).join("");
  return "";
}

const captionSlots = new Map();

function cleanCaption(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function captionFromUpdateText(raw) {
  let current = "";
  let last = "";
  let inAgent = false;
  for (const line of String(raw || "").split("\n")) {
    const u = parseUpdateLine(line);
    if (!u) continue;
    if (u.sessionUpdate === "agent_message_chunk") {
      const t = textOf(u.content);
      if (inAgent) current += t;
      else {
        current = t;
        inAgent = true;
      }
    } else if (inAgent) {
      const cleaned = cleanCaption(current);
      if (cleaned) last = cleaned;
      current = "";
      inAgent = false;
    }
  }
  if (inAgent) {
    const cleaned = cleanCaption(current);
    if (cleaned) last = cleaned;
  }
  return last;
}

function readUpdateSlice(fd, start, size) {
  const len = size - start;
  if (len <= 0) return "";
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, start);
  let raw = buf.toString("utf8");
  if (start > 0) {
    const cut = raw.indexOf("\n");
    raw = cut >= 0 ? raw.slice(cut + 1) : "";
  }
  return raw;
}

// Tail only. Reading a whole updates.jsonl stalls the gateway.
function scanLatestCaption(file, size) {
  if (size <= 0) return "";
  const fd = fs.openSync(file, "r");
  try {
    for (const win of [256 * 1024, 1024 * 1024]) {
      const start = Math.max(0, size - win);
      const text = captionFromUpdateText(readUpdateSlice(fd, start, size));
      if (text) return text;
      if (start === 0) break;
    }
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

function latestAgentCaption(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return "";
  }
  const hit = captionSlots.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.text;
  let text = "";
  try {
    text = scanLatestCaption(file, st.size);
  } catch {
    text = "";
  }
  const next = text || hit?.text || "";
  captionSlots.set(file, { size: st.size, mtime: st.mtimeMs, text: next });
  if (captionSlots.size > 80) captionSlots.delete(captionSlots.keys().next().value);
  return next;
}

export function isRemotePrompt(text) {
  return /^\[Grok Remote\]\s*/i.test(String(text || ""));
}

export function stripRemotePrefix(text) {
  return String(text || "").replace(/^\[Grok Remote\]\s*/i, "");
}

function descOf(content) {
  if (!content) return "";
  if (typeof content === "string") {
    try { return descOf(JSON.parse(content)); } catch { return ""; }
  }
  if (Array.isArray(content)) return content.map(descOf).filter(Boolean).join(" ").slice(0, 160);
  if (typeof content === "object") {
    if (content.text && content.type === "text") return String(content.text).slice(0, 160);
    if (content.content) return descOf(content.content);
  }
  return "";
}

function parseDiffContent(content) {
  let data = content;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { return null; }
  }
  const parts = Array.isArray(data) ? data : data ? [data] : [];
  const diffs = [];
  for (const part of parts) {
    if (!part || part.type !== "diff") continue;
    const details = part._meta?.details || [];
    const hunks = (details.length ? details : [{ old_string: part.oldText, new_string: part.newText }]).map((d) => ({
      oldLine: Number(d.old_line) || 0,
      newLine: Number(d.new_line) || 0,
      before: String(d.context_before || "").split("\n").filter((l) => l !== "").slice(-2),
      old: String(d.old_string || ""),
      neu: String(d.new_string || ""),
      after: String(d.context_after || "").split("\n").filter((l) => l !== "").slice(0, 2),
    }));
    diffs.push({ path: String(part.path || ""), hunks });
  }
  return diffs.length ? diffs : null;
}

function toolDetail(u) {
  const input = u?.rawInput || u?.raw_input || {};
  const cmd = String(input.command || input.cmd || "").trim();
  if (cmd) return cmd.slice(0, 1200);
  const lines = [];
  const file = String(input.path || input.file_path || input.target_file || "").trim();
  if (file) lines.push(file);
  for (const k of ["url", "script", "query", "pattern", "expression", "function", "text", "prompt", "selector"]) {
    if (input[k] == null || input[k] === "") continue;
    const s = typeof input[k] === "string" ? input[k] : JSON.stringify(input[k]);
    if (s) lines.push(k + ": " + s.replace(/\s+/g, " ").slice(0, 400));
  }
  if (!lines.length) {
    for (const [k, v] of Object.entries(input)) {
      if (k === "description" || v == null || v === "") continue;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      if (!s) continue;
      lines.push(k + ": " + s.replace(/\s+/g, " ").slice(0, 240));
      if (lines.length >= 8) break;
    }
  }
  return lines.join("\n").slice(0, 1500);
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

export function promptHistoryFile(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return null;
  return path.join(path.dirname(dir), "prompt_history.jsonl");
}

export function historyContainsPrompt(sessionId, text) {
  const needle = String(text || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!needle) return false;
  const dir = findSessionDir(sessionId);
  const files = [];
  if (dir) {
    files.push(path.join(dir, "prompt_history.jsonl"));
    files.push(path.join(dir, "chat_history.jsonl"));
    files.push(path.join(path.dirname(dir), "prompt_history.jsonl"));
  }
  const extra = promptHistoryFile(sessionId);
  if (extra) files.push(extra);
  const seen = new Set();
  for (const file of files) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(needle)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function appendPromptHistory(sessionId, prompt) {
  const text = String(prompt || "").trim();
  if (!text || text === "[Grok Remote]") return { ok: false, error: "empty" };
  const file = promptHistoryFile(sessionId);
  if (!file) return { ok: false, error: "session not found" };
  const row = {
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    prompt: text,
    is_bash: false,
  };
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  return { ok: true };
}

export function readPromptHistory(sessionId, { limit = 80 } = {}) {
  const file = promptHistoryFile(sessionId);
  const out = [];
  const seen = new Set();
  if (!file || !fs.existsSync(file)) return out;
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const lines = raw.split(/\n/);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const prompt = String(o.prompt || "").trim();
    if (!prompt) continue;
    const text = stripRemotePrefix(prompt).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({
      text,
      source: isRemotePrompt(prompt) ? "app" : "pc",
      at: o.timestamp || null,
      sessionId: o.session_id || sessionId,
    });
  }
  return out;
}

export function listRewindPoints(sessionId) {
  const dir = findSessionDir(sessionId);
  if (!dir) return { ok: false, error: "session not found", points: [] };
  const file = path.join(dir, "rewind_points.jsonl");
  const byIndex = new Map();
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    const re = /\{"prompt_index":(\d+),"created_at":"([^"]+)"/g;
    let m;
    while ((m = re.exec(raw))) {
      const promptIndex = Number(m[1]);
      byIndex.set(promptIndex, { promptIndex, at: m[2] });
    }
  }
  const hist = buildHistory(sessionId, { maxAgeMs: HISTORY_WEEK_MS });
  const users = (hist.items || []).filter((i) => i.kind === "user");
  const previewFor = (idx) => {
    const hit =
      users.find((u) => Number(u.promptIndex) === idx) ||
      users[idx] ||
      users[idx - 1] ||
      null;
    const t = stripRemotePrefix(hit?.text || "").replace(/\s+/g, " ").trim();
    return t ? t.slice(0, 140) : "Turn " + idx;
  };
  const points = [...byIndex.values()]
    .sort((a, b) => b.promptIndex - a.promptIndex)
    .map((p) => ({ ...p, preview: previewFor(p.promptIndex) }));
  return { ok: true, sessionId, points };
}

function mergePromptLists(primary, secondary, limit = 80) {
  const seen = new Set();
  const out = [];
  for (const p of [...(primary || []), ...(secondary || [])]) {
    const text = stripRemotePrefix(p?.text || "").trim();
    if (!text) continue;
    if (seen.has(text)) {
      if (p.source === "app") {
        const existing = out.find((x) => x.text === text);
        if (existing) existing.source = "app";
      }
      continue;
    }
    seen.add(text);
    out.push({ text, source: p.source === "app" ? "app" : "pc" });
    if (out.length >= limit) break;
  }
  return out;
}

const HISTORY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function nextLineStart(fd, offset, size) {
  if (offset <= 0) return 0;
  let pos = offset;
  const cap = Math.min(size, offset + 8 * 1024 * 1024);
  while (pos < cap) {
    const n = Math.min(256 * 1024, cap - pos);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, pos);
    const i = buf.indexOf(0x0a);
    if (i >= 0) return pos + i + 1;
    pos += n;
  }
  return offset;
}

function timestampNear(fd, offset, size) {
  const lineAt = offset <= 0 ? 0 : nextLineStart(fd, offset, size);
  if (lineAt >= size) return null;
  const n = Math.min(160, size - lineAt);
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, lineAt);
  const m = buf.toString("utf8").match(/"timestamp":(\d+)/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v > 1e12 ? Math.floor(v / 1000) : v;
}

function readUpdatesSince(file, cutoffMs) {
  const size = fs.statSync(file).size;
  const cutoffSec = Math.floor(cutoffMs / 1000);
  if (size < 1500000) return { text: fs.readFileSync(file, "utf8"), trimmed: false };
  const fd = fs.openSync(file, "r");
  try {
    const first = timestampNear(fd, 0, size);
    if (first != null && first >= cutoffSec) {
      return { text: fs.readFileSync(file, "utf8"), trimmed: false };
    }
    let lo = 0;
    let hi = size;
    while (hi - lo > 128 * 1024) {
      const mid = Math.floor((lo + hi) / 2);
      const ts = timestampNear(fd, mid, size);
      if (ts == null || ts < cutoffSec) lo = mid;
      else hi = mid;
    }
    let start = nextLineStart(fd, lo, size);
    if (start >= size) start = lo;
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf8");
    if (start > 0 && !text.startsWith("{")) {
      const cut = text.indexOf("\n");
      text = cut >= 0 ? text.slice(cut + 1) : "";
    }
    return { text, trimmed: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
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

export function buildHistory(sessionId, opts = {}) {
  const file = findUpdatesFile(sessionId);
  if (!file) return { ok: false, error: "session not found", items: [] };
  const items = [];
  const tools = new Map();
  const taskStartedAt = new Map();
  let lastTodos = [];
  const maxAgeMs = Number(opts.maxAgeMs) || 0;
  const slice = maxAgeMs > 0 ? readUpdatesSince(file, Date.now() - maxAgeMs) : { text: fs.readFileSync(file, "utf8"), trimmed: false };
  const raw = slice.text;
  const trimmed = !!slice.trimmed;
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
      const images = [];
      imagesOf(u.content, images);
      const last = items[items.length - 1];
      if (last && last.kind === "user") {
        last.text += t;
        if (images.length) last.images = (last.images || []).concat(images).slice(0, 4);
        if (ts) last.at = ts;
        if (u._meta?.promptIndex != null) last.promptIndex = u._meta.promptIndex;
      } else items.push({ kind: "user", text: t, source, at: ts, promptIndex: u._meta?.promptIndex, images });
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
        toolKind: u.kind || u._meta?.["x.ai/tool"]?.kind || u._meta?.["x.ai/tool"]?.name || "",
        status: u.status || "running",
        detail: toolDetail(u),
        blurb: String((u.rawInput || {}).description || "").trim(),
        offset: Number((u.rawInput || {}).offset) || 0,
        limit: Number((u.rawInput || {}).limit) || 0,
        pattern: String((u.rawInput || {}).pattern || ""),
        toolName: String((u.rawInput || {}).tool_name || ""),
        startedAt: ts || 0,
      };
      tools.set(id, card);
      items.push(card);
    } else if (kind === "tool_call_update") {
      const card = tools.get(u.toolCallId);
      if (card) {
        if (u.status) card.status = u.status;
        if (u.title) card.title = u.title;
        const diff = parseDiffContent(u.content);
        if (diff) card.diff = diff;
        if (ts) card.endedAt = ts;
        const blurb = descOf(u.content);
        if (blurb && !card.blurb) card.blurb = blurb;
      }
    } else if (kind === "task_backgrounded" || kind === "task_completed") {
      const snap = u.task_snapshot || {};
      const id = u.tool_call_id || snap.task_id || u.task_id || "";
      const text = String(u.description || snap.description || "").trim() || "command";
      const card = id && tools.get(id);
      if (card) card.hidden = true;
      const command = String(u.command || snap.command || card?.detail || "").trim();
      if (kind === "task_backgrounded") {
        taskStartedAt.set(id, ts || 0);
        items.push({ kind: "task", phase: "started", id, text, command, at: ts || 0 });
      } else {
        const started = id ? taskStartedAt.get(id) || 0 : 0;
        const ended = ts || 0;
        items.push({
          kind: "task",
          phase: "done",
          id,
          text,
          command,
          at: ended,
          durationMs: started && ended >= started ? ended - started : 0,
          exitCode: snap.exit_code,
        });
      }
    } else if (kind === "auto_compact_started") {
      const pct = Number(u.percentage) || 0;
      items.push({
        kind: "compact",
        text: pct ? "Context " + pct + "% full. Compacting..." : (u.reason || "Compacting..."),
        startedAt: ts || 0,
        live: true,
      });
    } else if (kind === "auto_compact_completed") {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === "compact" && items[i].live) {
          items[i].live = false;
          items[i].elapsedMs = Number(u.elapsed_ms) || 0;
          if (ts) items[i].endedAt = ts;
          break;
        }
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
  let visible = items.filter((it) => !it.hidden);
  if (maxAgeMs > 0) {
    const cutoff = Date.now() - maxAgeMs;
    let start = 0;
    while (start < visible.length) {
      const it = visible[start];
      const t = Number(it.at || it.startedAt || it.endedAt) || 0;
      if (t && t < cutoff) start++;
      else break;
    }
    if (start > 0) visible = visible.slice(start);
  }
  const prompts = mergePromptLists(readPromptHistory(sessionId), collectPrompts(items));
  return {
    ok: true,
    sessionId,
    file,
    items: visible,
    trimmed,
    prompts,
    todos: lastTodos,
    counts: {
      user: visible.filter((i) => i.kind === "user").length,
      agent: visible.filter((i) => i.kind === "agent").length,
      tool: visible.filter((i) => i.kind === "tool").length,
      think: visible.filter((i) => i.kind === "think").length,
    },
  };
}
