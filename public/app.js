/* Grok Remote mobile client — ACP over LAN WebSocket */
const qsApk = new URLSearchParams(location.search).get("apk");
if (qsApk) localStorage.setItem("gr.apkVersion", qsApk);
const APP_VERSION =
  qsApk ||
  localStorage.getItem("gr.apkVersion") ||
  window.GROK_REMOTE_VERSION ||
  "0.1.22";
const $ = (id) => document.getElementById(id);
const NATIVE = /^(android|ios)$/i.test(String(window.Capacitor?.getPlatform?.() || ""));
const state = {
  gateway: "",
  pair: null,
  acp: null,
  sessions: [],
  commands: [],
  items: [],
  sessionId: null,
  title: "",
  cwd: "",
  busy: false,
  waiting: false,
  liveOn: false,
  seenIds: new Set(),
  prompts: [],
  turn: { active: false, phase: "", label: "", startedAt: 0, phaseAt: 0 },
  mode: "auto",
  model: "",
  effort: "",
  queue: [],
  pcQueue: [],
  attachments: [],
  openGroups: new Set(),
  stickBottom: true,
  usage: null,
  accountUsage: null,
  todos: [],
  view: "roster",
  perm: null,
  dismissedUpdate: localStorage.getItem("gr.dismissedUpdate") || "",
  notifyNeeds: localStorage.getItem("gr.notifyNeeds") !== "0",
  notifyDone: localStorage.getItem("gr.notifyDone") !== "0",
  quietHours: localStorage.getItem("gr.quietHours") !== "0",
  headsetDictate: localStorage.getItem("gr.headset") !== "0",
  quietView: localStorage.getItem("gr.quietView") === "1",
  problemsOnly: localStorage.getItem("gr.problems") === "1",
  todayOnly: localStorage.getItem("gr.today") === "1",
  speakSteps: localStorage.getItem("gr.speakSteps") === "1",
  pinHash: localStorage.getItem("gr.pinHash") || "",
  pinSalt: localStorage.getItem("gr.pinSalt") || "",
  unlocked: false,
  bioEnabled: localStorage.getItem("gr.bioEnabled") !== "0",
  fsRel: "",
  starred: loadIdList("gr.starred"),
  hiddenIds: loadIdList("gr.hidden"),
  showHidden: false,
  showNeedsOnly: false,
  grokBuild: "",
  notifyMuteUntil: Date.now() + 8000,
  appOpenedAt: Date.now(),
};

function loadIdList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function saveIdList(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr));
}
function isStarred(id) { return state.starred.includes(id); }
function mutedIds() {
  try { return JSON.parse(localStorage.getItem("gr.muted") || "[]"); } catch { return []; }
}
function isMuted(id) { return mutedIds().includes(id); }
function followedId() {
  try { return localStorage.getItem("gr.follow") || ""; } catch { return ""; }
}
function isFollowed(id) { return !!id && followedId() === id; }
function toggleFollow(id) {
  try {
    localStorage.setItem("gr.follow", isFollowed(id) ? "" : id);
  } catch { /* ignore */ }
  renderRoster();
}
function toggleMuted(id) {
  const cur = mutedIds().filter((x) => x !== id);
  if (!isMuted(id)) cur.push(id);
  try { localStorage.setItem("gr.muted", JSON.stringify(cur)); } catch { /* ignore */ }
  renderRoster();
}
function isHiddenSession(id) { return state.hiddenIds.includes(id); }
function toggleStar(id) {
  const i = state.starred.indexOf(id);
  if (i >= 0) state.starred.splice(i, 1);
  else state.starred.unshift(id);
  saveIdList("gr.starred", state.starred);
  renderRoster();
}
function toggleHiddenSession(id) {
  const i = state.hiddenIds.indexOf(id);
  if (i >= 0) state.hiddenIds.splice(i, 1);
  else state.hiddenIds.unshift(id);
  saveIdList("gr.hidden", state.hiddenIds);
  renderRoster();
}
function setSplashVersions(health) {
  if (health?.grokBuild) state.grokBuild = health.grokBuild;
  const el = $("splashVersions");
  const grok = state.grokBuild || health?.grokBuild || "";
  const line = grok
    ? `App ${APP_VERSION} · Grok Build ${grok}`
    : `App ${APP_VERSION} · Grok Build …`;
  if (el) el.textContent = line;
}

function compareSemver(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function extractSessionId(session, fallback) {
  if (!session || typeof session !== "object") return fallback || null;
  return session.sessionId || session.session_id || session._meta?.sessionId || fallback || null;
}

class AcpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = null;
    this.onAgentRequest = null;
    this.onClose = null;
    this.ws = null;
  }
  get ready() { return this.ws && this.ws.readyState === 1; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      const t = setTimeout(() => reject(new Error("connect timeout")), 10000);
      this.ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("WebSocket error")); });
      this.ws.addEventListener("message", (ev) => this._onMessage(ev.data));
      this.ws.addEventListener("close", (ev) => {
        for (const [, p] of this.pending) p.reject(new Error("ws closed"));
        this.pending.clear();
        if (this.onClose) this.onClose(ev);
      });
    });
  }
  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()); }
    catch { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(Object.assign(new Error(msg.error.message || "rpc"), { raw: msg.error })) : p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      this._handleAgentRequest(msg);
      return;
    }
    if (msg.method && this.onNotification) this.onNotification(msg);
  }
  async _handleAgentRequest(msg) {
    try {
      if (this.onAgentRequest) {
        const result = await this.onAgentRequest(msg.method, msg.params);
        if (result !== undefined) {
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
          return;
        }
      }
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } }));
    } catch (err) {
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(err.message || err) } }));
    }
  }
  request(method, params, timeoutMs = 180000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error("timeout " + method)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  notify(method, params) {
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.ws.send(JSON.stringify(msg));
  }
  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

function gatewayBase() {
  return String(state.gateway || "").replace(/\/+$/, "");
}
function api(path) {
  const p = path.startsWith("/") ? path : "/" + path;
  const g = gatewayBase();
  if (!g) return p;
  return g + p;
}
function connectionLabel() {
  if (state._connecting) return "Connecting…";
  if (state.acp?.ready) return "Connected";
  if (state.pair) return "Connected to PC";
  return "Disconnected";
}
function syncHeader(sub) {
  const brand = $("brandTitle");
  if (brand) {
    if (state.view === "thread") brand.textContent = state.title || "Session";
    else if (state.view === "settings") brand.textContent = "Settings";
    else if (state.view === "new") brand.textContent = "New session";
    else brand.textContent = "Grok Remote";
  }
  if (sub != null) $("subTitle").textContent = sub;
  else if (state.view === "thread") $("subTitle").textContent = connectionLabel();
}
function setSub(text) { $("subTitle").textContent = text; }
function showView(name) {
  state.view = name;
  $("rosterView").classList.toggle("hidden", name !== "roster");
  $("threadView").classList.toggle("hidden", name !== "thread");
  $("settingsView").classList.toggle("hidden", name !== "settings");
  $("newView").classList.toggle("hidden", name !== "new");
  $("btnBack").classList.toggle("hidden", name === "roster");
  $("btnNew").classList.toggle("hidden", name === "thread");
  $("btnFind")?.classList.toggle("hidden", name !== "thread");
  if (name !== "thread") hideFind();
  syncHeader();
}
function seenStorageKey(id) {
  return "gr.seen." + id;
}
function markSeen(id, item) {
  if (!id) return;
  const it = item || state.items[state.items.length - 1];
  const at = Number(it?.at) || 0;
  if (!at) return;
  try { localStorage.setItem(seenStorageKey(id), String(at)); } catch { /* ignore */ }
}
function findCatchUp(id) {
  let at = 0;
  try { at = Number(localStorage.getItem(seenStorageKey(id)) || 0); } catch { /* ignore */ }
  if (!at) return -1;
  const i = state.items.findIndex((it) => Number(it.at) > at);
  return i > 0 ? i : -1;
}
function keepSentImages(nextItems) {
  const prev = (state.items || []).filter((it) => it.kind === "user" && it.images?.length);
  if (!prev.length) return nextItems;
  return nextItems.map((it) => {
    if (it.kind !== "user" || (it.images && it.images.length)) return it;
    const text = stripRemotePrefix(it.text || "");
    const hit = prev.find((p) => {
      const same = stripRemotePrefix(p.text || "") === text;
      const close = p.at && it.at && Math.abs(Number(p.at) - Number(it.at)) < 8000;
      return same || close;
    });
    return hit ? { ...it, images: hit.images } : it;
  });
}
const photoZoom = { scale: 1, x: 0, y: 0, moved: false, lastTap: 0 };
function applyPhotoZoom() {
  const img = $("photoViewImg");
  if (!img) return;
  img.style.transform = photoZoom.scale === 1 && !photoZoom.x && !photoZoom.y
    ? ""
    : "translate(" + photoZoom.x + "px," + photoZoom.y + "px) scale(" + photoZoom.scale + ")";
}
function resetPhotoZoom() {
  photoZoom.scale = 1;
  photoZoom.x = 0;
  photoZoom.y = 0;
  photoZoom.moved = false;
  applyPhotoZoom();
}
function zoomPhotoAt(cx, cy, next) {
  const stage = $("photoStage");
  if (!stage) return;
  const s0 = photoZoom.scale || 1;
  const s1 = Math.min(6, Math.max(1, next));
  const rect = stage.getBoundingClientRect();
  const px = cx - rect.left - rect.width / 2;
  const py = cy - rect.top - rect.height / 2;
  photoZoom.x = px - (px - photoZoom.x) * (s1 / s0);
  photoZoom.y = py - (py - photoZoom.y) * (s1 / s0);
  photoZoom.scale = s1;
  if (s1 === 1) { photoZoom.x = 0; photoZoom.y = 0; }
  applyPhotoZoom();
}
function bindPhotoZoom() {
  const stage = $("photoStage");
  if (!stage || stage.dataset.zoom) return;
  stage.dataset.zoom = "1";
  let pinch = null;
  let pan = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      const m = mid(e.touches[0], e.touches[1]);
      pinch = { dist: dist(e.touches[0], e.touches[1]) || 1, scale: photoZoom.scale, mx: m.x, my: m.y };
      pan = null;
      photoZoom.moved = true;
    } else if (e.touches.length === 1) {
      pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: photoZoom.x, oy: photoZoom.y };
      pinch = null;
    }
  }, { passive: true });
  stage.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && pinch) {
      e.preventDefault();
      const m = mid(e.touches[0], e.touches[1]);
      photoZoom.x += m.x - pinch.mx;
      photoZoom.y += m.y - pinch.my;
      pinch.mx = m.x;
      pinch.my = m.y;
      const next = pinch.scale * (dist(e.touches[0], e.touches[1]) / pinch.dist);
      zoomPhotoAt(m.x, m.y, next);
      photoZoom.moved = true;
    } else if (e.touches.length === 1 && pan && photoZoom.scale > 1) {
      e.preventDefault();
      const t = e.touches[0];
      if (Math.hypot(t.clientX - pan.x, t.clientY - pan.y) > 6) photoZoom.moved = true;
      photoZoom.x = pan.ox + (t.clientX - pan.x);
      photoZoom.y = pan.oy + (t.clientY - pan.y);
      applyPhotoZoom();
    }
  }, { passive: false });
  stage.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) pinch = null;
    if (!e.touches.length) {
      const now = Date.now();
      const t = e.changedTouches[0];
      if (!photoZoom.moved && t && now - photoZoom.lastTap < 280) {
        const rect = stage.getBoundingClientRect();
        const zoomed = photoZoom.scale > 1;
        zoomPhotoAt(t.clientX, t.clientY, zoomed ? 1 : 2.5);
      }
      photoZoom.lastTap = now;
      if (photoZoom.scale <= 1) resetPhotoZoom();
      pan = null;
      setTimeout(() => { photoZoom.moved = false; }, 40);
    }
  });
  stage.addEventListener("wheel", (e) => {
    if ($("photoView")?.classList.contains("hidden")) return;
    e.preventDefault();
    zoomPhotoAt(e.clientX, e.clientY, photoZoom.scale * (e.deltaY < 0 ? 1.15 : 0.87));
  }, { passive: false });
  stage.addEventListener("click", (e) => {
    if (photoZoom.moved || photoZoom.scale > 1) return;
    if (e.target === stage) closePhoto();
  });
}
function openPhoto(src) {
  const view = $("photoView");
  const img = $("photoViewImg");
  if (!view || !img || !src) return;
  resetPhotoZoom();
  img.src = src;
  view.classList.remove("hidden");
}
function closePhoto() {
  const view = $("photoView");
  const img = $("photoViewImg");
  resetPhotoZoom();
  if (img) img.removeAttribute("src");
  view?.classList.add("hidden");
}
function cacheTranscript(id) {
  if (!id || !state.items?.length) return;
  if (!state.transcripts) state.transcripts = new Map();
  const items = state.items.filter((it) => it.kind !== "wait").slice(-400).map((it) => ({ ...it }));
  state.transcripts.set(id, {
    items,
    prompts: (state.prompts || []).slice(0, 40),
    todos: state.todos || [],
  });
}
function showCachedTranscript(id) {
  const cached = state.transcripts?.get(id);
  if (!cached?.items?.length) return false;
  state.items = cached.items.map((it) => ({ ...it }));
  if (cached.prompts) state.prompts = cached.prompts.slice();
  if (cached.todos) state.todos = cached.todos;
  state.catchUpIndex = findCatchUp(id);
  renderThread();
  scrollThreadToEnd(true);
  syncHeader(connectionLabel());
  return true;
}
function bindKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv || state._kbBound) return;
  state._kbBound = true;
  const apply = () => {
    const app = $("app");
    if (!app) return;
    app.style.height = Math.round(vv.height) + "px";
    app.style.transform = vv.offsetTop ? `translateY(${Math.round(vv.offsetTop)}px)` : "";
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
}
function rememberPlace() {
  const id = state.sessionId;
  if (!id || state.view !== "thread") return;
  if (nearThreadBottom($("thread"))) {
    markSeen(id);
    return;
  }
  const el = $("thread");
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  const nodes = el.querySelectorAll("[data-i]");
  for (const n of nodes) {
    if (n.getBoundingClientRect().bottom > top + 8) {
      markSeen(id, state.items[Number(n.getAttribute("data-i"))]);
      return;
    }
  }
}
function goBack() {
  if ($("sheet") && !$("sheet").classList.contains("hidden")) {
    hideSheet({ cancel: true });
    return true;
  }
  if ($("planSheet") && !$("planSheet").classList.contains("hidden")) {
    if (state.perm?.resolve && isPlanGateTool(state.perm.toolCall?.title || state.perm.title || "")) {
      resolvePlan("quit");
    } else hidePlanSheet();
    return true;
  }
  if (state.view === "thread" || state.view === "settings" || state.view === "new") {
    if (state.view === "thread") {
      rememberPlace();
      cacheTranscript(state.sessionId);
      void stopReadAloud();
      saveDraft(state.sessionId);
      stopLive();
      endTurn({ notify: false });
      hideHist();
      hideSheet();
      hideFind();
      stopMic();
      state.sessionId = null;
      state._attachedId = null;
      state.busy = false;
      state.queue = [];
      state.pcQueue = [];
      state.attachments = [];
      clearWaiting();
    }
    showView("roster");
    loadRoster();
    return true;
  }
  return false;
}

function subagentChip(s) {
  const n = Number(s?.subagents?.running || 0);
  if (!n) return "";
  const label = n === 1 ? "1 running" : n + " running";
  const tip = (s.subagents.names || []).filter(Boolean).join(" · ");
  return `<span class="chip work" title="${escapeHtml(tip)}">${escapeHtml(label)}</span>`;
}
function activityLabel(s) {
  if (sessionNeedsYou(s)) return "Needs you";
  if (sessionWorking(s)) return "Working";
  if (s?.resident || /live/i.test(String(s?.activity || ""))) return "On PC";
  return "";
}
function activityChip(s) {
  const label = activityLabel(s);
  if (!label) return "";
  const cls = label === "Needs you" ? "need" : label === "Working" ? "work" : "live";
  return `<span class="chip ${cls}">${escapeHtml(label)}</span>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sessionNeedsYou(s) {
  const a = String(s?.activity || "").toLowerCase();
  if (!a || a === "live" || a === "idle" || a === "working") return false;
  return /needs[_ ]?(you|input)|permission|blocked|waiting[_ ]?(for[_ ]?)?(user|input|approval)|ask_user/.test(a);
}
function sessionWorking(s) {
  const a = String(s?.activity || "");
  if (sessionNeedsYou(s)) return false;
  return /work|runn?ing|busy/i.test(a);
}
function agoLabel(ts) {
  if (!ts) return "";
  const n = Date.parse(ts) || Number(ts) || 0;
  if (!n) return "";
  const ms = n < 1e12 ? n * 1000 : n;
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return "<1m";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  return Math.floor(sec / 3600) + "h";
}
function draftKey(id) {
  return "gr.draft." + String(id || "");
}
function saveDraft(id) {
  const sid = id || state.sessionId;
  if (!sid) return;
  const t = String($("prompt")?.value || "");
  try {
    if (!t.trim()) localStorage.removeItem(draftKey(sid));
    else localStorage.setItem(draftKey(sid), t);
  } catch { /* ignore */ }
}
function loadDraft(id) {
  const ta = $("prompt");
  if (!ta || !id) return;
  try { ta.value = localStorage.getItem(draftKey(id)) || ""; } catch { ta.value = ""; }
}
function hasDraft(id) {
  try { return !!(id && (localStorage.getItem(draftKey(id)) || "").trim()); } catch { return false; }
}
function shouldHoldOutbox(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "");
  if (name === "TypeError") return true;
  return /failed to fetch|networkerror|network request failed|load failed|econnrefused|gateway unreachable/i.test(msg);
}
function undoStillAllowed(undo, now, replyStarted) {
  if (!undo) return false;
  if (now - Number(undo.at || 0) > 6000) return false;
  if (replyStarted) return false;
  return true;
}
function replyStartedSince(at) {
  const since = Number(at || 0);
  return (state.items || []).some((it) => {
    if (it.kind !== "agent" && it.kind !== "tool" && it.kind !== "think") return false;
    const t = Number(it.at || it.startedAt || 0);
    return t > 0 && t >= since - 500;
  });
}
function visibleWhenQuiet(kind) {
  return kind === "user" || kind === "agent";
}
function headsetStopTarget(turnActive, openSessionId, workingSessionId) {
  if (turnActive && openSessionId) return openSessionId;
  return workingSessionId || "";
}
function diamondCopyText(body, label) {
  const extra = String(body || "").trim();
  if (extra) return extra;
  return String(label || "").trim();
}
function notifyCaption(id) {
  const sid = id || state.sessionId;
  if (sid && sid === state.sessionId) {
    const live = clipNotify(lastAgentItem()?.text || "", 280);
    if (live) return live;
  }
  const row = (state.sessions || []).find((s) => s.sessionId === sid);
  return clipNotify(row?.lastCaption || row?.lastTurnSummary || "", 280);
}
function glanceCard(s) {
  const same = !!(s && state.sessionId && s.sessionId === state.sessionId);
  const queued = same ? (state.pcQueue || [])[0] : null;
  const needs = sessionNeedsYou(s);
  const working = sessionWorking(s) || !!(state.turn?.active && same);
  let status = "On PC";
  if (needs) status = "Needs you";
  else if (working) status = "Working";
  else if (!s?.resident) status = "";
  return {
    sessionId: s?.sessionId || "",
    title: clipNotify(s?.title || "Grok", 72),
    status,
    lastLine: notifyCaption(s?.sessionId),
    working: !!working,
    queueId: queued && queued.id ? String(queued.id) : "",
    queueText: queued ? clipNotify(queued.text || "", 140) : "",
    note: chatNoteText(s?.sessionId).slice(0, 140),
  };
}
function glancePayload() {
  const vis = (state.sessions || []).filter((s) => !isHiddenSession(s.sessionId));
  const needRows = vis.filter(sessionNeedsYou);
  const workRows = vis.filter((s) => sessionWorking(s) && !needRows.some((n) => n.sessionId === s.sessionId));
  const openRows = vis.filter((s) => s.resident && !needRows.some((n) => n.sessionId === s.sessionId) && !workRows.some((n) => n.sessionId === s.sessionId));
  const active = [...needRows, ...workRows, ...openRows];
  const hot = active[0] || vis.find((s) => s.resident) || vis[0] || null;
  const shown = (active.length ? active : hot ? [hot] : []).slice(0, 8);
  const cards = shown.map(glanceCard);
  const primary = cards[0] || null;
  const parts = [];
  if (needRows.length) parts.push(needRows.length + (needRows.length === 1 ? " needs you" : " need you"));
  else if (workRows.length) parts.push(workRows.length + " working");
  let status = "On PC";
  if (needRows.length) status = needRows.length === 1 ? "Needs you" : needRows.length + " need you";
  else if (workRows.length) status = workRows.length === 1 ? "Working" : workRows.length + " working";
  else if (hot?.resident) status = "On PC";
  return {
    text: parts.length ? parts.join(" · ") : "Listening for Grok on this Wi‑Fi",
    title: primary?.title || "Grok Remote",
    status: cards.length > 1 ? status : (primary?.status || status),
    lastLine: primary?.lastLine || "",
    sessionId: primary?.sessionId || "",
    working: primary ? !!primary.working : false,
    gateway: state.gateway || "",
    secret: state.pair?.secret || "",
    queueId: primary?.queueId || "",
    queueText: primary?.queueText || "",
    note: primary?.note || "",
    cards: JSON.stringify(cards),
  };
}
function pushGlance() {
  const G = capPlugins().GrokGlance;
  if (!G?.setText) return;
  try { G.setText(glancePayload()); } catch { /* ignore */ }
}
async function consumeWidgetOpen() {
  const G = capPlugins().GrokGlance;
  if (!G?.getPendingOpen || !state.pair) return false;
  try {
    const r = await G.getPendingOpen();
    const id = String(r?.sessionId || "").trim();
    if (r?.stop && id) {
      void cancelSessionTurn(id);
      return true;
    }
    if (!id) return false;
    if (state.sessionId !== id) openSession(id);
    return true;
  } catch {
    return false;
  }
}
function dictationTargetId() {
  try {
    const follow = localStorage.getItem("gr.follow") || "";
    if (follow) return follow;
  } catch { /* ignore */ }
  return glancePayload().sessionId || "";
}
function takeDictation(text) {
  const ta = $("prompt");
  const bit = String(text || "").trim();
  if (!ta || !bit) return;
  const pad = ta.value && !/\s$/.test(ta.value) ? " " : "";
  ta.value += pad + bit;
  saveDraft(state.sessionId);
}
async function onHeadset() {
  if (!state.headsetDictate) return;
  const working = (state.sessions || []).find((s) => sessionWorking(s) && !isHiddenSession(s.sessionId));
  const stopId = headsetStopTarget(!!state.turn?.active, state.sessionId || "", working?.sessionId || "");
  if (stopId) {
    void cancelSessionTurn(stopId);
    setSub("Stop sent");
    return;
  }
  if (state._headsetBusy) return;
  state._headsetBusy = true;
  setSub("Listening…");
  try {
    const Speech = capPlugins().GrokSpeech;
    const r = Speech?.start ? await Speech.start() : null;
    const text = String(r?.text || "").trim();
    if (!text) {
      setSub("No speech captured");
      return;
    }
    state._hearNextSend = true;
    if (state.view === "thread" && state.sessionId) {
      takeDictation(text);
      $("prompt")?.focus();
      setSub("Dictation added");
      return;
    }
    const id = dictationTargetId();
    if (!id) {
      setSub("Open a chat, then dictate");
      return;
    }
    state._pendingDictate = text;
    openSession(id);
    setSub("Dictation added");
  } catch (err) {
    const msg = String(err?.message || err || "cancelled");
    setSub(/cancel/i.test(msg) ? "Mic cancelled" : "Mic: " + msg);
  } finally {
    state._headsetBusy = false;
  }
}
function wireHeadset() {
  if (state._headsetWired) return;
  state._headsetWired = true;
  const G = capPlugins().GrokGlance;
  try { G?.setHeadset?.({ enabled: !!state.headsetDictate }); } catch { /* ignore */ }
  try {
    G?.addListener?.("headset", () => { void onHeadset(); });
  } catch { /* ignore */ }
}
function wireWidgetOpen() {
  if (state._widgetWired) return;
  state._widgetWired = true;
  const App = capPlugins().App;
  try {
    App?.addListener?.("appStateChange", (s) => {
      if (s?.isActive) {
        void consumeWidgetOpen();
        void consumeShare();
        void flushOutbox();
      }
    });
  } catch { /* ignore */ }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void consumeWidgetOpen();
      void consumeShare();
      void flushOutbox();
    }
  });
}
function renderWorkStrip() {
  const el = $("workStrip");
  if (!el) return;
  const vis = (state.sessions || []).filter((s) => !isHiddenSession(s.sessionId));
  const need = vis.filter(sessionNeedsYou);
  const work = vis.filter((s) => sessionWorking(s) && !need.some((n) => n.sessionId === s.sessionId));
  const hot = [
    ...need.map((s) => ({ s, cls: "need", meta: "Needs you" })),
    ...work.slice(0, 3).map((s) => ({ s, cls: "work", meta: "Working" })),
  ];
  if (!hot.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    pushGlance();
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = hot.slice(0, 8).map((row) => {
    const age = agoLabel(row.s.updatedAt || row.s.updated_at);
    const meta = row.meta + (age ? " · " + age : "");
    return `<button type="button" class="work-chip ${row.cls}" data-id="${escapeHtml(row.s.sessionId)}">
      <div class="w-title">${escapeHtml(row.s.title || "Untitled")}</div>
      <div class="w-meta">${escapeHtml(meta)}</div>
    </button>`;
  }).join("");
  el.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => openSession(b.getAttribute("data-id")));
  });
  pushGlance();
}

function renderMessageHits() {
  const el = $("msgHits");
  if (!el) return;
  const hits = state.messageHits || [];
  const q = ($("search")?.value || "").trim();
  if (!hits.length) {
    if (q.length >= 2) {
      el.classList.remove("hidden");
      el.innerHTML = `<div class="empty">No chat text matches “${escapeHtml(q)}”. Session names are filtered in the list below.</div>`;
    } else {
      el.classList.add("hidden");
      el.innerHTML = "";
    }
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = hits.map((h) =>
    `<button type="button" class="msg-hit" data-id="${escapeHtml(h.sessionId)}"><strong>${escapeHtml(h.title || "Untitled")}</strong><span>${escapeHtml(h.snippet || "")}</span></button>`
  ).join("");
  el.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => openSession(b.getAttribute("data-id")));
  });
}
async function loadMessageHits(q) {
  const secret = state.pair?.secret || "";
  try {
    const data = await fetch(
      api("/api/search?q=" + encodeURIComponent(q) + "&secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
    if (($("search")?.value || "").trim() !== q) return;
    state.messageHits = Array.isArray(data.hits) ? data.hits : [];
  } catch {
    state.messageHits = [];
  }
  renderMessageHits();
}
function sessionMatchesQuery(s, q) {
  if (!q) return true;
  const id = String(s.sessionId || "");
  const hay = [
    s.title,
    s.cwd,
    s.lastTurnSummary,
    s.activity,
    s.modelId,
    s.model,
    id,
    id.slice(-8),
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

function renderRoster() {
  const q = ($("search")?.value || "").toLowerCase().trim();
  const hiddenN = state.hiddenIds.filter((id) => state.sessions.some((s) => s.sessionId === id)).length;
  const needsN = state.sessions.filter((s) => sessionNeedsYou(s) && !isHiddenSession(s.sessionId)).length;
  const showBtn = $("btnShowHidden");
  if (showBtn) {
    showBtn.classList.toggle("hidden", hiddenN === 0);
    showBtn.textContent = state.showHidden ? `Showing hidden (${hiddenN})` : `Show hidden (${hiddenN})`;
  }
  const needsBtn = $("btnNeedsOnly");
  if (needsBtn) {
    needsBtn.classList.toggle("hidden", needsN === 0 && !state.showNeedsOnly);
    needsBtn.classList.toggle("on", state.showNeedsOnly);
    needsBtn.textContent = needsN ? `Needs you (${needsN})` : "Needs you";
    if (needsN === 0) state.showNeedsOnly = false;
  }
  let rows = state.sessions.filter((s) => {
    if (!state.showHidden && isHiddenSession(s.sessionId)) return false;
    if (state.showNeedsOnly && !sessionNeedsYou(s)) return false;
    return sessionMatchesQuery(s, q);
  });
  rows = rows.slice().sort((a, b) => {
    const an = sessionNeedsYou(a);
    const bn = sessionNeedsYou(b);
    if (an && !bn) return -1;
    if (!an && bn) return 1;
    const as = isStarred(a.sessionId);
    const bs = isStarred(b.sessionId);
    if (as && !bs) return -1;
    if (!as && bs) return 1;
    if (as && bs) return state.starred.indexOf(a.sessionId) - state.starred.indexOf(b.sessionId);
    return 0;
  });
  renderWorkStrip();
  if (!rows.length) {
    $("roster").innerHTML = q
      ? `<div class="empty">No sessions match that search.<br><button type="button" class="ghost empty-act" id="emptyClearSearch">Clear search</button></div>`
      : state.showNeedsOnly
        ? `<div class="empty">Nothing is waiting on you.<br><button type="button" class="ghost empty-act" id="emptyShowAll">Show all sessions</button></div>`
        : hiddenN && !state.showHidden
          ? `<div class="empty">Hidden sessions are tucked away.<br><button type="button" class="ghost empty-act" id="emptyShowHidden">Show hidden</button></div>`
          : `<div class="empty">No sessions yet.<br><button type="button" class="ghost empty-act" id="emptyNew">Start a session</button></div>`;
    $("emptyClearSearch")?.addEventListener("click", () => { $("search").value = ""; state.messageHits = []; renderMessageHits(); renderRoster(); });
    $("emptyShowAll")?.addEventListener("click", () => { state.showNeedsOnly = false; renderRoster(); });
    $("emptyShowHidden")?.addEventListener("click", () => { state.showHidden = true; renderRoster(); });
    $("emptyNew")?.addEventListener("click", () => { $("btnNew")?.click(); });
    return;
  }
  $("roster").innerHTML = rows.map((s) => {
    const id = s.sessionId;
    const star = isStarred(id);
    const hid = isHiddenSession(id);
    return `
    <div class="row-wrap${star ? " starred" : ""}${hid ? " hidden-row" : ""}" data-id="${escapeHtml(id)}">
      <div class="swipe-actions">
        <button class="swipe-hide" type="button">${hid ? "Show" : "Hide"}</button>
        <button class="swipe-rename" type="button">Rename</button>
        <button class="swipe-pin" type="button">${star ? "Unpin" : "Pin"}</button>
      </div>
      <div class="row-front">
        <div class="row" role="button">
          <div class="row-main">
            <div class="title">${activityChip(s)}${subagentChip(s)}${s.planMode === "plan" ? `<span class="chip plan">Plan</span>` : ""}${isFollowed(s.sessionId) ? `<span class="chip work">Follow</span>` : ""}${isMuted(s.sessionId) ? `<span class="chip">Muted</span>` : ""}${escapeHtml(s.title || "Untitled")}</div>
            <div class="meta">${chatNoteText(id) ? `<span class="row-note">${escapeHtml(chatNoteText(id))}</span>` : ""}${hasDraft(id) ? "Draft · " : ""}${escapeHtml(s.lastTurnSummary || s.cwd || "")}</div>
          </div>
          <button class="row-star${star ? " on" : ""}" type="button" title="${star ? "Unpin" : "Pin"}" aria-label="${star ? "Unpin" : "Pin"}">${star ? "\u2605" : "\u2606"}</button>
        </div>
      </div>
    </div>`;
  }).join("");
  $("roster").querySelectorAll(".row-wrap").forEach((wrap) => {
    const id = wrap.getAttribute("data-id");
    wrap.querySelector(".row").addEventListener("click", (e) => {
      if (wrap.dataset.held === "1") {
        delete wrap.dataset.held;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target.closest(".row-star")) return;
      if (wrap.classList.contains("open")) {
        closeRowSwipe(wrap);
        return;
      }
      openSession(id);
    });
    wrap.querySelector(".row-star").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleStar(id);
    });
    wrap.querySelector(".swipe-hide").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleHiddenSession(id);
    });
    wrap.querySelector(".swipe-pin").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleStar(id);
    });
    wrap.querySelector(".swipe-rename").addEventListener("click", (e) => {
      e.stopPropagation();
      closeRowSwipe(wrap);
      const title = state.sessions.find((s) => s.sessionId === id)?.title || "";
      openRenameSheet(id, title);
    });
    wireRowSwipe(wrap);
    let hold = null;
    let hx = 0;
    let hy = 0;
    const startHold = (e) => {
      const t = e.touches && e.touches[0];
      hx = t ? t.clientX : 0;
      hy = t ? t.clientY : 0;
      hold = setTimeout(() => {
        hold = null;
        wrap.dataset.held = "1";
        openRosterMenu(id);
      }, 450);
    };
    const endHold = () => { if (hold) { clearTimeout(hold); hold = null; } };
    const moveHold = (e) => {
      if (!hold) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - hx) > 14 || Math.abs(t.clientY - hy) > 14) endHold();
    };
    wrap.addEventListener("contextmenu", (e) => { e.preventDefault(); openRosterMenu(id); });
    wrap.addEventListener("touchstart", startHold, { passive: true });
    wrap.addEventListener("touchend", endHold);
    wrap.addEventListener("touchmove", moveHold, { passive: true });
  });
}
const SWIPE_W = 228;
function closeRowSwipe(wrap) {
  const front = wrap?.querySelector(".row-front");
  if (!front) return;
  front.style.transition = "transform .22s cubic-bezier(.2,.8,.2,1)";
  front.style.transform = "translate3d(0,0,0)";
  wrap.classList.remove("open");
}
function closeOpenSwipes(except) {
  document.querySelectorAll(".row-wrap.open").forEach((w) => {
    if (w !== except) closeRowSwipe(w);
  });
}
function wireRowSwipe(wrap) {
  const front = wrap.querySelector(".row-front");
  if (!front) return;
  let x0 = 0, y0 = 0, axis = null, startX = 0;
  const setX = (x, animate) => {
    const clamped = Math.min(16, Math.max(-SWIPE_W - 28, x));
    front.style.transition = animate ? "transform .22s cubic-bezier(.2,.8,.2,1)" : "none";
    front.style.transform = `translate3d(${clamped}px,0,0)`;
    wrap.classList.toggle("open", clamped < -SWIPE_W * 0.6);
  };
  wrap.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    x0 = t.clientX;
    y0 = t.clientY;
    axis = null;
    startX = wrap.classList.contains("open") ? -SWIPE_W : 0;
    front.style.transition = "none";
  }, { passive: true });
  wrap.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    const mx = t.clientX - x0;
    const my = t.clientY - y0;
    if (!axis) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      axis = Math.abs(mx) > Math.abs(my) * 1.15 ? "x" : "y";
      if (axis === "x") closeOpenSwipes(wrap);
    }
    if (axis !== "x") return;
    e.preventDefault();
    setX(startX + mx, false);
  }, { passive: false });
  wrap.addEventListener("touchend", () => {
    if (axis !== "x") return;
    const m = /translate3d\((-?\d+(?:\.\d+)?)px/.exec(front.style.transform || "");
    const cur = m ? Number(m[1]) : startX;
    setX(cur < -SWIPE_W * 0.28 ? -SWIPE_W : 0, true);
    axis = null;
  });
}

function nearThreadBottom(el) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
}
function updateJumpBtn() {
  const btn = $("btnJump");
  if (!btn) return;
  btn.classList.toggle("hidden", state.view !== "thread" || !!state.stickBottom);
}
function scrollThreadToEnd(force) {
  const el = $("thread");
  if (!el) return;
  if (!force && !state.stickBottom) {
    updateJumpBtn();
    return;
  }
  state.stickBottom = true;
  state._ignoreScroll = true;
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
    state._ignoreScroll = false;
    updateJumpBtn();
  });
  updateJumpBtn();
}
function jumpToBottom() {
  state.stickBottom = true;
  scrollThreadToEnd(true);
}
function setKeepAwake(on) {
  const next = !!on;
  if (state._awake === next) return;
  state._awake = next;
  try { capPlugins().GrokGlance?.setAwake?.({ awake: next }); } catch { /* ignore */ }
}
function syncLiveChip() {
  const chip = $("liveChip");
  if (!chip) return;
  const permOn = $("permBox") && !$("permBox").classList.contains("hidden");
  const attention = state.view === "thread" ? attentionLabel(planAwaitingReview(), !!permOn) : "";
  const working = !!(state.turn && state.turn.active && state.view === "thread");
  const label = attention || (working ? liveChipLabel(modelLabel(state.model), turnStatusLabel()) : "");
  chip.classList.toggle("hidden", !label);
  chip.textContent = label || "";
}
function chatNoteText(id) {
  if (!id) return "";
  try { return (localStorage.getItem("gr.note." + id) || "").trim(); } catch { return ""; }
}
function loadChatNote(id) {
  const el = $("chatNote");
  if (!el) return;
  el.value = id ? (localStorage.getItem("gr.note." + id) || "") : "";
}
function saveChatNote() {
  const el = $("chatNote");
  if (!el || !state.sessionId) return;
  const text = el.value.trim();
  const key = "gr.note." + state.sessionId;
  if (text) localStorage.setItem(key, text.slice(0, 200));
  else localStorage.removeItem(key);
  pushGlance();
}
function onLiveChip() {
  if (state.view === "thread" && planAwaitingReview()) {
    $("planBar")?.classList.remove("hidden");
    $("planBar")?.scrollIntoView({ block: "nearest" });
    return;
  }
  const perm = $("permBox");
  if (perm && !perm.classList.contains("hidden")) {
    perm.scrollIntoView({ block: "nearest" });
    return;
  }
  jumpToNow();
}
function persistQueue(id) {
  const sid = id || state.sessionId;
  if (!sid) return;
  try {
    const slim = (state.queue || []).slice(0, 20).map((e) => ({
      text: String(e.text || ""),
      hear: !!e.hear,
    }));
    localStorage.setItem("gr.q." + sid, JSON.stringify(slim));
  } catch { /* ignore */ }
}
function restoreQueue(id) {
  if (!id) return [];
  try { return restoreQueueList(JSON.parse(localStorage.getItem("gr.q." + id) || "[]")); }
  catch { return []; }
}
function jumpToNow() {
  const el = $("thread");
  if (!el) return;
  if (state.quietView) {
    const rows = el.querySelectorAll(".reply, .bubble.user");
    const last = rows[rows.length - 1];
    if (last) {
      state.stickBottom = false;
      last.scrollIntoView({ block: "end" });
      setSub("At the latest message");
      return;
    }
  }
  const live = el.querySelector("[data-live='1']");
  if (live) {
    state.stickBottom = false;
    live.scrollIntoView({ block: "center" });
    setSub("At the live row");
    return;
  }
  jumpToBottom();
  setSub("At the bottom");
}
function syncQuietBtn() {
  const b = $("btnQuiet");
  if (b) {
    b.textContent = state.quietView ? "Show tools" : "Quiet";
    b.classList.toggle("on", !!state.quietView);
  }
  const p = $("btnProblems");
  if (p) {
    p.textContent = state.problemsOnly ? "All steps" : "Problems";
    p.classList.toggle("on", !!state.problemsOnly);
  }
  const day = $("btnToday");
  if (day) {
    day.textContent = state.todayOnly ? "Show week" : "Today";
    day.classList.toggle("on", !!state.todayOnly);
  }
}
function onThreadScroll() {
  const el = $("thread");
  if (!el) return;
  const near = nearThreadBottom(el);
  if (state._ignoreScroll && near) return;
  state._ignoreScroll = false;
  state.stickBottom = near;
  if (near && state.sessionId) {
    markSeen(state.sessionId);
    if (state.catchUpIndex >= 0) state.catchUpIndex = -1;
  }
  updateJumpBtn();
  $("btnCatchUp")?.classList.toggle("hidden", !(state.catchUpIndex >= 0));
}

function fmtElapsed(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 10) return s.toFixed(1) + "s";
  if (s < 60) return Math.floor(s) + "s";
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return m + "m" + rem + "s";
}

function fmtClock(ms) {
  if (!ms) return "";
  const n = Number(ms);
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return "";
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const am = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + min + " " + am;
}

function loadBlockPref(sessionId) {
  state.blockPref = new Map();
  if (!sessionId) return;
  try {
    const raw = JSON.parse(localStorage.getItem("gr.blocks." + sessionId) || "{}");
    for (const [k, v] of Object.entries(raw)) {
      if (v === "open" || v === "closed") state.blockPref.set(k, v);
    }
  } catch { /* ignore */ }
}
function saveBlockPref() {
  if (!state.sessionId || !state.blockPref) return;
  const obj = {};
  for (const [k, v] of state.blockPref) obj[k] = v;
  try { localStorage.setItem("gr.blocks." + state.sessionId, JSON.stringify(obj)); } catch { /* ignore */ }
}
function blockOpen(key, fallback) {
  const v = key && state.blockPref?.get(key);
  if (v === "open") return true;
  if (v === "closed") return false;
  return !!fallback;
}
function rememberBlock(key, open) {
  if (!key) return;
  if (!state.blockPref) state.blockPref = new Map();
  state.blockPref.set(key, open ? "open" : "closed");
}
function setBlockPref(key, open) {
  rememberBlock(key, open);
  saveBlockPref();
}
function applyEditFollow(fromKey, open) {
  const blocks = [...document.querySelectorAll("#thread .edit-block")];
  let seen = false;
  for (const block of blocks) {
    const key = block.getAttribute("data-block");
    if (!key) continue;
    if (key === fromKey) seen = true;
    if (!seen) {
      if (!state.blockPref?.has(key)) rememberBlock(key, !block.classList.contains("collapsed"));
      continue;
    }
    block.classList.toggle("collapsed", !open);
    rememberBlock(key, open);
  }
  rememberBlock("edit:*", open);
  saveBlockPref();
}
function codeKey(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return "code:" + (h >>> 0).toString(36);
}
function codeBlockHtml(lang, body) {
  const text = String(body || "").replace(/\n$/, "");
  const lines = text ? text.split("\n").length : 0;
  const label = lang || "code";
  const key = codeKey(text);
  const open = blockOpen(key, true);
  return `<div class="code-block${open ? "" : " collapsed"}" data-block="${escapeHtml(key)}"><div class="code-head"><button type="button" class="diamond-toggle"><span class="mark">◆</span> <span class="code-lang">${escapeHtml(label)}</span><span class="code-hint">${lines} ${lines === 1 ? "line" : "lines"}</span></button><button type="button" class="copy-code">Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
}
function renderMarkdown(raw) {
  const lines = String(raw || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inlineMd(para.join("\n"))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.type;
    out.push(`<${tag}>` + list.items.map((x) => `<li>${inlineMd(x)}</li>`).join("") + `</${tag}>`);
    list = null;
  };
  let code = null;
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line.trim())) {
        out.push(codeBlockHtml(code.lang, code.lines.join("\n")));
        code = null;
      } else code.lines.push(line);
      continue;
    }
    const open = line.match(/^\s*```([^`]*)$/);
    if (open) {
      flushPara();
      flushList();
      code = { lang: open[1].trim(), lines: [] };
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      flushPara();
      flushList();
      const n = h[1].length;
      out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  if (code) out.push(codeBlockHtml(code.lang, code.lines.join("\n")));
  return out.join("") || `<p>${inlineMd(lines.join("\n"))}</p>`;
}

function inlineMd(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, (_, c) =>
    /^https?:\/\//i.test(c) ? `<a href="${c}" target="_blank" rel="noopener">${c}</a>` : `<code>${c}</code>`
  );
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  t = t.replace(/\n/g, "<br>");
  return t;
}

function catchUpDivider(it) {
  if (!(state.catchUpIndex >= 0) || it._i !== state.catchUpIndex) return "";
  return `<div class="catchup-line" id="catchUpLine">Where you left off</div>`;
}
function toolStillRunning(it) {
  return it?.kind === "tool" && !/complete|success|ok|done|fail|error/i.test(String(it.status || ""));
}
function turnStillGoing() {
  if (state.turn?.active) return true;
  if (liveCompact()) return true;
  const items = state.items || [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return false;
    if (it.kind === "agent") return !!it.live;
    if (toolStillRunning(it)) return true;
    if (it.kind === "think") {
      if (it.live) return true;
      const age = Date.now() - (Number(it.startedAt) || 0);
      if (!it.durationMs && age >= 0 && age < 120000) return true;
    }
  }
  return false;
}
function currentThinkItem() {
  if (!turnStillGoing()) return null;
  const items = state.items || [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user" || it.kind === "agent" || it.kind === "compact") return null;
    if (it.kind === "think") return it;
  }
  return null;
}
function thinkLive(it) {
  return currentThinkItem() === it;
}
function thinkSummary(it) {
  if (thinkLive(it)) return "Thinking...";
  if (it.durationMs) return "Thought for " + fmtElapsed(it.durationMs);
  return "Thought";
}

function toolMark(it) {
  const st = String(it.status || "").toLowerCase();
  if (/fail|error/.test(st)) return { cls: "bad", mark: "✕" };
  if (/complete|success|ok|done/.test(st)) return { cls: "ok", mark: "◆" };
  return { cls: "run", mark: "◇" };
}

function isFailedStep(it) {
  if (!it) return false;
  if (it.kind === "tool") return /fail|error/i.test(String(it.status || ""));
  if (it.kind === "task") return Number(it.exitCode) > 0;
  return false;
}
function turnSpan(steps) {
  let start = 0;
  let end = 0;
  for (const it of steps || []) {
    const a = Number(it.startedAt || it.at || 0);
    const b = Number(it.endedAt || it.at || it.startedAt || 0);
    if (a && (!start || a < start)) start = a;
    if (b && b > end) end = b;
  }
  if (!start || !end || end < start) return 0;
  return end - start;
}
function bundleTurns(items) {
  const out = [];
  let steps = [];
  const flush = (finished) => {
    if (!steps.length) return;
    const dur = turnSpan(steps);
    const n = steps.length;
    out.push({
      kind: "turnpack",
      items: steps.slice(),
      finished: !!finished,
      count: n,
      dur,
      key: "turn:" + (steps[0].id || steps[0].startedAt || steps[0]._i || n),
      label: n + " step" + (n === 1 ? "" : "s") + (dur ? " · " + fmtElapsed(dur) : ""),
    });
    steps = [];
  };
  for (const it of items || []) {
    if (it.kind === "user" || it.kind === "agent") {
      flush(true);
      out.push(it);
    } else steps.push(it);
  }
  flush(false);
  return out;
}
function renderThread() {
  const el = $("thread");
  const prevTop = el.scrollTop;
  const stick = state.stickBottom || nearThreadBottom(el);
  state.items.forEach((it, i) => { it._i = i; });
  let shown = state.items;
  if (state.todayOnly) shown = filterToToday(shown, Date.now());
  if (state.quietView) shown = shown.filter((it) => visibleWhenQuiet(it.kind));
  else if (state.problemsOnly) shown = shown.filter((it) => it.kind === "user" || it.kind === "agent" || isFailedStep(it));
  const packed = state.quietView ? shown : bundleTurns(shown);
  if (!state.quietView) {
    for (let i = 0; i < packed.length; i++) {
      if (packed[i].kind === "turnpack" && packed[i + 1]?.kind === "agent") packed[i].replyText = packed[i + 1].text || "";
    }
  }
  const body = packed.map((it) => {
    if (it.kind === "turnpack") {
      const inner = groupedItems(it.items).map((step) => {
        if (step.kind === "think") {
          const thinking = thinkLive(step);
          const key = "think:" + String(step.startedAt || step._i);
          const copy = encodeURIComponent(diamondCopyText(step.text, thinkSummary(step)));
          const opened = blockOpen(key, thinking);
          return `<div class="bubble think${opened ? "" : " collapsed"}" data-block="${escapeHtml(key)}" data-copy="${copy}"${thinking ? " data-live=\"1\"" : ""} data-i="${step._i}"><button type="button" class="diamond-toggle"><span class="mark">${thinking ? "◇" : "◆"}</span> ${escapeHtml(thinkSummary(step))}</button><div class="think-body">${escapeHtml(step.text || "")}</div></div>`;
        }
        if (step.kind === "task") return renderTaskRow(step);
        if (step.kind === "compact") return `<div class="compact-line">${escapeHtml(step.text || "Compacting...")}</div>`;
        if (step.kind === "tool") return renderToolRow(step);
        if (step.kind === "toolgroup") return renderToolGroup(step);
        return "";
      }).join("");
      const failed = (it.items || []).some(isFailedStep);
      const open = problemsTurnOpen(it.finished, failed, state.problemsOnly);
      const copy = turnCopyText(it.items, it.replyText);
      return diamondBlock(it.key, it.label, `<div class="tool-group-list">${inner}</div>`, open, "", copy, !it.finished);
    }
    if (it.kind === "user") {
      const time = fmtClock(it.at);
      const phone = it.source === "app" ? `<span class="chip">Phone</span> ` : "";
      const photos = (it.images || []).length
        ? `<div class="chat-photos">${it.images.map((_, n) => `<button type="button" class="chat-photo" data-i="${it._i}" data-n="${n}"><img alt=""></button>`).join("")}</div>`
        : "";
      const body = it.text && it.text !== "(image)" ? escapeHtml(it.text) : "";
      return `${catchUpDivider(it)}<div class="bubble user" data-i="${it._i}">${phone}${photos}${body}${time ? `<div class="msg-time">${escapeHtml(time)}</div>` : ""}</div>`;
    }
    if (it.kind === "agent") {
      const time = fmtClock(it.at);
      const live = !!(it.live || (state.turn.active && lastAgentItem() === it));
      const foot = live
        ? "Writing…"
        : it.workedMs
          ? "Worked for " + fmtElapsed(it.workedMs)
          : "";
      return `${catchUpDivider(it)}<div class="reply" data-i="${it._i}">
        ${time ? `<div class="reply-time">${escapeHtml(time)}</div>` : ""}
        <div class="md">${renderMarkdown(it.text)}</div>
        <div class="reply-foot">${foot ? `<span>${escapeHtml(foot)}</span>` : `<span></span>`}<button type="button" class="copy-btn" data-i="${it._i}">Copy</button></div>
      </div>`;
    }
    if (it.kind === "think") {
      const thinking = thinkLive(it);
      const key = "think:" + String(it.startedAt || it._i);
      const open = blockOpen(key, thinking);
      const copy = encodeURIComponent(diamondCopyText(it.text, thinkSummary(it)));
      return `<div class="bubble think${open ? "" : " collapsed"}" data-block="${escapeHtml(key)}" data-copy="${copy}"${thinking ? " data-live=\"1\"" : ""} data-i="${it._i}"><button type="button" class="diamond-toggle"><span class="mark">${thinking ? "◇" : "◆"}</span> ${escapeHtml(thinkSummary(it))}</button><div class="think-body">${escapeHtml(it.text || "")}</div></div>`;
    }
    if (it.kind === "task") return renderTaskRow(it);
    if (it.kind === "compact") return `<div class="compact-line">${escapeHtml(it.text || "Compacting...")}</div>`;
    if (it.kind === "tool") return renderToolRow(it);
    if (it.kind === "toolgroup") return renderToolGroup(it);
    if (it.kind === "plan") return `<div class="tool ok"><span class="mark">◆</span>${escapeHtml(it.text.split("\n")[0] || "plan")}</div>`;
    return "";
  }).join("");
  const week = state.historyTrimmed ? `<div class="history-note">Showing the last 7 days</div>` : "";
  const empty = state.todayOnly && !body
    ? `<div class="empty">Nothing from today. Tap Show week to see the last 7 days.</div>`
    : state.historyTrimmed
    ? `<div class="empty">Nothing in the last 7 days. Type a message below and tap Send.</div>`
    : `<div class="empty">Nothing in this chat yet. Type a message below and tap Send.</div>`;
  el.innerHTML = week + (body || empty) + predictHtml();
  if (state._scrollFail && !state._loadingHistory && state.items.length) {
    state._scrollFail = false;
    const failAt = latestFailureIndex(state.items);
    if (failAt >= 0) {
      state.stickBottom = false;
      requestAnimationFrame(() => jumpToItem(failAt));
    }
  }
  el.querySelectorAll(".chat-photo").forEach((b) => {
    const it = state.items[Number(b.getAttribute("data-i"))];
    const src = it?.images?.[Number(b.getAttribute("data-n"))];
    const img = b.querySelector("img");
    if (img && src) img.src = src;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPhoto(src);
    });
  });
  el.querySelectorAll(".diamond-toggle").forEach((b) => {
    b.addEventListener("click", () => {
      const block = b.closest(".code-block, .edit-block, .bubble.think, .diamond-block");
      if (!block) return;
      block.classList.toggle("collapsed");
      const key = block.getAttribute("data-block") || "";
      const open = !block.classList.contains("collapsed");
      if (block.classList.contains("edit-block")) applyEditFollow(key, open);
      else setBlockPref(key, open);
    });
  });
  bindDiamondCopy(el);
  el.querySelectorAll(".tool-line").forEach((b) => {
    b.addEventListener("click", () => {
      const row = b.closest(".tool");
      if (!row?.querySelector(".tool-detail")) return;
      row.classList.toggle("open");
      setBlockPref(row.getAttribute("data-block"), row.classList.contains("open"));
    });
  });
  el.querySelectorAll(".retry-btn").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const it = state.items[Number(b.getAttribute("data-i"))];
      if (!it) return;
      const what = String(it.detail || it.title || "the last failed step").trim();
      void sendPrompt("Retry this failed step: " + what, { now: true });
    });
  });
  el.querySelectorAll(".predict").forEach((b) => {
    b.addEventListener("click", () => {
      const line = (state._predict || [])[Number(b.getAttribute("data-predict"))];
      const box = $("prompt");
      if (!line || !box) return;
      box.value = line;
      box.focus();
    });
  });
  el.querySelectorAll(".copy-code").forEach((b) => {
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = b.closest(".code-block")?.querySelector("code")?.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = "Copy"; }, 1200);
      } catch {
        setSub("Couldn't copy");
      }
    });
  });
  el.querySelectorAll(".copy-btn").forEach((b) => {
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const it = state.items[Number(b.getAttribute("data-i"))];
      if (it?.text) copyText(it.text);
    });
  });
  el.querySelectorAll("details.tool-group").forEach((d) => {
    d.addEventListener("toggle", () => {
      const key = d.getAttribute("data-key");
      if (!key) return;
      setBlockPref(key, d.open);
    });
  });
  wireThreadHolds();
  if (stick) scrollThreadToEnd(true);
  else {
    el.scrollTop = prevTop;
    updateJumpBtn();
  }
  renderTurnStatus();
  renderChips();
  renderQueue();
  syncPlanBar();
  $("btnCatchUp")?.classList.toggle("hidden", !(state.catchUpIndex >= 0));
  if (!$("findBar")?.classList.contains("hidden")) refreshFindCount();
}

function parseDiffClient(content) {
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
function shortFile(p) {
  const parts = String(p || "").split(/[/\\]/).filter(Boolean);
  return parts.slice(-2).join("/") || "file";
}
function diffLineHtml(text, cls, start) {
  const lines = String(text || "").replace(/\n$/, "").split("\n");
  if (!String(text || "").trim()) return "";
  return lines.slice(0, 40).map((line, i) => {
    const n = start ? start + i : "";
    return `<div class="diff-line ${cls}"><span class="diff-n">${n}</span><span class="diff-t">${escapeHtml(line)}</span></div>`;
  }).join("");
}
function editDiffHtml(it) {
  const body = (it.diff || []).map((d) => {
    const hunks = (d.hunks || []).map((h) => {
      const before = h.before || [];
      const oldStart = h.oldLine ? Math.max(1, h.oldLine - before.length) : 0;
      return diffLineHtml(before.join("\n"), "ctx", oldStart) +
        diffLineHtml(h.old, "del", h.oldLine || 0) +
        diffLineHtml(h.neu, "add", h.newLine || 0) +
        diffLineHtml((h.after || []).join("\n"), "ctx", h.newLine ? h.newLine + String(h.neu || "").split("\n").length : 0);
    }).join("");
    return hunks;
  }).join("");
  const title = "Edit " + shortFile(it.diff?.[0]?.path || it.detail || "");
  const key = "edit:" + (it.id || shortFile(it.diff?.[0]?.path || it.detail || it._i));
  const open = blockOpen(key, state.blockPref?.get("edit:*") !== "closed");
  const copy = encodeURIComponent(diamondCopyText(it.diff?.[0]?.path || it.detail, title));
  return `${catchUpDivider(it)}<div class="edit-block${open ? "" : " collapsed"}" data-block="${escapeHtml(key)}" data-copy="${copy}" data-i="${it._i}"><button type="button" class="diamond-toggle"><span class="mark">◆</span> ${escapeHtml(title)}</button><div class="diff">${body}</div></div>`;
}
function diamondBlock(key, label, body, openDefault, extraClass, copyPlain, live, index) {
  const open = blockOpen(key, openDefault);
  const inner = body ? `<div class="diamond-body">${body}</div>` : "";
  const cls = "diamond-block" + (extraClass ? " " + extraClass : "") + (open ? "" : " collapsed");
  const copy = encodeURIComponent(diamondCopyText(copyPlain, label));
  const idx = index != null && index !== "" ? ` data-i="${index}"` : "";
  return `<div class="${cls}" data-block="${escapeHtml(key)}" data-copy="${copy}"${live ? " data-live=\"1\"" : ""}${idx}><button type="button" class="diamond-toggle"><span class="mark">◆</span> ${escapeHtml(label)}</button>${inner}</div>`;
}
function renderTaskRow(it) {
  const failed = it.phase === "done" && Number(it.exitCode) > 0;
  const dur = it.phase === "done" && it.durationMs ? " in " + fmtElapsed(it.durationMs) : "";
  const label = it.phase === "started"
    ? "Task started: " + (it.text || "command")
    : "Task completed" + dur + ": " + (it.text || "command");
  const cmd = String(it.command || "").trim();
  const key = "task:" + (it.id || it._i) + ":" + (it.phase || "");
  return catchUpDivider(it) + diamondBlock(key, label, cmd ? escapeHtml(cmd) : "", false, failed ? "bad" : "", cmd || label, false);
}
function fileBase(s) {
  const parts = String(s || "").split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || "";
}
function capWord(w) {
  const s = String(w || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
function englishToolName(raw) {
  const name = String(raw || "").trim();
  if (!name.includes("__")) return "";
  const parts = name.split("__");
  const server = parts[0].split("-").map((w, i) => (i === 0 ? capWord(w) : w)).join("-");
  const tool = parts.slice(1).join(" ").split(/[_\s]+/).filter(Boolean).map(capWord).join(" ");
  return (server + " " + tool).trim();
}
function runStatusLabel(it) {
  const eng = englishToolName(it?.toolName);
  if (!eng) return toolLineLabel(it);
  const space = eng.indexOf(" ");
  if (space < 0) return "Run " + eng;
  return "Run (" + eng.slice(0, space) + ") " + eng.slice(space + 1);
}
function toolDurationSuffix(it) {
  const start = Number(it?.startedAt || 0);
  const end = Number(it?.endedAt || 0);
  if (!start || !end || end < start) return "";
  if (!/complete|success|ok|done|fail|error/i.test(String(it.status || ""))) return "";
  return " · " + fmtElapsed(end - start);
}
function toolDisplayLabel(it) {
  return toolLineLabel(it) + toolDurationSuffix(it);
}
function spokenStep(it) {
  const eng = englishToolName(it?.toolName);
  if (eng) {
    const space = eng.indexOf(" ");
    return space < 0 ? eng : eng.slice(space + 1);
  }
  return toolLineLabel(it).replace(/^Run\s+/i, "").slice(0, 80);
}
function maybeSpeakStep(it) {
  if (!state.speakSteps || !it) return;
  if (state._openingSession || state._loadingHistory || state.speaking) return;
  const line = spokenStep(it);
  if (!line || line === state._lastSpokenStep) return;
  state._lastSpokenStep = line;
  void speakText(line);
}
function toolLineLabel(it) {
  const eng = englishToolName(it.toolName);
  if (eng) return eng;
  const kind = toolGroupKind(it);
  const file = fileBase(it.detail) || fileBase(it.title);
  if (kind === "execute") {
    if (it.blurb) return "Run " + it.blurb;
    const cmd = String(it.detail || "").split("\n")[0].replace(/\s+/g, " ").trim();
    return (cmd || "command").slice(0, 72);
  }
  if (kind === "read") {
    let range = "";
    if (it.offset && it.limit) range = " (" + (Number(it.offset) + 1) + "-" + (Number(it.offset) + Number(it.limit)) + ")";
    return "Read " + (file || "a file") + range;
  }
  if (kind === "search") {
    const pat = String(it.pattern || it.detail || it.title || "").replace(/^Search\s+/i, "").slice(0, 72);
    return 'Search "' + pat + '"';
  }
  if (kind === "edit") return "Edit " + (file || "a file");
  const title = String(it.title || "Tool").trim();
  return title.length > 64 ? title.slice(0, 62) + "…" : title;
}
function renderToolRow(it) {
  if (it.hidden) return "";
  const m = toolMark(it);
  if (it.diff?.length) return editDiffHtml(it);
  const failed = /fail|error/i.test(String(it.status || ""));
  const retry = failed
    ? `<button type="button" class="retry-btn" data-i="${it._i}">Retry</button>`
    : "";
  const detail = String(it.detail || "").trim();
  const plain = toolLineLabel(it);
  const label = toolDisplayLabel(it);
  const body = detail && detail !== plain && detail !== label ? escapeHtml(detail) : "";
  const key = "tool:" + (it.id || it._i);
  const running = !/complete|success|ok|done|fail|error/i.test(String(it.status || ""));
  return `${catchUpDivider(it)}${diamondBlock(key, label, body, running, m.cls, detail || plain, running, it._i)}${retry}`;
}

function toolGroupKind(it) {
  const t = String(it.title || it.toolKind || "").toLowerCase();
  if (/\bexecute\b|\bbash\b|\bshell\b|\brun_terminal\b|\bterminal_command\b/.test(t)) return "execute";
  if (/\bsearch_replace\b|\bstr_replace\b|^edit\b|\bedits?\b|\bwrites?\b|\bwrite_file\b/.test(t)) return "edit";
  if (t === "search_tool" || /\bsearch_tool\b/.test(t)) return "mcp";
  if (/\bgrep\b|\bglob\b|\bsearch\b/.test(t)) return "search";
  if (/^read\b|\bread_file\b|\breadfile\b/.test(t)) return "read";
  return null;
}

function groupLabel(kind, n) {
  if (kind === "read") return `Read ${n} file${n === 1 ? "" : "s"}`;
  if (kind === "search") return `Searched ${n} pattern${n === 1 ? "" : "s"}`;
  if (kind === "edit") return n === 1 ? "Wrote 1 file" : `Wrote ${n} files`;
  if (kind === "execute") return n === 1 ? "Execute" : `Execute ${n}`;
  return `${n} tools`;
}

function groupedItems(items) {
  const out = [];
  let buf = [];
  let bufKey = null;
  const flush = () => {
    if (!buf.length) return;
    const kind = bufKey;
    const collapseOne = kind === "edit" && !buf.some((i) => i.diff?.length);
    if (kind === "lookup") {
      const counts = { read: 0, search: 0, mcp: 0 };
      const order = [];
      for (const item of buf) {
        const gk = toolGroupKind(item);
        if (!counts[gk] && counts[gk] !== 0) continue;
        if (!order.includes(gk)) order.push(gk);
        counts[gk]++;
      }
      const phrase = (gk) => {
        const n = counts[gk];
        if (gk === "read") return "Read " + n + " file" + (n === 1 ? "" : "s");
        if (gk === "search") return "Searched " + n + " pattern" + (n === 1 ? "" : "s");
        if (gk === "mcp") return "Searched " + n + " MCP tool" + (n === 1 ? "" : "s");
        return "";
      };
      const bits = order.map(phrase).filter(Boolean);
      out.push({
        kind: "toolgroup",
        group: "lookup",
        label: bits.join(", "),
        items: buf.slice(),
        key: "lookup:" + (buf[0].id || buf[0].title || "g"),
      });
      buf = [];
      bufKey = null;
      return;
    }
    if (kind === "ran") {
      out.push({
        kind: "toolgroup",
        group: "ran",
        label: "Ran " + buf.length + " command" + (buf.length === 1 ? "" : "s"),
        items: buf.slice(),
        key: "ran:" + (buf[0].id || buf[0].title || "g"),
      });
      buf = [];
      bufKey = null;
      return;
    }
    if (kind && (buf.length >= 2 || collapseOne)) {
      out.push({
        kind: "toolgroup",
        group: kind,
        items: buf.slice(),
        key: kind + ":" + (buf[0].id || buf[0].title || "g"),
      });
    } else out.push(...buf);
    buf = [];
    bufKey = null;
  };
  for (const it of items) {
    if (it.hidden) continue;
    const rawKind = it.kind === "tool" && !(it.diff && it.diff.length) ? toolGroupKind(it) : null;
    const k = rawKind === "read" || rawKind === "search" || rawKind === "mcp" ? "lookup" : rawKind === "execute" ? (it.blurb ? null : "ran") : rawKind;
    if (k && bufKey === k) buf.push(it);
    else {
      flush();
      if (k) {
        buf = [it];
        bufKey = k;
      } else out.push(it);
    }
  }
  flush();
  return foldRepeats(out);
}
function foldRepeats(list) {
  const out = [];
  let buf = [];
  const flush = () => {
    if (buf.length >= 2) {
      const label = toolLineLabel(buf[0]);
      out.push({
        kind: "toolgroup",
        group: "repeat",
        label: label + " × " + buf.length,
        items: buf.slice(),
        key: "repeat:" + (buf[0].id || label),
      });
    } else if (buf.length === 1) out.push(buf[0]);
    buf = [];
  };
  for (const it of list) {
    if (it.kind !== "tool" || (it.diff && it.diff.length)) {
      flush();
      out.push(it);
      continue;
    }
    const key = toolLineLabel(it);
    if (buf.length && toolLineLabel(buf[0]) === key) buf.push(it);
    else {
      flush();
      buf = [it];
    }
  }
  flush();
  return out;
}

function renderToolGroup(g) {
  const key = g.key || g.items[0]?.id || g.group;
  const running = g.items.some((i) => !/complete|success|ok|done|fail|error/i.test(String(i.status || "")));
  const label = g.label || groupLabel(g.group, g.items.length);
  const body = `<div class="tool-group-list">${g.items.map(renderToolRow).join("")}</div>`;
  return diamondBlock(key, label, body, running, "", label, running);
}

function predictedReplies(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out = [];
  const say = t.match(/say if you want (?:the )?([^.]{4,90})/i);
  if (say) out.push(("Yes, " + say[1]).replace(/\s+/g, " ").replace(/[.\s]+$/, ""));
  const next = t.match(/next(?: useful piece)? is \*\*([^*]{4,80})\*\*/i) || t.match(/\bnext is ([^.]{4,80})/i);
  if (next) {
    const bit = next[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    out.push("Yes, do the " + bit.replace(/^the /i, ""));
  }
  return [...new Set(out)].filter((s) => s.length > 6 && s.length < 140).slice(0, 2);
}
function predictHtml() {
  if (state.turn?.active) return "";
  const last = lastAgentItem();
  if (!last || last.live) return "";
  const lines = state.suggestion ? [state.suggestion] : predictedReplies(last.text);
  state._predict = lines;
  if (!lines.length) return "";
  return lines.map((line, i) => `<button type="button" class="predict" data-predict="${i}">${escapeHtml(line)}</button>`).join("");
}
function lastAgentItem() {
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (state.items[i].kind === "agent") return state.items[i];
  }
  return null;
}

let renderRaf = 0;
function scheduleRender() {
  dismissUndoIfStarted();
  if (state.view !== "thread") return;
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    renderThread();
  });
}

function textOf(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.text) return content.text;
  if (Array.isArray(content)) return content.map(textOf).join("");
  return "";
}

function lastContentItem() {
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (state.items[i].kind !== "wait") return state.items[i];
  }
  return null;
}

function stripRemotePrefix(t) {
  return String(t || "").replace(/^\[Grok Remote\]\s*/i, "");
}

function ensureWaiting(label) {
  state.waiting = true;
  const last = state.items[state.items.length - 1];
  if (last && last.kind === "wait") {
    last.text = label || "Waiting…";
    return;
  }
  state.items.push({ kind: "wait", text: label || "Waiting…" });
}

function clearWaiting() {
  state.waiting = false;
  if (!state.items.some((x) => x.kind === "wait")) return;
  const last = state.items[state.items.length - 1];
  if (last && last.kind === "wait") state.items.pop();
  else state.items = state.items.filter((x) => x.kind !== "wait");
}

let turnClock = null;
function startTurnClock() {
  if (turnClock) return;
  turnClock = setInterval(() => {
    if (!state.turn.active || state.view !== "thread") return;
    const tEl = $("turnStatusTime");
    if (tEl) tEl.textContent = fmtElapsed(Date.now() - (state.turn.phaseAt || state.turn.startedAt || Date.now()));
  }, 200);
}
function stopTurnClock() {
  if (turnClock) {
    clearInterval(turnClock);
    turnClock = null;
  }
}
function renderTurnStatus() {
  const bar = $("turnStatus");
  if (!bar) return;
  const on = !!(state.turn && state.turn.active && state.view === "thread");
  bar.classList.toggle("hidden", !on);
  syncLiveChip();
  if (!on) return;
  $("turnStatusLabel").textContent = turnStatusLabel();
  $("turnStatusTime").textContent = fmtElapsed(Date.now() - (state.turn.phaseAt || state.turn.startedAt || Date.now()));
}
function liveCompact() {
  const items = state.items || [];
  let compact = null;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "compact") { compact = items[i]; break; }
  }
  if (!compact?.live) return null;
  const idx = items.indexOf(compact);
  for (let i = idx + 1; i < items.length; i++) {
    if (items[i].kind === "agent") return null;
  }
  const age = Date.now() - (Number(compact.startedAt) || Date.now());
  if (age > 5 * 60 * 1000) return null;
  return compact;
}
function turnStatusLabel() {
  const running = (state.items || []).filter(toolStillRunning);
  const edits = running.filter((it) => toolGroupKind(it) === "edit" || it.diff?.length);
  if (edits.length) return "Writing edit (" + edits.length + ")…";
  if (running.length) return runStatusLabel(running[running.length - 1]);
  if (liveCompact()) return "Compacting...";
  if (state.turn?.phase === "thinking" || currentThinkItem()) return "Thinking...";
  return state.turn?.label || "Waiting for response…";
}
function resumeTurnFromItems() {
  if (!turnStillGoing()) return;
  const running = (state.items || []).filter(toolStillRunning);
  const edits = running.filter((it) => toolGroupKind(it) === "edit" || it.diff?.length);
  const compact = liveCompact();
  if (edits.length) noteActivity("tool", "Writing edit (" + edits.length + ")…");
  else if (running.length) noteActivity("tool", statusLabelForTool(running[running.length - 1].title));
  else if (compact) noteActivity("compact", "Compacting…", compact.startedAt);
  else if (currentThinkItem()) noteActivity("thinking", "Thinking…");
}
function noteActivity(phase, label, at) {
  const now = Date.now();
  if (!state.turn) state.turn = {};
  if (!state.turn.active) {
    state.turn.active = true;
    state.turn.startedAt = Number(at) || now;
    startTurnClock();
  }
  if (state.turn.phase !== phase || state.turn.label !== label) {
    state.turn.phase = phase;
    state.turn.label = label;
    state.turn.phaseAt = Number(at) || now;
  }
  state.waiting = phase === "waiting";
  setKeepAwake(true);
  renderTurnStatus();
  clearTimeout(state._turnIdle);
  const delay = /wait|think|writ|tool|compact/i.test(phase || "") ? 180000 : 30000;
  state._turnIdle = setTimeout(() => {
    const running = state.items.some(toolStillRunning);
    if (running || liveCompact() || /wait|think|writ|tool|compact/i.test(state.turn.phase || "")) return;
    endTurn({ notify: false });
  }, delay);
}
function endTurn(opts = {}) {
  clearTimeout(state._turnIdle);
  const wasActive = !!(state.turn && state.turn.active);
  const started = state.turn && state.turn.startedAt;
  const sid = state.sessionId;
  if (state.turn) {
    state.turn.active = false;
    state.turn.phase = "";
    state.turn.label = "";
  }
  state.busy = false;
  state.waiting = false;
  setKeepAwake(false);
  stopTurnClock();
  const last = lastContentItem();
  if (last && last.kind === "think") last.live = false;
  const agent = lastAgentItem();
  if (agent) {
    agent.live = false;
    if (started) agent.workedMs = Date.now() - started;
  }
  renderTurnStatus();
  if (state.view === "thread") scheduleRender();
  if (
    opts.notify !== false &&
    wasActive &&
    started &&
    Date.now() - started > 2500 &&
    !state._openingSession
  ) {
    const summary = clipNotify(agent?.text || "", 280) || notifyCaption(sid);
    const name = notifySessionName(sid);
    void pushNotify(
      name,
      summary || "Grok finished this pass",
      sid,
      "done"
    );
  }
}
function lastTurnHint(id) {
  const row = (state.sessions || []).find((s) => s.sessionId === (id || state.sessionId));
  return row?.lastTurnSummary || "";
}

function absorbText(last, t) {
  if (!t) return true;
  if (!last) return false;
  if (last.text.endsWith(t)) return true;
  if (t.startsWith(last.text) && t.length > last.text.length) {
    last.text = t;
    return true;
  }
  last.text += t;
  return true;
}

function rememberPrompt(text, source) {
  const t = stripRemotePrefix(text).trim();
  if (!t) return;
  const src = source === "app" ? "app" : "pc";
  state.prompts = state.prompts.filter((p) => p.text !== t);
  state.prompts.unshift({ text: t, source: src });
  if (state.prompts.length > 80) state.prompts.length = 80;
}

function adoptPrompts(incoming) {
  if (!Array.isArray(incoming) || !incoming.length) return;
  const byText = new Map();
  for (const p of [...incoming, ...(state.prompts || [])]) {
    const text = stripRemotePrefix(p?.text || "").trim();
    if (!text) continue;
    const src = p.source === "app" ? "app" : "pc";
    const prev = byText.get(text);
    if (!prev || (src === "app" && prev.source !== "app")) {
      byText.set(text, { text, source: src });
    }
  }
  const seen = new Set();
  const out = [];
  for (const p of incoming) {
    const text = stripRemotePrefix(p?.text || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(byText.get(text) || { text, source: p.source === "app" ? "app" : "pc" });
  }
  for (const p of state.prompts || []) {
    const text = stripRemotePrefix(p?.text || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(byText.get(text) || p);
  }
  state.prompts = out.slice(0, 80);
}

function mergeUserText(t) {
  const source = /^\[Grok Remote\]\s*/i.test(String(t || "")) ? "app" : "pc";
  const incoming = stripRemotePrefix(t);
  if (!incoming) return;
  const last = lastContentItem();
  if (last && last.kind === "user") {
    const have = stripRemotePrefix(last.text);
    if (have === incoming || have.endsWith(incoming)) return;
    if (incoming.startsWith(have) || incoming.endsWith(have)) {
      last.text = incoming.length > have.length ? incoming : have;
      last.source = last.source || source;
      return;
    }
    last.text += incoming;
    last.at = last.at || Date.now();
    return;
  }
  state.items.push({ kind: "user", text: incoming, source, at: Date.now() });
  rememberPrompt(incoming, source);
}

function seenEvent(id) {
  if (!id) return false;
  if (!state.seenIds) state.seenIds = new Set();
  if (state.seenIds.has(id)) return true;
  state.seenIds.add(id);
  if (state.seenIds.size > 5000) {
    state.seenIds = new Set([...state.seenIds].slice(-2500));
  }
  return false;
}

function statusLabelForTool(title) {
  const t = String(title || "").trim();
  if (!t) return "Working…";
  if (/search_replace|str_replace/i.test(t)) return "edit";
  return t;
}

function applyUpdate(u, extraId) {
  if (!u) return;
  if (u.update && u.update.sessionUpdate) u = u.update;
  const eid = extraId || u._meta?.eventId || u.eventId || "";
  if (eid && seenEvent(eid)) return;
  const kind = u.sessionUpdate;
  const now = Date.now();
  if (kind === "user_message_chunk") {
    const lastThink = lastContentItem();
    if (lastThink && lastThink.kind === "think") {
      lastThink.live = false;
      if (lastThink.startedAt) lastThink.durationMs = now - lastThink.startedAt;
    }
    mergeUserText(textOf(u.content));
  } else if (kind === "prompt_suggestion" || kind === "suggestion") {
    const sug = textOf(u.content) || u.text || u.suggestion || "";
    if (sug.trim()) state.suggestion = sug.trim();
  } else if (kind === "agent_message_chunk") {
    const lastThink = lastContentItem();
    if (lastThink && lastThink.kind === "think") {
      lastThink.live = false;
      if (lastThink.startedAt) lastThink.durationMs = now - lastThink.startedAt;
    }
    const t = textOf(u.content);
    const last = lastContentItem();
    const ts = u._meta?.agentTimestampMs || now;
    if (last && last.kind === "agent") {
      absorbText(last, t);
      last.at = ts;
      last.live = true;
      if (state.turn.startedAt) last.workedMs = now - state.turn.startedAt;
    } else {
      state.items.push({
        kind: "agent",
        text: t,
        at: ts,
        live: true,
        turnStart: state.turn.startedAt || ts,
        workedMs: state.turn.startedAt ? now - state.turn.startedAt : 0,
      });
    }
    noteActivity("writing", "Writing…");
  } else if (kind === "agent_thought_chunk") {
    const t = textOf(u.content);
    const last = lastContentItem();
    if (last && last.kind === "think") {
      last.text += t;
      last.live = true;
    } else {
      state.items.push({ kind: "think", text: t, startedAt: now, live: true });
    }
    noteActivity("thinking", "Thinking…");
  } else if (kind === "tool_call") {
    const lastThink = lastContentItem();
    if (lastThink && lastThink.kind === "think") {
      lastThink.live = false;
      if (lastThink.startedAt) lastThink.durationMs = now - lastThink.startedAt;
    }
    const id = u.toolCallId;
    const existing = id && state.items.find((x) => x.kind === "tool" && x.id === id);
    const title = u.title || u.kind || id;
    const names = toolLabel(u) || title;
    if (isPlanExitTool(names)) {
      noteActivity("waiting", "Review the plan");
      presentPlanReady(state.sessionId);
      return;
    }
    if (isPlanEnterTool(names)) {
      noteActivity("tool", "Planning…");
      return;
    }
    if (existing) {
      if (u.status) existing.status = u.status;
      if (u.title) existing.title = u.title;
    } else {
      state.items.push({
        kind: "tool",
        id,
        title,
        status: u.status || "running",
        detail: toolDetailClient(u),
        offset: Number((u.rawInput || {}).offset) || 0,
        limit: Number((u.rawInput || {}).limit) || 0,
        pattern: String((u.rawInput || {}).pattern || ""),
        toolName: String((u.rawInput || {}).tool_name || ""),
        blurb: String((u.rawInput || {}).description || "").trim(),
        startedAt: Date.now(),
      });
      const added = state.items[state.items.length - 1];
      if (added && added.kind === "tool" && added.id === id) maybeSpeakStep(added);
    }
    noteActivity("tool", statusLabelForTool(title));
  } else if (kind === "tool_call_update") {
    const card = [...state.items].reverse().find((x) => x.kind === "tool" && x.id === u.toolCallId);
    if (card) {
      card.status = u.status || card.status;
      if (u.title) card.title = u.title;
      const diff = parseDiffClient(u.content);
      if (diff) card.diff = diff;
      card.endedAt = Date.now();
      const blurb = descOfClient(u.content);
      if (blurb && !card.blurb) card.blurb = blurb;
      const st = String(card.status || "");
      if (state.turn.active && !/complete|success|ok|done|fail|error/i.test(st)) {
        noteActivity("tool", statusLabelForTool(card.title));
      }
      if (/fail|error/i.test(st) && /bash|shell|terminal|edit|write|search_replace|str_replace/i.test(String(card.title || "")) && !state._openingSession && !state._loadingHistory) {
        void pushNotify(
          "Grok hit a problem",
          clipNotify(notifySessionName() + " — " + (card.title || "a step") + " failed", 160),
          state.sessionId,
          "error"
        );
      }
    }
  } else if (kind === "task_backgrounded" || kind === "task_completed") {
    const snap = u.task_snapshot || {};
    const id = u.tool_call_id || snap.task_id || u.task_id || "";
    const text = String(u.description || snap.description || "").trim() || "command";
    for (const it of state.items) {
      if (it.kind === "tool" && id && it.id === id) it.hidden = true;
    }
    const command = String(u.command || snap.command || "").trim();
    if (kind === "task_backgrounded") {
      state.items.push({ kind: "task", phase: "started", id, text, command, at: now });
    } else {
      const started = [...state.items].reverse().find((it) => it.kind === "task" && it.phase === "started" && it.id === id);
      const durationMs = started?.at && now >= started.at ? now - started.at : 0;
      state.items.push({
        kind: "task",
        phase: "done",
        id,
        text,
        command: command || started?.command || "",
        at: now,
        durationMs,
        exitCode: snap.exit_code,
      });
    }
  } else if (kind === "auto_compact_started") {
    const pct = Number(u.percentage) || 0;
    state.items.push({
      kind: "compact",
      text: pct ? "Context " + pct + "% full. Compacting..." : (u.reason || "Compacting..."),
      startedAt: u._meta?.agentTimestampMs || now,
      live: true,
    });
    noteActivity("compact", "Compacting…", u._meta?.agentTimestampMs || now);
  } else if (kind === "auto_compact_completed") {
    for (let i = state.items.length - 1; i >= 0; i--) {
      if (state.items[i].kind === "compact" && state.items[i].live) {
        state.items[i].live = false;
        state.items[i].elapsedMs = Number(u.elapsed_ms) || 0;
        break;
      }
    }
    if (state.turn?.phase === "compact" && !liveCompact()) endTurn({ notify: false });
  } else if (kind === "available_commands_update") {
    state.commands = u.availableCommands || [];
  } else if (kind === "current_mode_update") {
    if (u.currentModeId) {
      state.mode = normalizeMode(u.currentModeId);
      renderChips();
    }
  } else if (kind === "plan") {
    const entries = (u.entries || []).map((e) => ({
      content: e.content || e.title || "",
      status: e.status || "pending",
      priority: e.priority || "",
    })).filter((e) => e.content);
    if (entries.length) {
      state.todos = entries;
      renderChips();
      const last = lastContentItem();
      const text = entries.map((e) => e.content).join("\n");
      if (!(last && last.kind === "plan" && last.text === text)) {
        state.items.push({ kind: "plan", text });
      }
    }
  }
}

let liveSource = null;
let histPoll = null;

function stopLive() {
  try { liveSource?.close(); } catch { /* ignore */ }
  liveSource = null;
  state.liveOn = false;
  if (histPoll) {
    clearInterval(histPoll);
    histPoll = null;
  }
}

function startLive(id) {
  stopLive();
  if (!id) return;
  const secret = state.pair?.secret || "";
  const url = api("/api/sessions/" + encodeURIComponent(id) + "/live?secret=" + encodeURIComponent(secret));
  try {
    liveSource = new EventSource(url);
    liveSource.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (state.sessionId !== id || state.view !== "thread") return;
      if (msg.type === "watching") {
        state.liveOn = true;
        if (!state.busy) syncHeader();
        return;
      }
      if (msg.type === "update" && msg.update) {
        applyUpdate(msg.update, msg.eventId);
        scheduleRender();
      }
    };
    liveSource.onerror = () => {
      state.liveOn = false;
    };
  } catch {
    state.liveOn = false;
  }
  let ticks = 0;
  histPoll = setInterval(() => {
    ticks++;
    if (state.view === "thread" && ticks % 4 === 0) void loadMeta(id);
    if (state.view === "thread" && ticks % 2 === 0) void loadPcQueue(id);
    if (!state.liveOn || ticks % 4 === 0) void pollHistory(id);
  }, 2000);
}

async function pollHistory(id) {
  if (state.view !== "thread" || state.sessionId !== id) return;
  try {
    const secret = state.pair?.secret || "";
    const hist = await fetch(
      api("/api/sessions/" + encodeURIComponent(id) + "/history?secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
    if (!hist?.ok || !Array.isArray(hist.items)) return;
    state.historyTrimmed = !!hist.trimmed;
    const cur = state.items.filter((i) => i.kind !== "wait");
    if (!hist.items.length) {
      state.items = [];
      scheduleRender();
      return;
    }
    const lastHist = hist.items[hist.items.length - 1];
    const lastCur = cur[cur.length - 1];
    const histKey = (lastHist?.kind || "") + ":" + (lastHist?.text || lastHist?.title || "") + ":" + hist.items.length;
    const curKey = (lastCur?.kind || "") + ":" + (lastCur?.text || lastCur?.title || "") + ":" + cur.length;
    if (histKey === curKey) return;
    const histAt = Number(lastHist?.at || lastHist?.startedAt || lastHist?.endedAt) || 0;
    const curAt = Number(lastCur?.at || lastCur?.startedAt || lastCur?.endedAt) || 0;
    if (hist.items.length < cur.length && lastCur && lastCur.kind === "user" && histAt && curAt && histAt < curAt) return;
    state.items = keepSentImages(hist.items.map((it) => ({
      ...it,
      text: it.kind === "user" ? stripRemotePrefix(it.text) : it.text,
    })));
    if (Array.isArray(hist.prompts)) adoptPrompts(hist.prompts);
    const newest = hist.items[hist.items.length - 1];
    const newestAt = Number(newest?.at || newest?.startedAt || newest?.endedAt) || 0;
    if (newest?.kind === "agent" && state._userTurnAt && newestAt >= state._userTurnAt - 1000) {
      endTurn({ notify: false });
      maybeHearReply(id, newest.text);
    } else if (newest?.kind === "tool" && (isPlanExitTool(newest.title) || isPlanExitTool(newest.toolKind))) {
      noteActivity("waiting", "Review the plan");
    } else {
      resumeTurnFromItems();
    }
    syncPlanBar();
    scheduleRender();
  } catch {
    /* ignore */
  }
}

function permPath(params) {
  const tc = params?.toolCall || {};
  const input = tc.rawInput || tc.input || {};
  return String(input.path || input.file_path || input.target_file || input.file || "").trim();
}
function permCommand(params) {
  const tc = params?.toolCall || {};
  const input = tc.rawInput || tc.input || {};
  return String(input.command || input.cmd || "").trim();
}
function permChoices(params) {
  const raw = Array.isArray(params?.options) ? params.options.slice() : [];
  const list = raw.length
    ? raw
    : [
        { optionId: "allow_always", name: "Yes, and don't ask again for anything (always-approve mode)" },
        { optionId: "allow_edits_for_session", name: "Yes, allow all edits during this session" },
        { optionId: "allow_once", name: "Yes" },
        { optionId: "reject_once", name: "No, reject" },
      ];
  const rank = (o) => {
    const id = String(o.optionId || o.id || "");
    if (/allow_always$|allow-always$/i.test(id) && !/bash|mcp|command|glob|domain/i.test(id)) return 0;
    if (/edits/i.test(id)) return 1;
    if (/allow_once|allow-once/i.test(id)) return 2;
    if (/reject_once|reject-once/i.test(id)) return 3;
    if (/reject|deny/i.test(id)) return 4;
    if (/allow/i.test(id)) return 2.5;
    return 5;
  };
  return list.slice().sort((a, b) => rank(a) - rank(b));
}
function permLabel(o) {
  const id = String(o.optionId || o.id || "");
  const name = String(o.name || o.label || "");
  const blob = id + " " + name;
  if (/edits/i.test(blob)) return "Yes, allow all edits during this session";
  if (/allow_always$|allow-always$/i.test(id) && !/bash|mcp|command|glob|domain/i.test(id)) {
    return "Yes, and don't ask again for anything (always-approve mode)";
  }
  if (/always/i.test(blob) && /allow/i.test(blob) && /anything|approve/i.test(blob)) {
    return "Yes, and don't ask again for anything (always-approve mode)";
  }
  if (/allow_once|allow-once/i.test(id) || /^yes$/i.test(name.trim())) return "Yes";
  if (/reject_always|never/i.test(blob)) return "No, never allow";
  if (/reject|deny/i.test(blob)) return "No, reject";
  return name || id;
}
function permClass(o) {
  const blob = String(o.optionId || "") + " " + String(o.name || "");
  if (/reject|deny/i.test(blob)) return "ghost";
  if (/allow_once|allow-once|^yes$/i.test(blob)) return "primary";
  return "ghost";
}
async function postPermKey(sessionId, optionId, feedback) {
  const key = {
    allow_always: "1",
    allow_edits_for_session: "2",
    allow_bash: "2",
    allow_once: "3",
    reject_once: "4",
  }[optionId] || "3";
  const secret = state.pair?.secret || "";
  const res = await fetch(
    api("/api/sessions/" + encodeURIComponent(sessionId) + "/perm-action?secret=" + encodeURIComponent(secret)),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, feedback: feedback || "" }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || "PC prompt did not take the choice");
}
function presentLivePerm(msg) {
  const id = msg.sessionId || state.sessionId;
  if (!id || !msg.toolCallId) return;
  if (state.perm?.toolCallId === msg.toolCallId) return;
  const path = String(msg.path || "").trim();
  const command = String(msg.command || "").trim();
  const isCmd = msg.kind === "command" || !!command;
  state.perm = {
    live: true,
    sessionId: id,
    toolCallId: msg.toolCallId,
    title: isCmd ? "Command" : "Edit",
    options: isCmd
      ? [
          { optionId: "allow_always", name: "Yes, and don't ask again for anything (always-approve mode)" },
          { optionId: "allow_bash", name: "Yes, and don't ask again for bash commands" },
          { optionId: "allow_once", name: "Yes" },
          { optionId: "reject_once", name: "No, reject" },
        ]
      : undefined,
    toolCall: {
      title: isCmd ? "Command" : "Edit",
      rawInput: { path, file_path: path, target_file: path, command },
    },
  };
  if (state.sessionId !== id && state.view === "roster" && document.visibilityState === "visible") {
    openSession(id);
  }
  showPermissionSheet();
  renderPerm();
  void pushNotify(
    isCmd ? "Approve command" : "Approve edit",
    notifySessionName(id) + (command ? " — " + clipNotify(command, 80) : path ? " — " + path : isCmd ? " — Allow this command?" : " — Allow Edit?"),
    id,
    "needs"
  );
}
function resolvePerm(optionId, extra) {
  if (state.perm?.live) {
    const sid = state.perm.sessionId || state.sessionId;
    const id = optionId;
    state.perm = null;
    hideSheet();
    renderPerm();
    postPermKey(sid, id, extra?.feedback).then(() => {
      setSub("Choice sent to the PC");
    }).catch((err) => {
      setSub("PC prompt: " + (err.message || err));
    });
    return;
  }
  if (!state.perm?.resolve) return;
  const payload = { outcome: { outcome: "selected", optionId } };
  if (extra?.feedback) {
    payload.outcome._meta = { feedback: extra.feedback, reject_reason: extra.feedback };
  }
  state.perm.resolve(payload);
  if (/allow_always$|allow-always$/i.test(String(optionId))) {
    state.mode = "always-approve";
    renderChips();
  }
  if (/edits/i.test(String(optionId))) {
    setSub("Edits allowed for this session");
  }
  state.perm = null;
  hideSheet();
  renderPerm();
}
function showPermissionSheet() {
  const p = state.perm;
  if (!p) return;
  const path = permPath(p);
  const cmd = permCommand(p);
  const tool = String(p.toolCall?.title || p.toolCall?.kind || p.title || "");
  const title = path
    ? "Allow Edit to " + path + "?"
    : cmd
      ? "Allow `" + clipNotify(cmd, 80) + "`?"
      : tool
        ? "Allow " + tool + "?"
        : "Grok needs a decision";
  const choices = permChoices(p);
  openSheet(title, choices.map((o) => ({
    id: o.optionId || o.id,
    label: permLabel(o),
  })), "", (id) => {
    if (/reject_once|reject-once/i.test(id) && !/always/i.test(id)) {
      openRejectFeedback(id);
      return;
    }
    resolvePerm(id);
  });
  const detail = [cmd && !path ? cmd : "", tool && path ? tool : ""].filter(Boolean).join(" · ");
  if (detail) {
    $("sheetOpts")?.insertAdjacentHTML("afterbegin", `<p class="mute">${escapeHtml(clipNotify(detail, 180))}</p>`);
  }
}
function openRejectFeedback(optionId) {
  const sheet = $("sheet");
  $("sheetTitle").textContent = "No, reject";
  $("sheetOpts").innerHTML = `<p class="mute">Optional: tell Grok why (same as typing feedback on the PC).</p>
    <input id="rejectNote" type="text" placeholder="Reason (optional)" />
    <button type="button" class="primary" id="rejectGo">Reject</button>`;
  sheet.classList.remove("hidden");
  const go = () => {
    const fb = $("rejectNote")?.value.trim() || "";
    resolvePerm(optionId, { feedback: fb });
  };
  $("rejectGo")?.addEventListener("click", go);
  $("rejectNote")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); go(); }
  });
  $("rejectNote")?.focus();
}
function renderPerm() {
  const box = $("permBox");
  const blocked = !!state.perm;
  $("composer")?.classList.toggle("blocked", blocked);
  if ($("prompt")) $("prompt").disabled = blocked;
  if ($("btnSend")) $("btnSend").disabled = blocked;
  if (!box) return;
  if (!state.perm) {
    box.classList.add("hidden");
    box.classList.remove("blocking");
    box.innerHTML = "";
    return;
  }
  box.classList.add("hidden");
  const sheetOpen = $("sheet") && !$("sheet").classList.contains("hidden");
  if (!sheetOpen) showPermissionSheet();
}

function descOfClient(content) {
  if (!content) return "";
  if (typeof content === "string") {
    try { return descOfClient(JSON.parse(content)); } catch { return ""; }
  }
  if (Array.isArray(content)) return content.map(descOfClient).filter(Boolean).join(" ").slice(0, 160);
  if (typeof content === "object") {
    if (content.text && content.type === "text") return String(content.text).slice(0, 160);
    if (content.content) return descOfClient(content.content);
  }
  return "";
}
function toolDetailClient(u) {
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
function toolLabel(u) {
  if (!u) return "";
  return [u.title, u.kind, u._meta?.["x.ai/tool"]?.name].filter(Boolean).join(" ");
}
function isPlanExitTool(name) {
  return /exit[_\s-]*plan|plan:\s*exit|exit_plan/i.test(String(name || ""));
}
function planAwaitingReview() {
  const tools = (state.items || []).filter((it) => it.kind === "tool");
  const last = tools[tools.length - 1];
  if (!last) return false;
  if (/complete|success|ok|done|fail|error/i.test(String(last.status || ""))) return false;
  return isPlanExitTool(last.title) || isPlanExitTool(last.toolKind);
}
function syncPlanBar() {
  const bar = $("planBar");
  if (!bar) return;
  const on = state.view === "thread" && planAwaitingReview();
  bar.classList.toggle("hidden", !on);
  if (on) presentPlanReady(state.sessionId);
}
function isPlanEnterTool(name) {
  return /enter[_\s-]*plan/i.test(String(name || ""));
}
function isPlanGateTool(name) {
  return isPlanExitTool(name) || isPlanEnterTool(name);
}
function presentPlanReady(sid) {
  const id = sid || state.sessionId;
  if (!id) return;
  if (state._planShownAt && state._planOpenFor === id && Date.now() - state._planShownAt < 15000) return;
  state._planShownAt = Date.now();
  state._planOpenFor = id;
  setSub("Review the plan");
  void openPlanPreview({ user: true });
  void pushNotify(
    "Plan ready",
    notifySessionName(id) + " — review the plan to continue",
    id,
    "needs"
  );
}
function isAskUserTool(name) {
  return /ask_user_question/i.test(String(name || ""));
}
function askUserQuestions(params) {
  const input = params?.toolCall?.rawInput || params?.toolCall?.input || params || {};
  const qs = input.questions || params?.questions;
  return Array.isArray(qs) ? qs : [];
}
function presentAskUser(params) {
  const questions = askUserQuestions(params);
  if (!questions.length) {
    return Promise.resolve({ answers: [] });
  }
  return new Promise((resolve) => {
    const q = questions[0];
    const opts = (q.options || []).map((o, i) => ({
      id: String(o.label || o.id || i),
      label: o.label || o.id || "Option " + (i + 1),
    }));
    if (q.allow_other !== false) opts.push({ id: "__other__", label: "Other…" });
    showView("thread");
    state.askResolve = (payload) => {
      state.askResolve = null;
      resolve(payload);
    };
    openSheet(q.question || "Grok has a question", opts, "", (id) => {
      const finish = (label) => {
        if (state.askResolve) {
          state.askResolve({
            answers: [{ question: q.question, selected: [label] }],
            selected: [label],
          });
        }
      };
      if (id === "__other__") {
        openSheet("Other", [], "", () => {});
        $("sheetOpts").innerHTML = `<input id="askOther" type="text" placeholder="Your answer" />
          <button type="button" class="primary" id="askOtherGo">Send</button>`;
        $("askOtherGo")?.addEventListener("click", () => {
          const t = $("askOther")?.value.trim() || "Other";
          hideSheet();
          finish(t);
        });
        $("askOther")?.focus();
        return;
      }
      const picked = opts.find((o) => o.id === id);
      finish(picked?.label || id);
    });
    void pushNotify(
      "Question from Grok",
      clipNotify(notifySessionName() + " — " + (q.question || "Needs an answer"), 160),
      state.sessionId,
      "needs"
    );
  });
}
function permOptionId(pred, fallback) {
  const opts = state.perm?.options || [];
  const hit = opts.find((o) => pred(String(o.optionId || "") + " " + String(o.name || "")));
  return hit?.optionId || fallback;
}
function hidePlanSheet() {
  $("planSheet")?.classList.add("hidden");
  $("planBar")?.classList.add("hidden");
}
function planPromptAllowed() {
  if (state._openingSession || state._loadingHistory) return false;
  if (state._prompting) return true;
  if (state._userTurnAt && state._openedAt && state._userTurnAt > state._openedAt) return true;
  return false;
}
async function openPlanPreview(opts = {}) {
  const sheet = $("planSheet");
  if (!sheet) return;
  if (!opts.user && !planPromptAllowed()) return;
  showView("thread");
  sheet.classList.remove("hidden");
  $("planTitle").textContent = "Review plan";
  $("planBody").innerHTML = `<p class="mute">Loading plan…</p>`;
  const secret = state.pair?.secret || "";
  const id = state.sessionId;
  let data = { ok: false, markdown: "", empty: true };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      data = await fetch(
        api("/api/sessions/" + encodeURIComponent(id) + "/plan?secret=" + encodeURIComponent(secret)),
        { cache: "no-store" }
      ).then((r) => r.json());
    } catch (err) {
      data = { ok: false, markdown: "", empty: true, error: err.message };
    }
    if (data.markdown) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  state.planMarkdown = data.markdown || "";
  $("planTitle").textContent = state.planMarkdown ? "Review plan" : "No plan written yet";
  $("planBody").innerHTML = state.planMarkdown
    ? renderMarkdown(state.planMarkdown)
    : `<p class="mute">${escapeHtml(data.error || "No plan written yet.")}</p>`;
  $("planBody").scrollTop = 0;
  sheet.classList.remove("hidden");
}
async function postPlanAction(action) {
  const secret = state.pair?.secret || "";
  const id = state.sessionId;
  if (!id) throw new Error("no session");
  const res = await fetch(
    api("/api/sessions/" + encodeURIComponent(id) + "/plan-action?secret=" + encodeURIComponent(secret)),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || "plan action failed");
}

async function resolvePlan(action) {
  try {
    await postPlanAction(action);
  } catch (err) {
    setSub("Plan action failed: " + (err.message || err));
  }
  if (action === "revise") {
    hidePlanSheet();
    if ($("prompt")) {
      $("prompt").disabled = false;
      $("prompt").focus();
    }
    $("composer")?.classList.remove("blocked");
    setSub("Type revision notes, then send. The PC plan view is ready for them.");
    return;
  }
  const pending = state.perm?.resolve;
  if (pending) {
    const id =
      action === "approve"
        ? permOptionId((s) => /allow/i.test(s), "allow-once")
        : permOptionId((s) => /reject|deny|quit|cancel/i.test(s), "reject");
    try {
      pending({ outcome: { outcome: "selected", optionId: id } });
    } catch { /* already resolved */ }
    state.perm = null;
    renderPerm();
  }
  if (state.planExt?.resolve) {
    const outcome =
      action === "approve" ? "approved" : action === "quit" ? "abandoned" : "rejected";
    try {
      state.planExt.resolve({ outcome, feedback: "" });
    } catch { /* already resolved */ }
    state.planExt = null;
  }
  hidePlanSheet();
  setSub(action === "quit" ? "Quit plan on PC" : "Approved on PC");
}

async function handshake(acp) {
  if (!acp) throw new Error("ACP client missing");
  const init = await acp.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      _meta: { "x.ai/planApproval": true },
    },
    clientInfo: { name: "grok-remote", title: "Grok Remote", version: APP_VERSION },
  }, 30000);
  const methods = init?.authMethods || [];
  const defaultId = init?._meta?.defaultAuthMethodId;
  const cached = methods.find((m) => m && m.id === "cached_token");
  const methodId = cached?.id || defaultId || "cached_token";
  try {
    await acp.request("authenticate", { methodId }, 5000);
  } catch {
    /* Live TUI is already signed in; resume still works. */
  }
  return init;
}

async function ensureAcp() {
  if (state.acp?.ready) return state.acp;
  await connect();
  if (!state.acp?.ready) throw new Error("Not connected to Grok on this PC");
  return state.acp;
}

function normalizeRosterRow(s) {
  if (!s) return null;
  const id = s.sessionId || s.session_id;
  if (!id) return null;
  return {
    sessionId: id,
    title: s.title || s.generated_title || "Untitled",
    cwd: s.cwd || "",
    updatedAt: s.updatedAt || s.updated_at || null,
    activity: s.activity || (s.resident ? "live" : "idle"),
    resident: !!s.resident,
    lastTurnSummary: s.lastTurnSummary || s.last_turn_summary || "",
    lastCaption: s.lastCaption || "",
    modelId: s.modelId || s.current_model_id || null,
    effort: s.effort || s.reasoningEffort || s.reasoning_effort || "",
    planMode: s.planMode || "",
  };
}
const USAGE_SEG_OPACITY = [1, 0.75, 0.55, 0.4, 0.28];
const USAGE_SEG_COLOR = "26,94,255";

function formatResetShort(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
function formatResetLong(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function startAccountUsagePoll() {
  if (state._acctUsageTimer) return;
  state._acctUsageTimer = setInterval(() => {
    if (state.pair?.secret) void loadAccountUsage();
  }, 90000);
}
async function loadAccountUsage({ force = false } = {}) {
  try {
    const secret = state.pair?.secret;
    if (!secret) return;
    const q = force ? "&force=1" : "";
    const res = await fetch(api("/api/account/usage?secret=" + encodeURIComponent(secret) + q), { cache: "no-store" });
    const data = await res.json();
    state.accountUsage = data && data.ok ? data : null;
  } catch {
    state.accountUsage = null;
  }
  renderAccountUsage();
}
function renderAccountUsage() {
  const btn = $("acctUsageBtn");
  const card = $("usageCard");
  const snap = state.accountUsage;
  const usedRaw = snap?.ok ? snap.usedPercent : null;
  const known = usedRaw != null && Number.isFinite(Number(usedRaw));
  const used = known ? Number(usedRaw) : null;
  const pct = known ? Math.round(used) : null;
  if (btn) {
    btn.classList.toggle("hidden", !known);
    btn.classList.toggle("nag", known && pct >= 80);
    btn.classList.toggle("hot", known && pct >= 90);
    if (known) {
      btn.textContent = pct + "%";
      const reset = formatResetShort(snap.resetsAt);
      btn.title = reset ? pct + "% used · resets " + reset : pct + "% used";
      btn.setAttribute("aria-label", btn.title);
    } else {
      btn.textContent = "—";
      btn.title = "Weekly SuperGrok usage";
    }
  }
  if (!card) return;
  if (!snap?.ok || !known) {
    card.classList.add("hidden");
    card.innerHTML = "";
    return;
  }
  const remain = snap.remainingPercent != null && Number.isFinite(Number(snap.remainingPercent))
    ? Math.round(Number(snap.remainingPercent))
    : Math.max(0, 100 - pct);
  const products = Array.isArray(snap.products) ? snap.products.filter((p) => p && Number(p.percent) > 0) : [];
  const segs = products.length
    ? products
    : [{ id: "used", label: "Used", percent: used }];
  const bar = segs.map((p, i) => {
    const op = USAGE_SEG_OPACITY[i] ?? USAGE_SEG_OPACITY[USAGE_SEG_OPACITY.length - 1];
    const w = Math.max(0, Number(p.percent) || 0);
    return `<div class="seg" style="width:${w}%;background:rgba(${USAGE_SEG_COLOR},${op})"></div>`;
  }).join("");
  const legend = segs.map((p, i) => {
    const op = USAGE_SEG_OPACITY[i] ?? USAGE_SEG_OPACITY[USAGE_SEG_OPACITY.length - 1];
    const n = Math.round(Number(p.percent) || 0);
    return `<span><i class="dot" style="background:rgba(${USAGE_SEG_COLOR},${op})"></i>${escapeHtml(p.label || p.id)} ${n}%</span>`;
  }).join("");
  const reset = formatResetLong(snap.resetsAt);
  const extra = snap.extra || {};
  const extraBits = [];
  if (extra.prepaidBalance > 0) extraBits.push("Prepaid " + extra.prepaidBalance);
  if (extra.onDemandCap > 0) {
    const usedOn = extra.onDemandUsed != null ? extra.onDemandUsed : 0;
    extraBits.push("On-demand " + usedOn + " / " + extra.onDemandCap);
  }
  card.classList.remove("hidden");
  card.innerHTML = `
    <div class="usage-card-top">
      <div class="usage-kicker">Weekly usage</div>
      <div class="usage-plan">${escapeHtml(snap.plan || "")}</div>
    </div>
    <div class="usage-hero">
      <span class="usage-hero-pct">${pct}%</span>
      <span class="usage-hero-sub">used</span>
      <span class="usage-remain">${remain}% remaining</span>
    </div>
    <div class="usage-bar" aria-hidden="true">${bar}</div>
    <div class="usage-legend">${legend}</div>
    ${reset ? `<div class="usage-reset">Resets ${escapeHtml(reset)}</div>` : ""}
    ${extraBits.length ? `<div class="usage-extra">${escapeHtml(extraBits.join(" · "))}</div>` : ""}
  `;
}

async function loadRoster() {
  try {
    const secret = state.pair?.secret;
    const res = await fetch(api("/api/sessions?secret=" + encodeURIComponent(secret || "")), { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.sessions) && data.sessions.length) {
        state.sessions = data.sessions.map(normalizeRosterRow).filter(Boolean);
      }
    }
  } catch { /* ignore */ }
  if ((!state.sessions || !state.sessions.length) && state.acp?.ready) {
    try {
      let body = null;
      try { body = await state.acp.request("_x.ai/sessions/list", {}, 20000); } catch { /* */ }
      if (!body?.sessions) {
        try { body = await state.acp.request("session/list", {}, 20000); } catch { /* */ }
      }
      const rows = (body?.sessions || []).map(normalizeRosterRow).filter(Boolean);
      if (rows.length) state.sessions = rows;
    } catch { /* ignore */ }
  }
  renderRoster();
  syncFrameFromRoster();
  const live = state.acp?.ready ? "live" : "HTTP";
  setSub(`${state.sessions.length} sessions · ${live}`);
  void loadAccountUsage();
}

async function attachSession(id, { replay = false } = {}) {
  const acp = await ensureAcp();
  if (state._attachedId === id && acp.ready) return acp;
  if (replay) {
    state._loadingHistory = true;
    state.items = [];
  }
  let lastErr = null;
  const methods = replay ? ["session/resume", "session/load"] : ["session/resume"];
  for (const method of methods) {
    try {
      const session = await acp.request(method, { sessionId: id, cwd: state.cwd, mcpServers: [] }, replay ? 30000 : 15000);
      state.sessionId = extractSessionId(session, id) || id;
      state._attachedId = state.sessionId;
      state._loadingHistory = false;
      return acp;
    } catch (err) {
      lastErr = err;
      if (/ws closed|WebSocket/i.test(String(err.message || ""))) break;
    }
  }
  state._loadingHistory = false;
  if (acp.ready) {
    state.sessionId = id;
    state._attachedId = id;
    return acp;
  }
  throw lastErr || new Error("Could not attach session");
}

function launchSessionId(workingId, lastId) {
  return workingId || lastId || "";
}
function problemsTurnOpen(finished, hasFailure, problemsOnly) {
  if (!finished) return true;
  return !!(problemsOnly && hasFailure);
}
function startOfTodayMs(now) {
  const d = new Date(now || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function filterToToday(items, now) {
  const start = startOfTodayMs(now);
  const out = [];
  let bucket = [];
  let keep = true;
  const flush = (force) => {
    if (keep || force) out.push(...bucket);
    bucket = [];
    keep = true;
  };
  for (const it of items || []) {
    if (it.kind === "user") {
      flush(false);
      const t = Number(it.at || it.startedAt || 0);
      keep = !t || t >= start;
      bucket = [it];
    } else {
      const t = Number(it.at || it.startedAt || it.endedAt || 0);
      if (t >= start) keep = true;
      bucket.push(it);
    }
  }
  const unfinished = bucket.length && !bucket.some((it) => it.kind === "agent");
  flush(unfinished);
  return out;
}
function latestFailureIndex(items) {
  const list = items || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (isFailedStep(list[i])) return list[i]._i != null ? list[i]._i : i;
  }
  return -1;
}
function attentionLabel(planWaiting, permWaiting) {
  if (planWaiting) return "Plan is ready";
  if (permWaiting) return "Permission needed";
  return "";
}
function restoreQueueList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && String(e.text || "").trim()).map((e) => ({
    text: String(e.text || "").trim(),
    hear: !!e.hear,
    source: "app",
    images: [],
  }));
}
function liveChipLabel(modelShort, step) {
  const model = String(modelShort || "").trim();
  const line = String(step || "").trim();
  if (!line) return "";
  if (!model || model === "Model") return line;
  return model + " · " + line;
}
function turnCopyText(steps, replyText) {
  const lines = [];
  for (const step of steps || []) {
    if (step.kind === "think") lines.push(thinkSummary(step));
    else if (step.kind === "tool") lines.push(toolLineLabel(step));
    else if (step.kind === "task") lines.push((step.phase === "started" ? "Task started: " : "Task completed: ") + (step.text || "command"));
    else if (step.kind === "compact") lines.push(step.text || "Compacting...");
    else if (step.text) lines.push(String(step.text).split("\n")[0]);
  }
  const reply = plainReply(replyText || "");
  if (reply) lines.push("", reply);
  return lines.join("\n").trim();
}
function maybeRestoreSession() {
  if (state._restored) return;
  if (state.view !== "roster") return;
  if (pinConfigured() && !state.unlocked) return;
  let last = "";
  try { last = localStorage.getItem("gr.lastSession") || ""; } catch { last = ""; }
  const working = (state.sessions || []).find((s) => sessionWorking(s) && !isHiddenSession(s.sessionId));
  const id = launchSessionId(working?.sessionId || "", last);
  if (!id || !state.sessions.some((s) => s.sessionId === id)) return;
  if (isHiddenSession(id)) return;
  state._restored = true;
  openSession(id);
}

async function openSession(id) {
  if (state.sessionId && state.sessionId !== id) {
    rememberPlace();
    cacheTranscript(state.sessionId);
    void stopReadAloud();
    saveDraft(state.sessionId);
    persistQueue(state.sessionId);
  }
  const row = state.sessions.find((s) => s.sessionId === id);
  stopLive();
  hidePlanSheet();
  state._openingSession = true;
  state._loadingHistory = true;
  state._openedAt = Date.now();
  state.sessionId = id;
  state._jumpSession = id;
  state.jumpUser = null;
  state.jumpErr = null;
  state._attachedId = null;
  state.title = row?.title || "Session";
  state.cwd = row?.cwd || state.pair?.cwd || "";
  state.items = [];
  state.seenIds = new Set();
  state.prompts = [];
  state.queue = restoreQueue(id);
  state.pcQueue = [];
  state._scrollFail = true;
  state.attachments = [];
  state.openGroups = new Set();
  loadBlockPref(id);
  state.model = row?.modelId || row?.model || state.model || "";
  state.busy = false;
  endTurn({ notify: false });
  clearWaiting();
  renderChips();
  renderQueue();
  renderAttach();
  showView("thread");
  state.stickBottom = true;
  loadDraft(id);
  loadChatNote(id);
  if (state._pendingDictate) {
    const extra = state._pendingDictate;
    state._pendingDictate = "";
    takeDictation(extra);
  }
  try { localStorage.setItem("gr.lastSession", id); } catch { /* ignore */ }
  if (showCachedTranscript(id)) setSub(connectionLabel());
  else setSub("Loading history…");
  endTurn({ notify: false });
  try {
    const secret = state.pair?.secret || "";
    const hist = await fetch(
      api("/api/sessions/" + encodeURIComponent(id) + "/history?secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
    if (hist && hist.ok && Array.isArray(hist.items)) {
      state.historyTrimmed = !!hist.trimmed;
      state.items = hist.items.length ? keepSentImages(hist.items.map((it) => ({
        ...it,
        text: it.kind === "user" ? stripRemotePrefix(it.text) : it.text,
      }))) : [];
      if (Array.isArray(hist.prompts)) adoptPrompts(hist.prompts);
      if (Array.isArray(hist.todos)) state.todos = hist.todos;
      state.catchUpIndex = findCatchUp(id);
      resumeTurnFromItems();
      renderThread();
      scrollThreadToEnd(true);
      if (!(state.catchUpIndex >= 0)) markSeen(id);
      cacheTranscript(id);
      syncHeader(connectionLabel());
    }
    startLive(id);
    void loadMeta(id);
    void loadPcQueue(id);
    syncHeader();
    if (!hist?.items?.length) renderThread();
    else {
      resumeTurnFromItems();
      renderThread();
    }
    scrollThreadToEnd(true);
  } catch (err) {
    setSub("Load failed");
    state.items.push({ kind: "agent", text: "Could not load session: " + err.message });
    renderThread();
  } finally {
    state._openingSession = false;
    state._loadingHistory = false;
    if (state.perm) {
      showPermissionSheet();
      renderPerm();
    }
  }
}

const MODE_OPTS = [
  { id: "plan", label: "Plan", slash: "/plan" },
  { id: "ask", label: "Ask", slash: null },
  { id: "auto", label: "Auto", slash: "/auto" },
  { id: "always-approve", label: "Approve", slash: "/always-approve" },
];
const MODEL_OPTS = [
  { id: "grok-4.7", label: "4.7" },
  { id: "grok-4.7-build-fast", label: "4.7 Fast · 2× rate" },
  { id: "grok-4.6", label: "4.6" },
  { id: "grok-4.5", label: "4.5" },
];
const EFFORT_OPTS = ["low", "medium", "high", "xhigh"];
const BUILTIN_CMDS = [
  { name: "compact", description: "Compress context", run: "compact" },
  { name: "rewind", description: "Undo last turns", run: "rewind" },
  { name: "fork", description: "Branch this session", run: "fork" },
  { name: "export", description: "Share or copy this thread", run: "export" },
  { name: "copy", description: "Copy last reply", run: "copy" },
  { name: "remember", description: "Save a memory note", run: "remember" },
  { name: "memory", description: "Browse memory", run: true },
  { name: "flush", description: "Flush session into memory", run: true, confirm: "Flush this session into memory now?" },
  { name: "recap", description: "Summarize this session", run: true },
  { name: "summarize", description: "Summarize this session", run: true },
  { name: "usage", description: "Context usage", run: "usage" },
  { name: "session-info", description: "Session details", run: "usage" },
  { name: "view-plan", description: "Show todos", run: "todos" },
  { name: "rename", description: "Rename session", run: "rename" },
  { name: "plan", description: "Plan mode" },
  { name: "auto", description: "Auto-approve safe tools" },
  { name: "always-approve", description: "Skip permission prompts" },
  { name: "model", description: "Switch model" },
  { name: "effort", description: "Reasoning effort" },
];

function normalizeMode(id) {
  const s = String(id || "").toLowerCase();
  if (!s) return "auto";
  if (/plan/.test(s)) return "plan";
  if (/always|yolo|approve/.test(s)) return "always-approve";
  if (/auto/.test(s)) return "auto";
  if (/ask|normal|default/.test(s)) return "ask";
  return "auto";
}
function modeLabel(id) {
  return MODE_OPTS.find((m) => m.id === id)?.label || "Auto";
}
function modelLabel(id) {
  const hit = MODEL_OPTS.find((m) => m.id === id);
  if (hit) return hit.label.replace(/ ·.*$/, "");
  return id || "Model";
}
function frameTapAction(id) {
  const raw = String(id || "");
  if (raw.startsWith("effort:")) return { kind: "effort", value: raw.slice(7) };
  if (raw.startsWith("model:")) return { kind: "model", value: raw.slice(6) };
  return null;
}
function syncFrameFromRoster() {
  const row = (state.sessions || []).find((s) => s.sessionId === state.sessionId);
  if (!row || state.view !== "thread") return;
  let changed = false;
  if (row.modelId && row.modelId !== state.model) { state.model = row.modelId; changed = true; }
  if (row.effort && row.effort !== state.effort) { state.effort = row.effort; changed = true; }
  if (row.planMode === "plan" && state.mode !== "plan") { state.mode = "plan"; changed = true; }
  else if (row.planMode !== "plan" && state.mode === "plan") { state.mode = "auto"; changed = true; }
  if (changed) renderChips();
}
function frameModelLine(modelId, effort, mode) {
  const name = modelId ? "Grok " + modelLabel(modelId) : "";
  const eff = String(effort || "").trim().toLowerCase();
  let line = name;
  if (eff) line = (line ? line + " " : "") + "(" + eff + ")";
  const m = String(mode || "auto");
  if (m === "plan" || m === "always-approve") {
    const tag = m === "always-approve" ? "approve" : "plan";
    line = line ? line + " · " + tag : tag;
  }
  return line;
}
function renderChips() {
  const mode = $("chipMode");
  const model = $("chipModel");
  const effort = $("chipEffort");
  const usage = $("chipUsage");
  const todos = $("chipTodos");
  if (!mode) return;
  mode.textContent = modeLabel(state.mode);
  const wrap = $("composerWrap");
  if (wrap) wrap.setAttribute("data-mode", state.mode || "auto");
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("on", b.getAttribute("data-mode") === (state.mode || "auto"));
  });
  model.textContent = state.model ? modelLabel(state.model) : "Model";
  effort.textContent = state.effort || "Effort";
  const frameTitle = $("frameTitle");
  const frameModel = $("frameModel");
  if (frameTitle) frameTitle.textContent = state.title || "";
  if (frameModel) frameModel.textContent = frameModelLine(state.model, state.effort, state.mode);
  if (usage) {
    const pct = state.usage?.percent;
    usage.textContent = pct != null ? pct + "%" : "Usage";
    usage.classList.toggle("nag", pct != null && Number(pct) >= 80);
  }
  if (todos) {
    const n = (state.todos || []).length;
    todos.classList.toggle("hidden", n === 0);
    todos.textContent = n ? "Todos " + n : "Todos";
  }
}
function hideSheet(opts = {}) {
  $("sheet")?.classList.add("hidden");
  if (opts.cancel && state.askResolve) {
    const r = state.askResolve;
    state.askResolve = null;
    r({ answers: [], cancelled: true });
  }
  if (opts.cancel && state.perm?.resolve) {
    state.perm.resolve({ outcome: { outcome: "cancelled" } });
    state.perm = null;
    renderPerm();
  }
}

function bindDiamondCopy(root) {
  if (!root) return;
  root.querySelectorAll("[data-copy]").forEach((node) => {
    let timer = 0;
    const fire = (e) => {
      if (e?.cancelable) e.preventDefault();
      e?.stopPropagation?.();
      let text = node.getAttribute("data-copy") || "";
      try { text = decodeURIComponent(text); } catch { /* keep raw */ }
      copyText(text);
    };
    node.addEventListener("contextmenu", fire);
    node.addEventListener("touchstart", () => {
      clearTimeout(timer);
      timer = setTimeout(() => fire(), 550);
    }, { passive: true });
    node.addEventListener("touchend", () => clearTimeout(timer));
    node.addEventListener("touchmove", () => clearTimeout(timer));
  });
}
function copyText(text) {
  const t = String(text || "");
  if (!t) return;
  const done = () => setSub("Copied");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t));
  } else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement("textarea");
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch { /* ignore */ }
  ta.remove();
  setSub("Copied");
}

let atSuggestTimer = null;
async function onPromptAtSuggest() {
  const ta = $("prompt");
  const box = $("atList");
  if (!ta || !box) return;
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const m = before.match(/(^|\s)@([^\s]*)$/);
  if (!m || m[2].length < 2) {
    box.classList.add("hidden");
    return;
  }
  const q = m[2];
  clearTimeout(atSuggestTimer);
  atSuggestTimer = setTimeout(() => { void fetchAtSuggest(q); }, 160);
}
async function fetchAtSuggest(q) {
  const box = $("atList");
  const cwd = state.cwd || state.pair?.cwd || "";
  const secret = state.pair?.secret || "";
  try {
    const data = await fetch(
      api("/api/fs?cwd=" + encodeURIComponent(cwd) + "&q=" + encodeURIComponent(q) + "&secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
    const hits = (data.entries || []).slice(0, 12);
    if (!hits.length) { box.classList.add("hidden"); return; }
    box.innerHTML = hits.map((e) =>
      `<button type="button" data-path="${escapeHtml(e.path)}">${escapeHtml(e.dir ? e.path + "/" : e.path)}</button>`
    ).join("");
    box.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        replaceAtToken(b.getAttribute("data-path"));
        box.classList.add("hidden");
      });
    });
    box.classList.remove("hidden");
  } catch {
    box.classList.add("hidden");
  }
}
function replaceAtToken(rel) {
  const ta = $("prompt");
  if (!ta) return;
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(pos);
  const token = "@" + String(rel || "").replace(/\\/g, "/");
  ta.value = before.replace(/(^|\s)@[^\s]*$/, (_, sp) => (sp || "") + token + " ") + after;
  ta.focus();
}

function insertAtMention(rel) {
  const ta = $("prompt");
  if (!ta) return;
  const token = "@" + String(rel || "").replace(/\\/g, "/");
  const start = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(start);
  const padL = before && !/\s$/.test(before) ? " " : "";
  const padR = after && !/^\s/.test(after) ? " " : "";
  ta.value = before + padL + token + padR + after;
  ta.focus();
}

async function openFileBrowser(rel, q) {
  const box = $("atList");
  if (!box) return;
  $("prompt")?.blur();
  hideSheet();
  $("slashList")?.classList.add("hidden");
  hideHist();
  const cwd = state.cwd || state.pair?.cwd || "";
  const secret = state.pair?.secret || "";
  const qstr = "?cwd=" + encodeURIComponent(cwd) + "&rel=" + encodeURIComponent(rel || "") +
    (q ? "&q=" + encodeURIComponent(q) : "") + "&secret=" + encodeURIComponent(secret);
  let data;
  try {
    data = await fetch(api("/api/fs" + qstr), { cache: "no-store" }).then((r) => r.json());
  } catch (err) {
    setSub("Files failed: " + err.message);
    return;
  }
  if (!data?.ok) {
    setSub(data?.error || "Files failed");
    return;
  }
  state.fsRel = data.rel || "";
  const searching = !!(data.q);
  const rows = [];
  rows.push(`<div class="slash-head">${escapeHtml(searching ? "Search files" : "@ " + (data.rel || "."))}</div>`);
  if (!searching && data.rel) {
    rows.push(`<button type="button" class="fs-row" data-dir="${escapeHtml(data.parent || "")}"><span class="k">↑</span> ..</button>`);
  }
  const entries = data.entries || [];
  if (!entries.length) rows.push(`<div class="empty">${searching ? "No files match that search." : "This folder is empty. Use ↑ to go up."}</div>`);
  for (const e of entries) {
    if (e.dir) {
      rows.push(`<button type="button" class="fs-row" data-dir="${escapeHtml(e.path)}"><span class="k">dir</span>${escapeHtml(e.path || e.name)}</button>`);
    } else {
      rows.push(`<button type="button" class="fs-row" data-file="${escapeHtml(e.path)}"><span class="k">file</span>${escapeHtml(e.path || e.name)}</button>`);
    }
  }
  box.innerHTML = rows.join("");
  box.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      const dir = b.getAttribute("data-dir");
      const file = b.getAttribute("data-file");
      if (file) {
        box.classList.add("hidden");
        insertAtMention(file);
        return;
      }
      if (dir != null) void openFileBrowser(dir);
    });
  });
  box.classList.remove("hidden");
}

async function loadMeta(id) {
  if (!id) return;
  try {
    const secret = state.pair?.secret || "";
    const meta = await fetch(
      api("/api/sessions/" + encodeURIComponent(id) + "/meta?secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
    if (!meta?.ok) return;
    state.usage = meta.usage || null;
    if (meta.modelId) state.model = meta.modelId;
    if (meta.effort) state.effort = meta.effort;
    if (Array.isArray(meta.todos) && meta.todos.length) state.todos = meta.todos;
    if (meta.plan?.awaiting && state._planOpenFor !== id) {
      state._planOpenFor = id;
      void openPlanPreview({ user: true });
      void pushNotify(
        "Plan ready",
        notifySessionName(id) + " — review the plan to continue",
        id,
        "needs"
      );
    } else if (!meta.plan?.awaiting && state._planOpenFor === id) {
      state._planOpenFor = "";
      hidePlanSheet();
    }
    renderChips();
  } catch {
    /* ignore */
  }
}

function fmtDuration(sec) {
  const n = Number(sec) || 0;
  if (n < 60) return n + "s";
  if (n < 3600) return Math.round(n / 60) + "m";
  const h = Math.floor(n / 3600);
  const m = Math.round((n % 3600) / 60);
  return h + "h " + m + "m";
}

function fmtTok(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v >= 1000) return Math.round(v).toLocaleString();
  return String(Math.round(v));
}
function contextBarHtml(u) {
  const win = Number(u.windowTokens) || 0;
  const c = u.context || {};
  if (!win) return "";
  const parts = c.estimated
    ? [
        ["System", c.system, "1"],
        ["Tools", c.tools, "0.72"],
        ["Messages", c.messages, "0.48"],
        ["Free", c.free, "0.22"],
      ]
    : [
        ["Used", u.tokensUsed, "1"],
        ["Free", c.free, "0.22"],
      ];
  const segs = parts
    .map(([label, n, op]) => {
      const pct = Math.max(0, (Number(n) || 0) / win * 100);
      if (pct < 0.4) return "";
      return `<i class="seg" style="width:${pct.toFixed(2)}%;background:rgba(26,94,255,${op})" title="${label}"></i>`;
    })
    .join("");
  const legend = parts
    .map(([label, n, op]) => `<span><i class="dot" style="background:rgba(26,94,255,${op})"></i>${escapeHtml(label)} ${fmtTok(n)}</span>`)
    .join("");
  const note = c.estimated
    ? "System and tools are estimated from the prompt files. Used and free are this session’s real window."
    : "This session’s window. The file split is larger than the live window, so only used and free are shown.";
  return `<div class="usage-bar" aria-hidden="true">${segs}</div><div class="usage-legend">${legend}</div><p class="mute">${escapeHtml(note)}</p>`;
}
function showUsageSheet() {
  const u = state.usage || {};
  const used = u.tokensUsed ? u.tokensUsed.toLocaleString() : "—";
  const win = u.windowTokens ? u.windowTokens.toLocaleString() : "—";
  const high = u.percent != null && Number(u.percent) >= 80;
  const models = (u.models || []).join(", ") || state.model || "—";
  const toolsUsed = (u.toolsUsed || []).slice(0, 8).join(", ");
  openSheet("Usage", [], state.model, () => {});
  $("sheetTitle").textContent = "Context";
  $("sheetOpts").innerHTML = `${contextBarHtml(u)}<div class="usage-grid">
    <div><span>Context</span><br><strong>${u.percent != null ? u.percent + "%" : "—"}</strong></div>
    <div><span>Tokens</span><br><strong>${escapeHtml(used)} / ${escapeHtml(win)}</strong></div>
    <div><span>Model</span><br><strong>${escapeHtml(models)}</strong></div>
    <div><span>Effort</span><br><strong>${escapeHtml(state.effort || "—")}</strong></div>
    <div><span>Turns</span><br><strong>${u.turns ?? "—"}</strong></div>
    <div><span>Your prompts</span><br><strong>${u.userTurns ?? "—"}</strong></div>
    <div><span>Tools</span><br><strong>${u.tools ?? "—"}</strong></div>
    <div><span>Compactions</span><br><strong>${u.compactions ?? "—"}</strong></div>
    <div><span>Errors</span><br><strong>${u.errors ?? "—"}</strong></div>
    <div><span>Duration</span><br><strong>${escapeHtml(u.durationSec ? fmtDuration(u.durationSec) : "—")}</strong></div>
  </div>
  ${toolsUsed ? `<p class="mute">Tools used: ${escapeHtml(toolsUsed)}</p>` : ""}
  ${high ? `<p class="mute">Context is high. Compact to free space.</p>` : ""}
  <button type="button" class="primary" id="usageCompact">Compact…</button>
  <button type="button" class="ghost" id="usageExport">Share / export</button>
  <button type="button" class="ghost" id="usageFork">Fork session</button>`;
  $("usageCompact")?.addEventListener("click", () => showCompactSheet());
  $("usageExport")?.addEventListener("click", () => showExportSheet());
  $("usageFork")?.addEventListener("click", () => confirmFork());
}

function threadMarkdown() {
  const parts = [];
  for (const it of state.items || []) {
    if (it.kind === "user" && it.text) parts.push("**You:**\n" + stripRemotePrefix(it.text).trim());
    if (it.kind === "agent" && it.text) parts.push("**Grok:**\n" + String(it.text).trim());
  }
  const title = state.title ? "# " + state.title + "\n\n" : "";
  return title + parts.join("\n\n");
}

async function shareOrCopy(title, text) {
  const body = String(text || "").trim();
  if (!body) {
    setSub("Nothing to share");
    return;
  }
  if (navigator.share) {
    try {
      await navigator.share({ title: title || "Grok Build", text: body });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  copyText(body);
}

function showExportSheet() {
  openSheet("Share / export", [
    { id: "share-last", label: "Share last reply" },
    { id: "share-thread", label: "Share thread" },
    { id: "copy-last", label: "Copy last reply" },
    { id: "copy-thread", label: "Copy thread" },
  ], "", (id) => {
    const last = lastAgentItem()?.text || "";
    const thread = threadMarkdown();
    if (id === "share-last") void shareOrCopy(state.title || "Grok reply", last);
    if (id === "share-thread") void shareOrCopy(state.title || "Grok thread", thread);
    if (id === "copy-last") copyText(last);
    if (id === "copy-thread") copyText(thread);
  });
}

function showRememberSheet() {
  openSheet("Remember", [], "", () => {});
  $("sheetTitle").textContent = "Save to memory";
  $("sheetOpts").innerHTML = `<p class="mute">Grok Build memory is generally available. This note is saved immediately.</p>
    <input id="rememberNote" type="text" placeholder="the staging deploy uses eu-west" />
    <button type="button" class="primary" id="rememberGo">Remember</button>`;
  $("rememberGo")?.addEventListener("click", () => {
    const note = $("rememberNote")?.value.trim() || "";
    hideSheet();
    if (!note) return;
    void sendSlash("/remember " + note);
  });
  $("rememberNote")?.focus();
}

function confirmFork(sessionId) {
  const id = sessionId || state.sessionId;
  openSheet("Fork this session?", [
    { id: "yes", label: "Fork and open" },
    { id: "no", label: "Cancel" },
  ], "", (action) => {
    if (action === "yes") void runFork(id);
  });
}

async function runFork(sessionId) {
  const sid = sessionId || state.sessionId;
  if (!sid) return;
  setSub("Forking…");
  const before = new Set((state.sessions || []).map((s) => s.sessionId));
  let newId = "";
  try {
    const secret = state.pair?.secret || "";
    const res = await fetch(
      api("/api/sessions/" + encodeURIComponent(sid) + "/fork?secret=" + encodeURIComponent(secret)),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    ).then((r) => r.json());
    if (!res.ok) throw new Error(res.error || "fork failed");
    newId = res.sessionId || "";
  } catch (err) {
    setSub("Fork via slash…");
    await sendSlash("/fork");
  }
  await loadRoster();
  if (!newId) {
    const created = (state.sessions || []).find((s) => !before.has(s.sessionId));
    newId = created?.sessionId || "";
  }
  if (newId) {
    openSession(newId);
    setSub("Opened forked session");
  } else {
    setSub("Forked. Open the new session from the roster if it is not here yet.");
  }
}

function showCompactSheet() {
  openSheet("Compact context", [], "", () => {});
  $("sheetTitle").textContent = "Compact context";
  $("sheetOpts").innerHTML = `<p class="mute">Compress this session to free context. Optional: what Grok should keep.</p>
    <input id="compactNote" type="text" placeholder="Keep the auth details…" />
    <button type="button" class="primary" id="compactGo">Compact</button>`;
  $("compactGo")?.addEventListener("click", () => {
    const note = $("compactNote")?.value.trim() || "";
    hideSheet();
    void runCompact(note);
  });
  $("compactNote")?.focus();
}

async function runCompact(note) {
  if (!state.sessionId) return;
  rememberPrompt(note ? "/compact " + note : "/compact", "app");
  setSub("Compacting…");
  try {
    const secret = state.pair?.secret || "";
    const res = await fetch(
      api("/api/sessions/" + encodeURIComponent(state.sessionId) + "/compact?secret=" + encodeURIComponent(secret)),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) }
    ).then((r) => r.json());
    if (!res.ok) throw new Error(res.error || "compact failed");
    setSub("Compact started");
    void loadMeta(state.sessionId);
  } catch (err) {
    setSub("Compact failed: " + err.message);
    void sendSlash(note ? "/compact " + note : "/compact");
  }
}

async function showRewindSheet() {
  if (!state.sessionId) return;
  openSheet("Rewind", [], "", () => {});
  $("sheetTitle").textContent = "Rewind";
  $("sheetOpts").innerHTML = `<p class="mute">Loading turns…</p>`;
  try {
    const secret = state.pair?.secret || "";
    const data = await fetch(
      api("/api/sessions/" + encodeURIComponent(state.sessionId) + "/rewind?secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
    const points = data.points || [];
    if (!points.length) {
      $("sheetOpts").innerHTML = `<p class="mute">No rewind points yet.</p>`;
      return;
    }
    $("sheetOpts").innerHTML = points.map((p) =>
      `<button type="button" class="ghost rewind-row" data-idx="${escapeHtml(String(p.promptIndex))}">
        <span class="hist-text">${escapeHtml(p.preview || "Turn " + p.promptIndex)}</span>
        <span class="mute">${escapeHtml(fmtClock(Date.parse(p.at) || 0) || "")}</span>
      </button>`
    ).join("");
    $("sheetOpts").querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        const idx = Number(b.getAttribute("data-idx"));
        hideSheet();
        confirmRewind(idx, b.querySelector(".hist-text")?.textContent || "");
      });
    });
  } catch (err) {
    $("sheetOpts").innerHTML = `<p class="mute">Could not load rewind points. You can still rewind the last turn.</p>
      <button type="button" class="primary" id="rewindLast">Rewind last turn</button>`;
    $("rewindLast")?.addEventListener("click", () => {
      hideSheet();
      void sendSlash("/rewind");
    });
  }
}

function confirmRewind(promptIndex, preview) {
  openSheet("Rewind to this turn?", [
    { id: "yes", label: "Rewind" },
    { id: "no", label: "Cancel" },
  ], "", (action) => {
    if (action === "yes") void runRewind(promptIndex, preview);
  });
}

async function runRewind(promptIndex, preview) {
  if (!state.sessionId) return;
  setSub("Rewinding…");
  try {
    const secret = state.pair?.secret || "";
    const res = await fetch(
      api("/api/sessions/" + encodeURIComponent(state.sessionId) + "/rewind?secret=" + encodeURIComponent(secret)),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptIndex }),
      }
    ).then((r) => r.json());
    if (!res.ok) throw new Error(res.error || "rewind failed");
    const id = state.sessionId;
    await openSession(id);
    setSub("Rewound" + (preview ? " · " + preview.slice(0, 40) : ""));
  } catch (err) {
    setSub("Rewind failed: " + err.message);
  }
}

function openReplyMenu(i) {
  const it = state.items[i];
  if (!it || (it.kind !== "agent" && it.kind !== "user")) return;
  const opts = [{ id: "copy", label: "Copy" }];
  if (it.kind === "agent" || it.kind === "user") opts.push({ id: "quote", label: "Quote" });
  if (it.kind === "user") opts.push({ id: "retry", label: "Retry" });
  if (it.kind === "agent") {
    opts.push({ id: "share", label: "Share" });
    const user = userTurnBefore(i);
    if (user?.text) opts.push({ id: "retry", label: "Retry that prompt" });
  }
  openSheet(it.kind === "user" ? "Prompt" : "Reply", opts, "", (action) => {
    if (action === "copy") copyText(it.text);
    if (action === "quote") quoteIntoPrompt(it.text);
    if (action === "share") void shareOrCopy(state.title || "Grok reply", it.text);
    if (action === "retry") {
      const text = it.kind === "user" ? it.text : userTurnBefore(i)?.text;
      if (text) void sendPrompt(text, { now: true });
    }
  });
}

function userTurnBefore(index) {
  for (let i = index; i >= 0; i--) {
    if (state.items[i]?.kind === "user") return state.items[i];
  }
  return null;
}

function quoteIntoPrompt(text) {
  const ta = $("prompt");
  if (!ta) return;
  const q = String(text || "").trim().split(/\n/).slice(0, 8).join("\n");
  const block = q ? "> " + q.replace(/\n/g, "\n> ") + "\n\n" : "";
  ta.value = block + ta.value;
  ta.focus();
}

function wireThreadHolds() {
  const el = $("thread");
  if (!el) return;
  el.querySelectorAll(".reply, .bubble.user").forEach((node) => {
    const i = Number(node.getAttribute("data-i"));
    let hold = null;
    const start = () => { hold = setTimeout(() => { hold = null; openReplyMenu(i); }, 480); };
    const end = () => { if (hold) { clearTimeout(hold); hold = null; } };
    node.addEventListener("contextmenu", (e) => { e.preventDefault(); openReplyMenu(i); });
    node.addEventListener("touchstart", start, { passive: true });
    node.addEventListener("touchend", end);
    node.addEventListener("touchmove", end);
  });
}

function showTodosSheet() {
  const rows = state.todos || [];
  openSheet("Todos", [], "", () => {});
  $("sheetTitle").textContent = rows.length ? `Todos (${rows.length})` : "Todos";
  if (!rows.length) {
    $("sheetOpts").innerHTML = `<p class="mute">No todos in this session.</p>`;
    return;
  }
  $("sheetOpts").innerHTML = rows.map((t) =>
    `<div class="todo"><span class="st ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span><span>${escapeHtml(t.content)}</span></div>`
  ).join("");
}

function openRosterMenu(id) {
  const row = state.sessions.find((s) => s.sessionId === id);
  const star = isStarred(id);
  const hid = isHiddenSession(id);
  const working = !!(row && /work|runn?ing|busy|live/i.test(String(row.activity || "")));
  const opts = [
    { id: "rename", label: "Rename" },
    { id: "open", label: "Open" },
    { id: "star", label: star ? "Unpin" : "Pin / star" },
    { id: "mute", label: isMuted(id) ? "Unmute" : "Mute" },
    { id: "follow", label: isFollowed(id) ? "Stop following" : "Follow through quiet hours" },
    { id: "hide", label: hid ? "Show in list" : "Hide from list" },
    { id: "fork", label: "Fork" },
    { id: "info", label: "Session info" },
    { id: "copy-title", label: "Copy name" },
  ];
  if (working) opts.splice(2, 0, { id: "stop", label: "Stop" });
  opts.push({ id: "delete", label: "Delete" });
  openSheet(row?.title || "Session", opts, "", (action) => {
    if (action === "open") openSession(id);
    if (action === "star") toggleStar(id);
    if (action === "mute") toggleMuted(id);
    if (action === "follow") toggleFollow(id);
    if (action === "hide") toggleHiddenSession(id);
    if (action === "rename") openRenameSheet(id, row?.title || "");
    if (action === "fork") confirmFork(id);
    if (action === "info") {
      void loadMeta(id).then(() => showUsageSheet());
    }
    if (action === "copy-title") copyText(row?.title || id);
    if (action === "stop") void cancelSessionTurn(id);
    if (action === "delete") confirmDeleteSession(id, row);
  });
}

function openRenameSheet(id, current) {
  const sheet = $("sheet");
  $("sheetTitle").textContent = "Rename session";
  $("sheetOpts").innerHTML = `<input id="renameInput" type="text" value="${escapeHtml(current)}" maxlength="100" />
    <button type="button" class="primary" id="renameSave">Save</button>
    <button type="button" class="ghost" id="renameAuto">Auto title</button>`;
  sheet.onclick = (e) => {
    if (e.target === sheet) hideSheet({ cancel: true });
  };
  sheet.classList.remove("hidden");
  const save = () => {
    const title = $("renameInput").value.trim();
    hideSheet();
    if (title) void renameRemoteSession(id, title);
  };
  $("renameSave").addEventListener("click", save);
  $("renameAuto")?.addEventListener("click", () => {
    hideSheet();
    void autoTitleSession(id);
  });
  $("renameInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  });
  const input = $("renameInput");
  if (input) {
    input.focus();
    input.select();
  }
}

async function autoTitleSession(id) {
  try {
    if (state.sessionId === id) {
      await sendSlash("/rename --auto");
      setSub("Auto title requested");
      return;
    }
    const secret = state.pair?.secret || "";
    await fetch(
      api("/api/sessions/" + encodeURIComponent(id) + "/rename?secret=" + encodeURIComponent(secret)),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ auto: true }) }
    );
    setSub("Auto title requested");
    void loadRoster();
  } catch (err) {
    setSub("Auto title failed: " + err.message);
  }
}

async function renameRemoteSession(id, title) {
  try {
    const secret = state.pair?.secret || "";
    const res = await fetch(
      api("/api/sessions/" + encodeURIComponent(id) + "/rename?secret=" + encodeURIComponent(secret)),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }
    ).then((r) => r.json());
    if (!res.ok) throw new Error(res.error || "rename failed");
    const row = state.sessions.find((s) => s.sessionId === id);
    if (row) row.title = title;
    if (state.sessionId === id) {
      state.title = title;
      syncHeader();
      await sendSlash("/rename " + title);
    }
    renderRoster();
  } catch (err) {
    setSub("Rename failed: " + err.message);
  }
}

function confirmDeleteSession(id, row) {
  const live = row && (row.resident || /work|run|busy|live/i.test(String(row.activity || "")));
  if (live) {
    openSheet("Can't delete", [], "", () => {});
    $("sheetOpts").innerHTML = `<p>This session is live on the PC. Close it there first.</p>`;
    return;
  }
  openSheet("Delete session?", [{ id: "yes", label: "Delete permanently" }, { id: "no", label: "Cancel" }], "", (action) => {
    if (action === "yes") void deleteRemoteSession(id);
  });
}

async function deleteRemoteSession(id) {
  try {
    const secret = state.pair?.secret || "";
    const res = await fetch(
      api("/api/sessions/" + encodeURIComponent(id) + "/delete?secret=" + encodeURIComponent(secret)),
      { method: "POST" }
    ).then((r) => r.json());
    if (!res.ok) throw new Error(res.error || "delete failed");
    state.sessions = state.sessions.filter((s) => s.sessionId !== id);
    if (state.sessionId === id) goBack();
    else renderRoster();
  } catch (err) {
    setSub("Delete failed: " + err.message);
  }
}
function openSheet(title, options, current, onPick) {
  const sheet = $("sheet");
  $("sheetTitle").textContent = title;
  $("sheetOpts").innerHTML = options.map((o) => {
    const id = o.id || o;
    const label = o.label || o;
    const on = String(current) === String(id) ? " on" : "";
    return `<button type="button" class="ghost${on}" data-id="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
  }).join("");
  $("sheetOpts").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      hideSheet();
      onPick(b.getAttribute("data-id"));
    });
  });
  sheet.onclick = (e) => {
    if (e.target === sheet) hideSheet({ cancel: true });
  };
  sheet.classList.remove("hidden");
}

function sessionIsLive(id) {
  const row = state.sessions.find((s) => s.sessionId === id);
  return !!(row && (row.resident || /work|run|busy|live/i.test(String(row.activity || ""))));
}

async function sendSlash(cmd) {
  if (!state.sessionId || !cmd) return;
  try {
    await sendPrompt(cmd, { now: true });
  } catch (err) {
    setSub("Command failed: " + err.message);
  }
}

async function applyMode(id) {
  const prev = state.mode;
  state.mode = id;
  renderChips();
  const opt = MODE_OPTS.find((m) => m.id === id);
  if (id === "ask") {
    const curSlash = MODE_OPTS.find((m) => m.id === prev && m.slash)?.slash;
    if (curSlash) await sendSlash(curSlash);
    return;
  }
  if (opt?.slash) await sendSlash(opt.slash);
}

async function applyModel(id) {
  state.model = id;
  renderChips();
  await sendSlash("/model " + id);
}
async function applyEffort(id) {
  state.effort = id;
  renderChips();
  await sendSlash("/effort " + id);
}

function mergedQueue() {
  const pc = (state.pcQueue || []).map((e, i) => ({
    origin: "pc",
    id: e.id,
    index: e.index != null ? e.index : i,
    text: e.text || "",
    source: e.source || "pc",
    running: !!e.running,
  }));
  const local = (state.queue || []).map((e, i) => ({
    origin: "app",
    id: "local-" + i,
    index: i,
    text: e.text || "",
    source: "app",
    images: e.images,
  }));
  return pc.concat(local);
}
function renderQueue() {
  const box = $("queueBox");
  if (!box) return;
  const rows = mergedQueue();
  if (!rows.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = rows.map((q, i) => `
    <div class="q-row" data-origin="${q.origin}" data-id="${escapeHtml(q.id)}" data-index="${q.index}">
      <button type="button" class="q-drag" aria-label="Reorder">≡</button>
      <span class="q-num">#${i + 1}</span>
      <span class="q-text">${escapeHtml(q.text || (q.images?.length ? "image" : ""))}</span>
      <div class="q-actions">
        <button type="button" class="q-now" data-i="${i}">Send now</button>
        <button type="button" class="q-edit" data-i="${i}">edit</button>
        <button type="button" class="q-cancel" data-i="${i}">cancel</button>
      </div>
    </div>`).join("") +
    `<div class="q-foot"><span>${rows.length} queued</span></div>`;
  box.querySelectorAll(".q-cancel").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.getAttribute("data-i"));
      void cancelQueued(mergedQueue()[i]);
    });
  });
  box.querySelectorAll(".q-now").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.getAttribute("data-i"));
      void startQueued(mergedQueue()[i]);
    });
  });
  box.querySelectorAll(".q-edit").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.getAttribute("data-i"));
      void editQueued(mergedQueue()[i]);
    });
  });
  wireQueueDrag(box);
}
function wireQueueDrag(box) {
  let drag = null;
  box.oncontextmenu = (e) => { e.preventDefault(); };
  box.querySelectorAll(".q-drag").forEach((handle) => {
    const row = handle.closest(".q-row");
    handle.addEventListener("contextmenu", (e) => e.preventDefault());
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drag = {
        row,
        origin: row.dataset.origin,
        from: Number(row.dataset.index),
      };
      row.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!drag || drag.row !== row) return;
      const peers = [...box.querySelectorAll(".q-row")].filter((r) => r.dataset.origin === drag.origin);
      const over = peers.find((r) => {
        if (r === row) return false;
        const b = r.getBoundingClientRect();
        return e.clientY >= b.top && e.clientY <= b.bottom;
      });
      if (!over) return;
      const mid = over.getBoundingClientRect().top + over.getBoundingClientRect().height / 2;
      if (e.clientY < mid) over.before(row);
      else over.after(row);
    });
    handle.addEventListener("pointerup", () => {
      if (!drag || drag.row !== row) return;
      row.classList.remove("dragging");
      const origin = drag.origin;
      const from = drag.from;
      const peers = [...box.querySelectorAll(".q-row")].filter((r) => r.dataset.origin === origin);
      const to = peers.indexOf(row);
      drag = null;
      if (to < 0 || to === from) return;
      void applyQueueReorder(origin, from, to, peers.map((r) => r.dataset.id));
    });
    handle.addEventListener("pointercancel", () => {
      if (drag?.row === row) row.classList.remove("dragging");
      drag = null;
      renderQueue();
    });
  });
  pushGlance();
}
async function applyQueueReorder(origin, from, to, ids) {
  if (origin === "app") {
    const item = state.queue.splice(from, 1)[0];
    if (!item) return;
    state.queue.splice(to, 0, item);
    renderQueue();
    persistQueue();
    return;
  }
  const entries = (state.pcQueue || []).slice();
  const item = entries.splice(from, 1)[0];
  if (!item) return;
  entries.splice(to, 0, item);
  state.pcQueue = entries;
  renderQueue();
  try {
    await queueAction("reorder", { fromIndex: from, toIndex: to, ids, id: item.id });
    setSub("Queue updated");
  } catch (err) {
    setSub("Reorder failed: " + err.message);
    void loadPcQueue();
  }
}
async function loadPcQueue(id) {
  const sid = id || state.sessionId;
  if (!sid) return;
  try {
    const secret = state.pair?.secret || "";
    const data = await fetch(
      api("/api/sessions/" + encodeURIComponent(sid) + "/queue?secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
    if (data && Array.isArray(data.entries)) {
      state.pcQueue = data.entries;
      renderQueue();
    }
  } catch { /* ignore */ }
}
async function queueAction(action, row) {
  const secret = state.pair?.secret || "";
  const res = await fetch(
    api("/api/sessions/" + encodeURIComponent(state.sessionId) + "/queue?secret=" + encodeURIComponent(secret)),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        id: row?.id,
        index: row?.index,
        fromIndex: row?.fromIndex,
        toIndex: row?.toIndex,
        ids: row?.ids,
      }),
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || "queue " + action + " failed");
  if (Array.isArray(body.entries)) state.pcQueue = body.entries;
  renderQueue();
}
async function cancelQueued(row) {
  if (!row) return;
  if (row.origin === "app") {
    const i = Number(row.index);
    const local = state.queue.splice(i, 1)[0];
    if (local?.text) $("prompt").value = local.text;
    if (local?.images?.length) state.attachments = (state.attachments || []).concat(local.images);
    renderQueue();
    persistQueue();
    renderAttach();
    $("prompt").focus();
    return;
  }
  try {
    await queueAction("cancel", row);
  } catch (err) {
    setSub("Cancel failed: " + err.message);
  }
}
async function editQueued(row) {
  if (!row) return;
  if (row.origin === "app") {
    await cancelQueued(row);
    return;
  }
  const text = String(row.text || "");
  try {
    await queueAction("edit", row);
    const ta = $("prompt");
    if (ta) {
      ta.value = text;
      ta.focus();
    }
    setSub("Editing queued message");
  } catch (err) {
    setSub("Edit failed: " + err.message);
  }
}
async function startQueued(row) {
  if (!row) return;
  if (row.origin === "app") {
    const i = Number(row.index);
    const local = state.queue.splice(i, 1)[0];
    renderQueue();
    persistQueue();
    cancelTurn();
    if (local) void sendPrompt(local.text, { now: true, images: local.images, hear: local.hear });
    return;
  }
  try {
    await queueAction("start", row);
    setSub("Sending now…");
  } catch (err) {
    setSub("Start failed: " + err.message);
  }
}

function enqueueFollowUp(text, images, opts = {}) {
  state.queue.push({
    text: String(text || "").trim(),
    source: "app",
    images: images || [],
    hear: !!opts.hear,
  });
  renderQueue();
  persistQueue();
}

function sendNow() {
  const top = state.queue.shift();
  renderQueue();
  persistQueue();
  cancelTurn();
  if (top) void sendPrompt(top.text, { now: true, images: top.images, hear: top.hear });
}

function drainQueue() {
  if (state._prompting || (state.turn && state.turn.active)) return;
  const next = state.queue.shift();
  if (!next) {
    renderQueue();
    persistQueue();
    return;
  }
  renderQueue();
  persistQueue();
  void sendPrompt(next.text, { now: true, images: next.images, hear: next.hear });
}

function renderAttach() {
  const row = $("attachRow");
  if (!row) return;
  const files = state.attachments || [];
  if (!files.length) {
    row.classList.add("hidden");
    row.innerHTML = "";
    return;
  }
  row.classList.remove("hidden");
  row.innerHTML = files.map((f, i) => `
    <div class="thumb"><img src="${f.dataUrl}" alt=""><button type="button" class="q-x" data-i="${i}">×</button></div>
  `).join("");
  row.querySelectorAll(".q-x").forEach((b) => {
    b.addEventListener("click", () => {
      state.attachments.splice(Number(b.getAttribute("data-i")), 1);
      renderAttach();
    });
  });
}

function addImageFile(file) {
  if (!file || !String(file.type || "").startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || "");
    const b64 = dataUrl.split(",")[1] || "";
    state.attachments.push({
      name: file.name || "image",
      mime: file.type || "image/jpeg",
      dataUrl,
      b64,
    });
    renderAttach();
  };
  reader.readAsDataURL(file);
}

function promptParts(text, images) {
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const img of images || []) {
    if (img.b64) parts.push({ type: "image", mimeType: img.mime || "image/png", data: img.b64 });
  }
  return parts;
}

async function waitForPcEcho(sessionId, text, ms = 8000) {
  const needle = stripRemotePrefix(text).replace(/\s+/g, " ").trim().slice(0, 60);
  if (!needle || !sessionId) return false;
  const t0 = Date.now();
  const secret = state.pair?.secret || "";
  while (Date.now() - t0 < ms) {
    try {
      const hist = await fetch(
        api("/api/sessions/" + encodeURIComponent(sessionId) + "/history?secret=" + encodeURIComponent(secret)),
        { cache: "no-store" }
      ).then((r) => r.json());
      const users = (hist.items || []).filter((i) => i.kind === "user");
      const last = users[users.length - 1];
      const have = stripRemotePrefix(last?.text || "").replace(/\s+/g, " ");
      if (have.includes(needle)) return true;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

async function sendPrompt(text, opts = {}) {
  text = String(text || "").trim();
  const images = opts.images || state.attachments || [];
  if (!text && !images.length) return;
  saveDraft(state.sessionId);
  state.stickBottom = true;
  if (state.perm && !isPlanGateTool(state.perm.toolCall?.title || state.perm.title || "")) {
    setSub("Answer Grok first");
    renderPerm();
    return;
  }
  if (!state.sessionId) {
    setSub("Open a session first");
    return;
  }
  const slash = /^\//.test(text) && !images.length;
  const hear = !!(opts.hear || state._hearNextSend);
  state._hearNextSend = false;
  const sid = opts.sessionId || state.sessionId;
  const showHere = sid === state.sessionId;
  if (!opts.now && !slash && (state.turn.active || state._prompting)) {
    enqueueFollowUp(text, images.slice(), { hear });
    state.attachments = [];
    renderAttach();
    return;
  }
  const pendingImages = images.slice();
  if (text && showHere) rememberPrompt(text, "app");
  const sentAt = Date.now();
  if (showHere) {
    if (!slash) {
      state.items.push({
        kind: "user",
        text: text || "",
        source: "app",
        at: sentAt,
        images: pendingImages.map((img) => img.dataUrl).filter(Boolean).slice(0, 4),
      });
    }
    state.attachments = [];
    renderAttach();
    state.suggestion = "";
    void stopReadAloud();
    state._userTurnAt = Date.now();
    noteActivity("waiting", slash ? "Running " + text : "Waiting for response…");
    renderThread();
  }
  state._prompting = true;
  try {
    const outbound = slash ? text : (text.startsWith("[Grok Remote]") ? text : (text ? `[Grok Remote] ${text}` : "[Grok Remote]"));
    const prompt = promptParts(outbound, slash ? [] : pendingImages);
    const secret = state.pair?.secret || "";
    const httpRes = await fetch(
      api("/api/sessions/" + encodeURIComponent(sid) + "/prompt?secret=" + encodeURIComponent(secret)),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: outbound,
          images: slash ? [] : pendingImages.map((img) => ({ b64: img.b64, mime: img.mime || "image/png" })),
        }),
      }
    );
    const data = await httpRes.json().catch(() => ({}));
    if (httpRes.ok && (data.ok || data.accepted || data.landed)) {
      if (hear) state._hearReply = { sessionId: sid, at: sentAt };
      if (showHere && !slash) armUndo({ text, images: pendingImages, sessionId: sid, at: sentAt });
      if (data.via === "headless") setSub("Running on the PC");
      else if (data.queued) setSub("Queued on PC");
      else if (data.landed) setSub("Landed on PC");
      else setSub("Sent — waiting for the PC window");
      if (showHere) {
        startLive(sid);
        void pollHistory(sid);
        syncHeader();
      }
      return;
    }
    throw new Error(data.error || "PC did not take the send");
  } catch (err) {
    state._attachedId = null;
    state._hearReply = null;
    endTurn({ notify: false });
    let healthy = false;
    try {
      const h = await fetch(api("/api/health"), { cache: "no-store" });
      healthy = h.ok;
    } catch { /* ignore */ }
    if (!opts.fromOutbox && !slash && (shouldHoldOutbox(err) || !healthy)) {
      parkOutbox(sid, text, pendingImages);
      if (showHere) removeOptimisticSend(text, sentAt);
      setSub("Saved — will send when you're back on this Wi-Fi");
      return;
    }
    if (opts.fromOutbox) throw err;
    const msg = String(err.name === "AbortError" ? "timed out" : err.message || err);
    if (showHere) state.items.push({ kind: "agent", text: "Send failed: " + msg });
    renderThread();
    if (healthy) {
      syncHeader("Send failed — try again");
    } else {
      setSub("Send failed — reconnecting…");
      try {
        await connect();
      } catch { /* ignore */ }
      syncHeader();
    }
  } finally {
    state._prompting = false;
    drainQueue();
  }
}

function cancelTurn() {
  if (state.sessionId) void cancelSessionTurn(state.sessionId);
}

async function cancelSessionTurn(sessionId) {
  if (!sessionId) return;
  if (state.acp && (sessionId === state.sessionId || !state.sessionId)) {
    try { state.acp.notify("session/cancel", { sessionId }); } catch { /* ignore */ }
  }
  try {
    const secret = state.pair?.secret || "";
    await fetch(
      api("/api/sessions/" + encodeURIComponent(sessionId) + "/cancel?secret=" + encodeURIComponent(secret)),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    );
  } catch { /* ignore */ }
  if (sessionId === state.sessionId) setSub("Stopped");
}

async function startNew() {
  const cwd = $("newCwd").value.trim() || state.pair?.cwd;
  const text = $("newPrompt").value.trim();
  setSub("Creating session…");
  const acp = await ensureAcp();
  const session = await acp.request("session/new", { cwd, mcpServers: [] }, 60000);
  const id = extractSessionId(session, null);
  state.sessionId = id;
  state.title = "New session";
  state.cwd = cwd;
  state.items = [];
  showView("thread");
  startLive(id);
  if (text) await sendPrompt(text);
  else setSub("New session · live");
}

function wireAcp(acp) {
  acp.onNotification = (msg) => {
    if (msg.method === "session/update" || msg.method === "_x.ai/session/update" || msg.method === "x.ai/session/update") {
      const sid = msg.params?.sessionId;
      const u = msg.params?.update || msg.params;
      if (u && msg.params?._meta?.eventId) {
        u._meta = { ...(u._meta || {}), eventId: msg.params._meta.eventId };
      }
      if (!state.sessionId || sid === state.sessionId || !sid) {
        applyUpdate(u, msg.params?._meta?.eventId);
        if (state.view === "thread" && !state._loadingHistory) scheduleRender();
      }
      return;
    }
    if (msg.method === "_x.ai/sessions/changed" || msg.method === "x.ai/sessions/changed") {
      loadRoster();
    }
  };
  acp.onAgentRequest = async (method, params) => {
    if (/ask_user_question/i.test(method || "")) {
      return await presentAskUser(params);
    }
    if (/exit_plan_mode/i.test(method || "")) {
      return await new Promise((resolve) => {
        state.planExt = { method, params: params || {}, resolve };
        if (!planPromptAllowed()) return;
        showView("thread");
        void openPlanPreview({ user: false });
        void pushNotify(
          "Approve plan",
          notifySessionName(state.sessionId) + " — review the plan to continue",
          state.sessionId,
          "needs"
        );
      });
    }
    if (method === "session/request_permission") {
      return await new Promise((resolve) => {
        state.perm = { ...params, sessionId: params.sessionId || state.sessionId, resolve };
        const toolName = String(params.toolCall?.title || params.toolCall?.kind || params.title || "");
        if (isAskUserTool(toolName) || askUserQuestions(params)?.length) {
          void presentAskUser(params).then((ans) => {
            if (ans?.cancelled) resolve({ outcome: { outcome: "cancelled" } });
            else resolve({ outcome: { outcome: "selected", optionId: permOptionId((s) => /allow/i.test(s), "allow_once") } });
            state.perm = null;
            renderPerm();
          });
          return;
        }
        if (isPlanGateTool(toolName)) {
          if (planPromptAllowed()) {
            showView("thread");
            void openPlanPreview({ user: false });
          }
          return;
        }
        showView("thread");
        showPermissionSheet();
        renderPerm();
        const copy = describePermission(params);
        void pushNotify(copy.title, copy.body, params.sessionId || state.sessionId, "needs");
      });
    }
    if (method === "fs/read_text_file" || method === "fs/write_text_file") {
      return undefined;
    }
  };
  acp.onClose = () => {
    if (state._connecting) return;
    if (state.acp === acp) {
      state.acp = null;
      state._attachedId = null;
    }
    setSub("Disconnected — reconnecting…");
    scheduleReconnect("ws-close");
  };
}

let connectBackoffMs = 1000;
function scheduleReconnect(reason) {
  if (state._connecting || state._refreshing) return;
  const wait = connectBackoffMs;
  connectBackoffMs = Math.min(15000, Math.round(connectBackoffMs * 1.6));
  setSub("Reconnecting" + (reason ? " (" + reason + ")" : "") + "…");
  setTimeout(() => {
    connect().catch(() => scheduleReconnect(reason));
  }, wait);
}

function maybeNotify(title, body, tag) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try { new Notification(title, { body, tag: tag || "grok-remote" }); } catch { /* ignore */ }
}

function capPlugins() {
  return (window.Capacitor && window.Capacitor.Plugins) || {};
}

function clipNotify(text, n) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= n) return t;
  return t.slice(0, Math.max(1, n - 1)) + "…";
}
function notifySessionName(id) {
  const sid = id || state.sessionId;
  const row = (state.sessions || []).find((s) => s.sessionId === sid);
  return clipNotify(row?.title || state.title || "Grok", 72);
}
function watchingSession(sessionId) {
  if (document.visibilityState !== "visible" || document.hidden) return false;
  if (state.view !== "thread") return false;
  if (sessionId && state.sessionId && sessionId !== state.sessionId) return false;
  return true;
}
function notifyId(kind, sessionId) {
  const base = { needs: 2100, done: 2200, error: 2300, landed: 2400 }[kind] || 2000;
  let h = 0;
  for (const c of String(sessionId || "")) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return base + (h % 80);
}
function describePermission(params) {
  const tc = params?.toolCall || {};
  const title = String(tc.title || tc.kind || params?.title || "");
  const input = tc.rawInput || tc.input || {};
  const cmd = input.command || input.cmd || "";
  const file = input.path || input.file_path || input.target_file || "";
  const name = notifySessionName(params?.sessionId);
  if (cmd) return { title: "Approve command", body: clipNotify(name + " — " + cmd, 160) };
  if (file) return { title: "Approve edit", body: clipNotify(name + " — " + file, 160) };
  if (title) return { title: "Approval needed", body: clipNotify(name + " — " + title, 160) };
  return { title: "Approval needed", body: name + " is waiting on a decision" };
}

function buzzNeeds() {
  try { navigator.vibrate?.([40, 60, 40]); } catch { /* ignore */ }
}

async function clearLegacyNotifications() {
  const LN = capPlugins().LocalNotifications;
  if (!LN) return;
  const isOurs = (n) => {
    const id = Number(n?.id || 0);
    if (id >= 2000 && id < 2500) return true;
    const kind = n?.extra?.kind || n?.extra?.extra?.kind || "";
    return /needs|done|error|uac/i.test(String(kind));
  };
  try {
    const delivered = await LN.getDeliveredNotifications();
    const stale = (delivered?.notifications || []).filter(isOurs);
    if (stale.length && LN.removeDeliveredNotifications) {
      await LN.removeDeliveredNotifications({ notifications: stale });
    } else if (stale.length && LN.removeAllDeliveredNotifications) {
      await LN.removeAllDeliveredNotifications();
    }
  } catch { /* ignore */ }
  try {
    const pending = await LN.getPending();
    const ids = (pending?.notifications || []).filter(isOurs).map((n) => ({ id: n.id }));
    if (ids.length) await LN.cancel({ notifications: ids });
  } catch { /* ignore */ }
}

function armNotificationsSoon() {
  state.notifyMuteUntil = Math.max(state.notifyMuteUntil || 0, Date.now() + 4000);
}

function inQuietHours() {
  if (!state.quietHours) return false;
  const h = new Date().getHours();
  return h >= 23 || h < 7;
}

async function pushNotify(title, body, sessionId, kind) {
  if (kind === "done") {
    const planUp = $("planBar") && !$("planBar").classList.contains("hidden");
    if (planUp || state.perm) return;
  }
  const dedupeKey = kind + ":" + (sessionId || "") + ":" + title;
  if (state._lastBanner === dedupeKey && Date.now() - (state._lastBannerAt || 0) < 20000) return;
  state._lastBanner = dedupeKey;
  state._lastBannerAt = Date.now();
  if (sessionId && isMuted(sessionId) && kind !== "needs" && kind !== "uac") return;
  if (state.notifyMuteUntil && Date.now() < state.notifyMuteUntil) return;
  if (kind === "needs" && !state.notifyNeeds) return;
  if (kind === "error" && !state.notifyNeeds) return;
  if (kind === "uac" && !state.notifyNeeds) return;
  if (kind === "done" && !state.notifyDone) return;
  if (inQuietHours() && !isFollowed(sessionId) && kind !== "needs" && kind !== "error" && kind !== "uac") return;
  if (kind !== "uac" && watchingSession(sessionId)) return;
  const key = `${kind}:${sessionId || ""}:${title}`;
  const now = Date.now();
  if (!state._notifyAt) state._notifyAt = {};
  if (state._notifyAt[key] && now - state._notifyAt[key] < 25000) return;
  state._notifyAt[key] = now;
  if (kind === "needs" || kind === "error" || kind === "uac") buzzNeeds();
  const channelId = kind === "done" ? "grok-remote-done" : "grok-remote";
  try {
    const LN = capPlugins().LocalNotifications;
    if (LN) {
      try { await LN.requestPermissions(); } catch { /* ignore */ }
      try {
        await LN.createChannel({
          id: "grok-remote",
          name: "Approvals and problems",
          importance: 5,
          visibility: 1,
          vibration: true,
        });
      } catch { /* already */ }
      try {
        await LN.createChannel({
          id: "grok-remote-done",
          name: "Pass complete",
          importance: 4,
          visibility: 1,
        });
      } catch { /* already */ }
      const actionTypeId = kind === "needs" || kind === "error" ? "GROK_NEED" : "GROK_DONE";
      await LN.schedule({
        notifications: [{
          id: notifyId(kind, sessionId),
          title,
          body: body || "",
          extra: { sessionId: sessionId || "", kind: kind || "" },
          channelId,
          actionTypeId,
          smallIcon: "ic_stat_grok_remote",
          largeIcon: "ic_grok_remote",
        }],
      });
      return;
    }
  } catch { /* fall through */ }
  maybeNotify(title, body, "gr-" + kind + "-" + (sessionId || ""));
}

function wireNativeNotify() {
  const LN = capPlugins().LocalNotifications;
  if (!LN || LN._grWired) return;
  LN._grWired = true;
  try {
    LN.registerActionTypes({
      types: [
        {
          id: "GROK_NEED",
          actions: [
            { id: "open", title: "Open", foreground: true },
            { id: "allow", title: "Allow", foreground: true },
            { id: "reply", title: "Reply", input: true, foreground: true },
          ],
        },
        {
          id: "GROK_DONE",
          actions: [
            { id: "reply", title: "Reply", input: true, foreground: true },
            { id: "open", title: "Open", foreground: true },
          ],
        },
      ],
    });
  } catch { /* ignore */ }
  LN.addListener("localNotificationActionPerformed", (ev) => {
    const extra = ev?.notification?.extra || {};
    const action = ev?.actionId || extra.actionId || "tap";
    state._pendingNotify = {
      action,
      sessionId: extra.sessionId || "",
      kind: extra.kind || "",
      inputValue: String(ev?.inputValue || extra.inputValue || "").trim(),
    };
    void applyPendingNotify();
  });
}

function tryAllowPending() {
  if (!state.perm?.resolve) return false;
  const opts = permChoices(state.perm);
  const opt = opts.find((o) => /allow_once|allow-once/i.test(String(o.optionId || "")))
    || opts.find((o) => /allow/i.test(String(o.optionId || o.name || "")) && !/always|edits/i.test(String(o.optionId || "")));
  if (!opt) return false;
  resolvePerm(opt.optionId);
  return true;
}

async function applyPendingNotify() {
  const p = state._pendingNotify;
  if (!p) return;
  if (!state.pair) return;
  const action = p.action || "open";
  const sid = p.sessionId;
  const input = String(p.inputValue || "").trim();
  if ((action === "reply" || action === "input") && sid && input) {
    state._pendingNotify = null;
    if (state.sessionId !== sid) await openSession(sid);
    await sendPrompt(input, { now: true });
    return;
  }
  if (action === "stop" && sid) {
    await cancelSessionTurn(sid);
    state._pendingNotify = null;
    return;
  }
  if (sid && (action === "open" || action === "tap" || action === "allow" || !action)) {
    if (state.sessionId !== sid) openSession(sid);
    if (action === "allow") {
      if (!tryAllowPending()) {
        setTimeout(() => { tryAllowPending(); }, 800);
      }
    }
    state._pendingNotify = null;
  }
}

function pinConfigured() {
  return !!(state.pinHash && state.pinSalt);
}
function randomSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPin(pin, salt) {
  const msg = String(salt) + ":grok-remote-pin:" + String(pin);
  try {
    if (globalThis.crypto?.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch { /* HTTP LAN is not a secure context */ }
  let h = 2166136261;
  for (let i = 0; i < msg.length; i++) {
    h ^= msg.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + String(msg.length);
}
function updatePinHint() {
  if ($("pinHint")) {
    $("pinHint").textContent = pinConfigured()
      ? "PIN is set. The app locks when you leave it."
      : "Optional 4–8 digit PIN. Stored hashed on this phone only.";
  }
}
function showLock(on) {
  const el = $("lockOverlay");
  if (!el) return;
  el.classList.toggle("hidden", !on);
  state.unlocked = !on;
  if (!on) maybeRestoreSession();
  if (on) {
    if ($("lockErr")) $("lockErr").textContent = "";
    if ($("pinUnlock")) {
      $("pinUnlock").value = "";
      setTimeout(() => $("pinUnlock").focus(), 50);
    }
  }
}
function maybeShowLock() {
  if (!pinConfigured()) {
    state.unlocked = true;
    showLock(false);
    return;
  }
  showLock(true);
  if (state.bioEnabled) void tryBioUnlock();
}
async function tryBioUnlock() {
  if (!NATIVE || !state.bioEnabled || !pinConfigured()) return false;
  const Bio = capPlugins().BiometricAuth;
  if (!Bio?.authenticate) {
    if ($("bioHint")) $("bioHint").textContent = "Fingerprint / face works in the installed APK.";
    return false;
  }
  try {
    const check = Bio.checkBiometry ? await Bio.checkBiometry() : { isAvailable: true };
    if (check && check.isAvailable === false) {
      if ($("bioHint")) $("bioHint").textContent = check.reason || "No biometrics enrolled — use PIN.";
      return false;
    }
    await Bio.authenticate({
      reason: "Unlock Grok Remote",
      cancelTitle: "Use PIN",
      allowDeviceCredential: true,
      androidTitle: "Grok Remote",
      androidSubtitle: "Unlock",
      androidConfirmationRequired: false,
    });
    showLock(false);
    return true;
  } catch {
    return false;
  }
}
async function unlockWithPin() {
  const pin = String($("pinUnlock")?.value || "").trim();
  if (!/^\d{4,8}$/.test(pin)) {
    if ($("lockErr")) $("lockErr").textContent = "Enter 4–8 digits.";
    return;
  }
  const hash = await hashPin(pin, state.pinSalt);
  if (hash !== state.pinHash) {
    if ($("lockErr")) $("lockErr").textContent = "Wrong PIN.";
    return;
  }
  showLock(false);
}
async function savePin() {
  const pin = String($("pinSet")?.value || "").trim();
  if (!/^\d{4,8}$/.test(pin)) {
    setSub("PIN must be 4–8 digits");
    return;
  }
  const salt = randomSalt();
  const hash = await hashPin(pin, salt);
  state.pinSalt = salt;
  state.pinHash = hash;
  localStorage.setItem("gr.pinSalt", salt);
  localStorage.setItem("gr.pinHash", hash);
  if ($("pinSet")) $("pinSet").value = "";
  updatePinHint();
  setSub("PIN saved");
}
function clearPin() {
  state.pinSalt = "";
  state.pinHash = "";
  localStorage.removeItem("gr.pinSalt");
  localStorage.removeItem("gr.pinHash");
  if ($("pinSet")) $("pinSet").value = "";
  updatePinHint();
  showLock(false);
  setSub("PIN cleared");
}

function renderPtr(px, ready, label) {
  const ptr = $("ptr");
  if (!ptr) return;
  const h = Math.max(0, Math.min(72, px | 0));
  ptr.style.height = h ? h + "px" : "";
  ptr.classList.toggle("ready", !!ready);
  if (label) ptr.textContent = label;
  else ptr.textContent = ready ? "Release to refresh" : "Pull to refresh";
}
async function reconnectNow() {
  if (state._refreshing) return;
  state._refreshing = true;
  renderPtr(36, true, "Refreshing…");
  setSub("Refreshing…");
  try {
    try { evtSource?.close(); } catch { /* ignore */ }
    evtSource = null;
    try { state.acp?.close(); } catch { /* ignore */ }
    state.acp = null;
    state._attachedId = null;
    state._connectPromise = null;
    state._connecting = false;
    await connect();
    await loadRoster();
    await loadAccountUsage({ force: true });
  } catch (err) {
    setSub("Refresh failed: " + err.message);
  } finally {
    state._refreshing = false;
    renderPtr(0, false);
  }
}
function wirePullToRefresh() {
  const view = $("rosterView");
  if (!view || view._ptrWired) return;
  view._ptrWired = true;
  let startY = 0;
  let startX = 0;
  let pulling = false;
  let dist = 0;
  view.addEventListener("scroll", () => closeOpenSwipes(), { passive: true });
  view.addEventListener("touchstart", (e) => {
    if (state.view !== "roster" || state._refreshing) return;
    if (view.scrollTop > 2) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    pulling = true;
    dist = 0;
  }, { passive: true });
  view.addEventListener("touchmove", (e) => {
    if (!pulling || state.view !== "roster") return;
    if (view.scrollTop > 2) {
      pulling = false;
      dist = 0;
      renderPtr(0, false);
      return;
    }
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      pulling = false;
      dist = 0;
      renderPtr(0, false);
      return;
    }
    dist = Math.max(0, dy);
    renderPtr(Math.min(dist * 0.55, 72), dist > 64);
  }, { passive: true });
  view.addEventListener("touchend", () => {
    if (!pulling) return;
    pulling = false;
    if (dist > 64) void reconnectNow();
    else renderPtr(0, false);
    dist = 0;
  });
}
async function connect() {
  if (state._connectPromise) return state._connectPromise;
  state._connecting = true;
  state._connectPromise = (async () => {
    void checkForAppUpdate();
    setSub("Pairing…");
    const pairRes = await fetch(api("/api/pair"), { cache: "no-store" });
    if (pairRes.status === 403) {
      throw new Error("Pairing is limited to devices on the same LAN as this PC.");
    }
    if (!pairRes.ok) throw new Error("pair HTTP " + pairRes.status);
    const pair = await pairRes.json();
    if (!pair.ws || !pair.secret) throw new Error("pair payload missing ws/secret");
    state.pair = pair;
    $("newCwd").value = pair.cwd || "";
    $("connInfo").textContent = `${pair.http}\nACP ${String(pair.ws).replace(/server-key=.*/, "server-key=…")}`;
    startAccountUsagePoll();
    void loadAccountUsage();
    armNotificationsSoon();
    await clearLegacyNotifications();
    await loadRoster();
    listenEvents();
    wireNativeNotify();
    wireWidgetOpen();
    wireHeadset();
    loadChangelog();
    startKeepalive();
    void applyPendingNotify();
    if (await consumeWidgetOpen()) {
      /* widget tap wins over last-session restore */
    } else if (!state._pendingNotify) maybeRestoreSession();
    if (state.view === "thread" && state.sessionId) {
      syncHeader("Connected");
      startLive(state.sessionId);
    } else {
      setSub(`${state.sessions.length} sessions · HTTP`);
    }
    connectBackoffMs = 1000;
    void flushOutbox();
    void consumeShare();
  })().finally(() => {
    state._connecting = false;
    state._connectPromise = null;
  });
  return state._connectPromise;
}

let evtSource = null;
function listenEvents() {
  try { evtSource?.close(); } catch { /* ignore */ }
  const secret = state.pair?.secret || "";
  evtSource = new EventSource(api("/api/events?secret=" + encodeURIComponent(secret)));
  evtSource.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "hello") return;
    if (msg.at && state.appOpenedAt && msg.at < state.appOpenedAt - 2000) return;
    if (msg.type === "needs_input") {
      const name = notifySessionName(msg.sessionId);
      const why = clipNotify(msg.summary || msg.activity || "", 120);
      void pushNotify(
        "Approval needed",
        why ? name + " — " + why : name + " is waiting on a decision",
        msg.sessionId,
        "needs"
      );
      const muted = state.notifyMuteUntil && Date.now() < state.notifyMuteUntil;
      if (!muted && msg.sessionId && state.view === "roster" && document.visibilityState === "visible" && !isHiddenSession(msg.sessionId)) openSession(msg.sessionId);
      loadRoster();
    }
    if (msg.type === "queue_changed") {
      if (msg.sessionId === state.sessionId && Array.isArray(msg.entries)) {
        state.pcQueue = msg.entries;
        renderQueue();
        if (msg.entries.length && state.turn?.active) setSub("Queued on PC");
      }
    }
    if (msg.type === "update" && msg.sessionId === state.sessionId && msg.update && state.view === "thread") {
      applyUpdate(msg.update, msg.eventId);
      scheduleRender();
    }
    if (msg.type === "uac_prompt") {
      void pushNotify(
        "UAC on the PC",
        msg.summary || "Windows needs administrator approval on this PC.",
        "",
        "uac"
      );
    }
    if (msg.type === "perm_wait") {
      presentLivePerm(msg);
    }
    if (msg.type === "perm_clear") {
      if (state.perm?.live && (!msg.toolCallId || state.perm.toolCallId === msg.toolCallId)) {
        state.perm = null;
        hideSheet();
        renderPerm();
      }
    }
    if (msg.type === "plan_ready") {
      const sid = msg.sessionId;
      if (sid && !(state._planOpenFor === sid && state._planShownAt && Date.now() - state._planShownAt < 15000)) {
        state._planOpenFor = sid;
        if (state.view === "roster" && document.visibilityState === "visible") openSession(sid);
        else if (state.sessionId === sid) void openPlanPreview({ user: true });
        void pushNotify(
          "Plan ready",
          notifySessionName(sid) + " — " + (msg.summary || "review the plan to continue"),
          sid,
          "needs"
        );
      }
      loadRoster();
    }
    if (msg.type === "plan_cleared") {
      if (msg.sessionId && state._planOpenFor === msg.sessionId) {
        state._planOpenFor = "";
        if (state.sessionId === msg.sessionId) {
          hidePlanSheet();
          setSub("Plan review closed on PC");
        }
      }
    }
    if (msg.type === "prompt_landed") {
      if (msg.sessionId === state.sessionId) setSub("Landed on PC");
      const summary = clipNotify(msg.summary || "", 120);
      void pushNotify(
        "Landed on PC",
        summary ? notifySessionName(msg.sessionId) + " — " + summary : notifySessionName(msg.sessionId),
        msg.sessionId,
        "landed"
      );
    }
    if (msg.type === "prompt_queued" && msg.sessionId === state.sessionId) {
      setSub("Queued on PC");
    }
    if (msg.type === "turn_complete") {
      if (msg.sessionId === state.sessionId) endTurn({ notify: false });
      maybeHearReply(msg.sessionId, msg.summary);
      const name = notifySessionName(msg.sessionId);
      const summary = notifyCaption(msg.sessionId) || clipNotify(msg.summary || "", 280);
      void pushNotify(
        name,
        summary || "Grok finished this pass",
        msg.sessionId,
        "done"
      );
      loadRoster();
    }
  };
}

function hideUpdateBanner() {
  $("updateBanner").classList.add("hidden");
  $("updateBanner").hidden = true;
}
function canDownloadInsideApp() {
  return typeof capPlugins().GrokGlance?.downloadApk === "function";
}
function updateApkUrl(manifest) {
  let url = manifest?.downloadUrl || "/downloads/Grok-Remote.apk";
  if (url.startsWith("/")) url = gatewayBase() + url;
  return url;
}
function isLanApkUrl(url) {
  try {
    if (String(url).includes("..")) return false;
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    if (u.pathname.includes("..") || !/\.apk$/i.test(u.pathname)) return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost") return true;
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const a = m.slice(1).map((x) => Number(x));
    if (a[0] === 10 || a[0] === 127) return true;
    if (a[0] === 192 && a[1] === 168) return true;
    if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
    return false;
  } catch {
    return false;
  }
}
async function downloadUpdateInsideApp(manifest) {
  if (state._apkDownload || !canDownloadInsideApp()) return;
  const url = updateApkUrl(manifest);
  if (!isLanApkUrl(url)) return;
  state._apkDownload = true;
  const btn = $("btnUpdateDownload");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Downloading…";
  }
  const notes = $("updateNotes");
  if (notes && !$("updateBanner").hidden) notes.textContent = "Saving the new app from this PC…";
  try {
    const result = await capPlugins().GrokGlance.downloadApk({ url });
    if (btn) {
      btn.disabled = false;
      btn.textContent = result?.needsPermission ? "Allow install" : "Install";
    }
    if (notes && !$("updateBanner").hidden) {
      notes.textContent = result?.needsPermission
        ? "Allow this app to install updates, then tap Install."
        : "The update is saved on this phone. Confirm the install.";
    }
  } catch (err) {
    state._apkDownload = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Download APK";
    }
    if (notes && !$("updateBanner").hidden) notes.textContent = err?.message || "Could not save the update.";
  }
}
function showUpdateBanner(manifest) {
  const latest = String(manifest.latestVersion || "").trim();
  if (!latest) return hideUpdateBanner();
  if (!manifest.forceUpdate && state.dismissedUpdate === latest) return hideUpdateBanner();
  state.updateManifest = manifest;
  $("updateTitle").textContent = manifest.forceUpdate ? `Update required: v${latest}` : `Update available: v${latest}`;
  if (!state._apkDownload) $("updateNotes").textContent = manifest.releaseNotes || `You have v${APP_VERSION}.`;
  $("updateBanner").classList.toggle("force", !!manifest.forceUpdate);
  $("updateBanner").classList.remove("hidden");
  $("updateBanner").hidden = false;
}

async function checkForAppUpdate() {
  try {
    const data = await fetch(api("/api/app/manifest"), { cache: "no-store" }).then((r) => r.json());
    $("verInfo").textContent = `App ${APP_VERSION} · Grok Build ${state.grokBuild || data.grokBuild || "?"} · gateway ${data.serverVersion || data.latestVersion} · latest APK ${data.latestVersion}${data.apkPresent ? "" : " (APK not published yet)"}`;
    if (data.grokBuild) setSplashVersions(data);
    const newer = compareSemver(data.latestVersion, APP_VERSION) > 0;
    const belowMin = compareSemver(APP_VERSION, data.minVersion || "0") < 0;
    if (!newer && !belowMin) {
      hideUpdateBanner();
    } else {
      if (belowMin || data.forceUpdate) data.forceUpdate = true;
      state.updateManifest = data;
      showUpdateBanner(data);
      if (data.apkPresent !== false) void downloadUpdateInsideApp(data);
    }
    const apkLink = $("btnGetApk");
    apkLink.href = data.downloadUrl || "/downloads/Grok-Remote.apk";
    apkLink.classList.toggle("hidden", data.apkPresent === false && !newer);
  } catch (err) {
    $("verInfo").textContent = "Could not read app manifest: " + err.message;
  }
}

async function loadChangelog() {
  try {
    const data = await fetch(api("/api/app/changelog"), { cache: "no-store" }).then((r) => r.json());
    const entries = data.entries || [];
    $("changelog").innerHTML = entries.map((e) => `
      <div class="cl-entry">
        <strong>v${escapeHtml(e.version)}</strong> · ${escapeHtml(e.date)} — ${escapeHtml(e.title || "")}
        <ul>${(e.notes || []).map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
      </div>`).join("") || "<p class='mute'>No changelog yet.</p>";
  } catch {
    $("changelog").textContent = "Changelog unavailable.";
  }
}

function openUpdateDownload() {
  if (canDownloadInsideApp()) {
    state._apkDownload = false;
    void downloadUpdateInsideApp(state.updateManifest || {});
    return;
  }
  let url = updateApkUrl(state.updateManifest || {});
  const a = document.createElement("a");
  a.href = url;
  a.setAttribute("download", "Grok-Remote.apk");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function hideFind() {
  $("findBar")?.classList.add("hidden");
  document.querySelectorAll(".find-on").forEach((el) => el.classList.remove("find-on"));
}
function itemSearchBlob(it) {
  return [it.text, it.title, it.detail, it.blurb, it.pattern, it.toolName, it.command, englishToolName(it.toolName), it.kind === "tool" || it.kind === "task" ? toolLineLabel(it) : ""]
    .map((s) => String(s || ""))
    .join("\n")
    .toLowerCase();
}
function findHits(q) {
  const needle = String(q || "").trim().toLowerCase();
  if (needle.length < 2) return [];
  return state.items
    .map((it, i) => ({ it, i }))
    .filter((x) => x.it.kind !== "wait" && itemSearchBlob(x.it).includes(needle));
}
function refreshFindCount() {
  const q = $("findQ")?.value || "";
  const hits = findHits(q);
  const el = $("findCount");
  if (!el) return;
  if (q.trim().length < 2) { el.textContent = ""; return; }
  if (!hits.length) { el.textContent = "0"; return; }
  if (state.findIdx == null || state.findIdx >= hits.length) state.findIdx = 0;
  el.textContent = (state.findIdx + 1) + "/" + hits.length;
}
function jumpToItem(i, emptyLabel) {
  if (i < 0) {
    setSub(emptyLabel || "Nothing to jump to");
    return;
  }
  const node = document.querySelector(`#thread [data-i="${i}"]`);
  if (!node) {
    setSub(emptyLabel || "Nothing to jump to");
    return;
  }
  let parent = node.parentElement;
  while (parent) {
    if (parent.classList?.contains("collapsed")) parent.classList.remove("collapsed");
    if (parent.tagName === "DETAILS" && !parent.open) parent.open = true;
    parent = parent.parentElement;
  }
  state.stickBottom = false;
  updateJumpBtn();
  document.querySelectorAll(".find-on").forEach((el) => el.classList.remove("find-on"));
  node.classList.add("find-on");
  node.scrollIntoView({ block: "center" });
}
function itemIndexes(pred) {
  const out = [];
  state.items.forEach((it, i) => { if (pred(it)) out.push(i); });
  return out;
}
function plainReply(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function syncReadBtn() {
  const btn = $("btnRead");
  if (!btn) return;
  btn.textContent = state.speaking ? "Stop" : "Read aloud";
  btn.classList.toggle("on", !!state.speaking);
}
async function stopReadAloud() {
  state.speaking = false;
  syncReadBtn();
  try { await capPlugins().GrokSpeech?.stop?.(); } catch { /* ignore */ }
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}
async function speakText(text) {
  const spoken = plainReply(text).slice(0, 4000);
  if (!spoken) return false;
  const Speech = capPlugins().GrokSpeech;
  if (Speech?.speak) {
    state.speaking = true;
    syncReadBtn();
    try {
      await Speech.speak({ text: spoken });
      return true;
    } catch {
      state.speaking = false;
      syncReadBtn();
      return false;
    }
  }
  if (window.speechSynthesis) {
    const utter = new SpeechSynthesisUtterance(spoken);
    utter.onend = () => { state.speaking = false; syncReadBtn(); };
    utter.onerror = () => { state.speaking = false; syncReadBtn(); };
    state.speaking = true;
    syncReadBtn();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    return true;
  }
  return false;
}
function maybeHearReply(sessionId, summary) {
  const hear = state._hearReply;
  if (!hear || hear.sessionId !== sessionId) return;
  if (Date.now() - hear.at > 15 * 60 * 1000) {
    state._hearReply = null;
    return;
  }
  state._hearReply = null;
  const text = summary || lastAgentItem()?.text || "";
  if (!plainReply(text)) return;
  void speakText(text);
}
async function readLastReply() {
  if (state.speaking) {
    await stopReadAloud();
    return;
  }
  const last = lastAgentItem();
  const text = plainReply(last?.text || "");
  if (!text) {
    setSub("Nothing to read");
    return;
  }
  const ok = await speakText(text);
  if (!ok) setSub("This phone can't read aloud");
}
function renderUndo() {
  const bar = $("undoBar");
  if (!bar) return;
  const show = undoStillAllowed(state.undo, Date.now(), state.undo ? replyStartedSince(state.undo.at) : false);
  bar.classList.toggle("hidden", !show);
}
function dismissUndoIfStarted() {
  if (!state.undo) return;
  if (undoStillAllowed(state.undo, Date.now(), replyStartedSince(state.undo.at))) return;
  state.undo = null;
  clearTimeout(state._undoTimer);
  renderUndo();
}
function armUndo(undo) {
  state.undo = undo;
  renderUndo();
  clearTimeout(state._undoTimer);
  state._undoTimer = setTimeout(() => {
    state.undo = null;
    renderUndo();
  }, 6000);
}
function removeOptimisticSend(text, at) {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i];
    if (it.kind === "user" && it.text === text && Number(it.at || 0) >= at - 1000) {
      state.items.splice(i, 1);
      break;
    }
  }
  renderThread();
}
function undoSend() {
  const undo = state.undo;
  if (!undoStillAllowed(undo, Date.now(), replyStartedSince(undo?.at))) {
    state.undo = null;
    renderUndo();
    setSub("Too late — Grok already started");
    return;
  }
  state.undo = null;
  clearTimeout(state._undoTimer);
  renderUndo();
  state._hearReply = null;
  void cancelSessionTurn(undo.sessionId);
  removeOptimisticSend(undo.text, undo.at);
  const ta = $("prompt");
  if (ta) ta.value = undo.text || "";
  state.attachments = Array.isArray(undo.images) ? undo.images.slice() : [];
  renderAttach();
  endTurn({ notify: false });
  setSub("Send undone");
}
function outboxLoad() {
  try { return JSON.parse(localStorage.getItem("gr.outbox") || "[]"); } catch { return []; }
}
function outboxSave(list) {
  try { localStorage.setItem("gr.outbox", JSON.stringify((list || []).slice(0, 20))); } catch { /* ignore */ }
}
function parkOutbox(sessionId, text, images) {
  const imgs = [];
  let bytes = 0;
  for (const img of images || []) {
    const b64 = String(img?.b64 || "");
    if (!b64 || bytes + b64.length > 300000) continue;
    bytes += b64.length;
    imgs.push({ name: img.name || "image", mime: img.mime || "image/jpeg", dataUrl: img.dataUrl || "", b64 });
  }
  const list = outboxLoad();
  list.push({ sessionId, text: String(text || ""), images: imgs, at: Date.now() });
  outboxSave(list);
}
async function flushOutbox() {
  if (state._flushingOutbox || !state.pair) return;
  const list = outboxLoad();
  if (!list.length) return;
  try {
    const h = await fetch(api("/api/health"), { cache: "no-store" });
    if (!h.ok) return;
  } catch {
    return;
  }
  state._flushingOutbox = true;
  const rest = [];
  for (const item of list) {
    try {
      await sendPrompt(item.text, {
        now: true,
        images: item.images || [],
        sessionId: item.sessionId,
        fromOutbox: true,
      });
    } catch {
      rest.push(item);
    }
  }
  outboxSave(rest);
  state._flushingOutbox = false;
  if (list.length !== rest.length) setSub(rest.length ? "Sent what it could" : "Sent the saved message");
}
function addImageDataUrl(dataUrl, name) {
  const raw = String(dataUrl || "");
  const m = raw.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return false;
  state.attachments = state.attachments || [];
  state.attachments.push({
    name: name || "image",
    mime: m[1] || "image/jpeg",
    dataUrl: raw,
    b64: m[2],
  });
  renderAttach();
  return true;
}
async function consumeShare() {
  const G = capPlugins().GrokGlance;
  if (!G?.getPendingShare || !state.pair) return;
  let dataUrl = "";
  let shareError = "";
  try {
    const r = await G.getPendingShare();
    dataUrl = String(r?.dataUrl || "");
    shareError = String(r?.error || "");
  } catch {
    return;
  }
  if (!dataUrl) {
    if (shareError) setSub(shareError === "too big" ? "That photo is too large to attach" : "Couldn't attach that photo");
    return;
  }
  if (state.view !== "thread" || !state.sessionId) {
    const id = dictationTargetId();
    if (id) await openSession(id);
  }
  if (addImageDataUrl(dataUrl, "shared-photo")) setSub("Photo attached");
  else setSub("Couldn't attach that photo");
}
function cycleJump(kind) {
  const idxs = kind === "error"
    ? itemIndexes((it) => it.kind === "tool" && /fail|error/i.test(String(it.status || "")))
    : itemIndexes((it) => it.kind === "user" && String(it.text || "").trim());
  const empty = kind === "error" ? "No error in this chat" : "No message in this chat";
  if (!idxs.length) {
    setSub(empty);
    return;
  }
  const key = kind === "error" ? "jumpErr" : "jumpUser";
  if (state._jumpSession !== state.sessionId) {
    state._jumpSession = state.sessionId;
    state.jumpUser = null;
    state.jumpErr = null;
  }
  let pos = state[key];
  if (pos == null || pos < 0 || pos >= idxs.length) pos = idxs.length - 1;
  else pos = (pos - 1 + idxs.length) % idxs.length;
  state[key] = pos;
  jumpToItem(idxs[pos], empty);
  setSub((pos + 1) + " of " + idxs.length);
}
function jumpFind(delta) {
  const hits = findHits($("findQ")?.value || "");
  if (!hits.length) {
    refreshFindCount();
    return;
  }
  state.findIdx = ((state.findIdx || 0) + delta + hits.length) % hits.length;
  refreshFindCount();
  document.querySelectorAll(".find-on").forEach((el) => el.classList.remove("find-on"));
  const node = document.querySelector(`[data-i="${hits[state.findIdx].i}"]`);
  if (node) {
    state.stickBottom = false;
    updateJumpBtn();
    node.classList.add("find-on");
    node.scrollIntoView({ block: "center" });
  }
}

let speechRec = null;
function stopMic() {
  try { speechRec?.stop(); } catch { /* ignore */ }
  speechRec = null;
  $("btnMic")?.classList.remove("listening");
}
async function toggleMic() {
  const Speech = capPlugins().GrokSpeech;
  if (Speech && typeof Speech.start === "function") {
    $("btnMic")?.classList.add("listening");
    setSub("Listening…");
    try {
      const r = await Speech.start();
      const text = String(r?.text || "").trim();
      if (text) {
        const ta = $("prompt");
        if (ta) {
          const pad = ta.value && !/\s$/.test(ta.value) ? " " : "";
          ta.value += pad + text;
          ta.focus();
        }
        setSub("Dictation added");
      } else setSub("No speech captured");
    } catch (err) {
      const msg = String(err?.message || err || "cancelled");
      setSub(/cancel/i.test(msg) ? "Mic cancelled" : "Mic: " + msg);
    }
    $("btnMic")?.classList.remove("listening");
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setSub("Dictation needs the installed APK (mic plugin).");
    return;
  }
  if (speechRec) {
    stopMic();
    return;
  }
  const rec = new SR();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (ev) => {
    let final = "";
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) final += t;
      else interim += t;
    }
    const ta = $("prompt");
    if (!ta) return;
    if (final) {
      const pad = ta.value && !/\s$/.test(ta.value) ? " " : "";
      ta.value += pad + final.trim();
      state._micInterim = "";
    } else {
      state._micInterim = interim;
    }
  };
  rec.onerror = () => stopMic();
  rec.onend = () => {
    if (speechRec === rec) stopMic();
  };
  speechRec = rec;
  $("btnMic")?.classList.add("listening");
  try { rec.start(); } catch (err) {
    stopMic();
    setSub("Mic failed: " + err.message);
  }
}

function bindUi() {
  wirePullToRefresh();
  $("acctUsageBtn")?.addEventListener("click", () => {
    if (state.view !== "roster") showView("roster");
  });
  $("btnBack").addEventListener("click", () => { goBack(); });
  $("btnSettings").addEventListener("click", () => {
    showView(state.view === "settings" ? "roster" : "settings");
    if (state.view === "settings") { checkForAppUpdate(); loadChangelog(); }
  });
  $("btnNew").addEventListener("click", () => showView("new"));
  $("search").addEventListener("input", () => {
    renderRoster();
    clearTimeout(state._searchTimer);
    const q = ($("search")?.value || "").trim();
    if (q.length < 2) {
      state.messageHits = [];
      renderMessageHits();
      return;
    }
    state._searchTimer = setTimeout(() => { void loadMessageHits(q); }, 300);
  });
  $("btnNeedsOnly")?.addEventListener("click", () => {
    state.showNeedsOnly = !state.showNeedsOnly;
    renderRoster();
  });
  $("btnShowHidden")?.addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    renderRoster();
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    hideHist();
    hideSheet();
    $("slashList").classList.add("hidden");
    $("atList")?.classList.add("hidden");
    const text = $("prompt").value.trim();
    $("prompt").value = "";
    sendPrompt(text);
  });
  $("prompt").addEventListener("input", () => { saveDraft(); void onPromptAtSuggest(); });
  $("prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("thread")?.addEventListener("scroll", onThreadScroll, { passive: true });
  $("thread")?.addEventListener("touchstart", () => { state._ignoreScroll = false; }, { passive: true });
  $("thread")?.addEventListener("pointerdown", () => { state._ignoreScroll = false; }, { passive: true });
  $("btnJump")?.addEventListener("click", jumpToBottom);
  $("btnStop").addEventListener("click", cancelTurn);
  $("btnUndo")?.addEventListener("click", undoSend);
  $("btnStartSession").addEventListener("click", () => startNew().catch((err) => setSub(err.message)));
  $("btnReconnect").addEventListener("click", () => connect().catch((err) => setSub(err.message)));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void heartbeat();
  });
  window.addEventListener("online", () => {
    connectBackoffMs = 1000;
    void heartbeat();
  });
  $("btnCheckUpdate").addEventListener("click", () => { state.dismissedUpdate = ""; checkForAppUpdate(); });
  $("btnUpdateDownload").addEventListener("click", openUpdateDownload);
  $("btnUpdateDismiss").addEventListener("click", () => {
    const v = state.updateManifest?.latestVersion;
    if (v) { state.dismissedUpdate = v; localStorage.setItem("gr.dismissedUpdate", v); }
    hideUpdateBanner();
  });
  $("btnChangelogMini").addEventListener("click", () => {
    showView("settings");
    loadChangelog();
    setTimeout(() => $("changelog")?.scrollIntoView({ block: "start" }), 50);
  });
  $("notifyNeeds").checked = state.notifyNeeds;
  $("notifyDone").checked = state.notifyDone;
  if ($("quietHours")) $("quietHours").checked = state.quietHours;
  if ($("headsetDictate")) $("headsetDictate").checked = state.headsetDictate;
  if ($("speakSteps")) $("speakSteps").checked = state.speakSteps;
  $("notifyNeeds").addEventListener("change", () => {
    state.notifyNeeds = $("notifyNeeds").checked;
    localStorage.setItem("gr.notifyNeeds", state.notifyNeeds ? "1" : "0");
  });
  $("notifyDone").addEventListener("change", () => {
    state.notifyDone = $("notifyDone").checked;
    localStorage.setItem("gr.notifyDone", state.notifyDone ? "1" : "0");
  });
  $("quietHours")?.addEventListener("change", () => {
    state.quietHours = $("quietHours").checked;
    localStorage.setItem("gr.quietHours", state.quietHours ? "1" : "0");
  });
  $("headsetDictate")?.addEventListener("change", () => {
    state.headsetDictate = $("headsetDictate").checked;
    localStorage.setItem("gr.headset", state.headsetDictate ? "1" : "0");
    try { capPlugins().GrokGlance?.setHeadset?.({ enabled: state.headsetDictate }); } catch { /* ignore */ }
  });
  $("speakSteps")?.addEventListener("change", () => {
    state.speakSteps = $("speakSteps").checked;
    localStorage.setItem("gr.speakSteps", state.speakSteps ? "1" : "0");
    state._lastSpokenStep = "";
  });
  $("btnEnableNotif").addEventListener("click", async () => {
    const LN = capPlugins().LocalNotifications;
    if (LN) {
      const p = await LN.requestPermissions();
      setSub(p?.display === "granted" || p?.granted ? "Notifications enabled" : "Notifications blocked");
      wireNativeNotify();
      return;
    }
    if (!("Notification" in window)) return setSub("Notifications not supported");
    const perm = await Notification.requestPermission();
    setSub(perm === "granted" ? "Notifications enabled" : "Notifications blocked");
  });
  if ($("bioEnabled")) {
    $("bioEnabled").checked = state.bioEnabled;
    $("bioEnabled").addEventListener("change", () => {
      state.bioEnabled = $("bioEnabled").checked;
      localStorage.setItem("gr.bioEnabled", state.bioEnabled ? "1" : "0");
    });
  }
  $("btnSetPin")?.addEventListener("click", () => { void savePin(); });
  $("btnClearPin")?.addEventListener("click", clearPin);
  $("btnUnlock")?.addEventListener("click", () => { void unlockWithPin(); });
  $("pinUnlock")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void unlockWithPin(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) state._hidAt = Date.now();
    else if (pinConfigured() && state._hidAt && Date.now() - state._hidAt > 15000) maybeShowLock();
  });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("#slashList, #atList, #histList, #btnSlash, #btnAt, #btnHistory, #sheet .sheet-card, #planSheet .plan-card")) return;
    hidePopovers();
  }, true);
  $("btnSlash").addEventListener("click", () => {
    hideHist();
    hideSheet();
    $("atList")?.classList.add("hidden");
    const box = $("slashList");
    const fromAcp = (state.commands || []).map((c) => ({ name: c.name, description: c.description || "" }));
    const names = new Set(fromAcp.map((c) => c.name));
    for (const bcmd of BUILTIN_CMDS) {
      if (!names.has(bcmd.name)) fromAcp.push(bcmd);
    }
    const cmds = fromAcp.length ? fromAcp : BUILTIN_CMDS;
    box.classList.toggle("hidden");
    box.innerHTML = cmds.map((c) => `<button type="button" data-name="${escapeHtml(c.name)}">/${escapeHtml(c.name)} — ${escapeHtml(c.description || "")}</button>`).join("");
    box.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        const name = b.getAttribute("data-name");
        const builtin = BUILTIN_CMDS.find((c) => c.name === name);
        const run = builtin?.run || "";
        const confirmMsg = builtin?.confirm || "";
        box.classList.add("hidden");
        if (run === "usage") { void loadMeta(state.sessionId).then(showUsageSheet); return; }
        if (run === "todos") { showTodosSheet(); return; }
        if (run === "rewind") { void showRewindSheet(); return; }
        if (run === "compact") { showCompactSheet(); return; }
        if (run === "fork") { confirmFork(); return; }
        if (run === "export") { showExportSheet(); return; }
        if (run === "copy") { copyText(lastAgentItem()?.text || ""); return; }
        if (run === "remember") { showRememberSheet(); return; }
        if (run === "rename") { openRenameSheet(state.sessionId, state.title || ""); return; }
        if (run === true || run === "true") {
          if (confirmMsg && !window.confirm(confirmMsg)) return;
          void sendSlash("/" + name);
          return;
        }
        $("prompt").value = "/" + name + " ";
        $("prompt").focus();
      });
    });
  });
  $("btnHistory")?.addEventListener("click", () => {
    $("slashList").classList.add("hidden");
    $("atList")?.classList.add("hidden");
    hideSheet();
    toggleHist();
  });
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-mode");
      if (id === "plan" && state.mode === "plan") {
        void openPlanPreview({ user: true });
        return;
      }
      void applyMode(id);
    });
  });
  $("chipMode")?.addEventListener("click", () => {
    hideHist();
    if (state.mode === "plan") {
      void openPlanPreview({ user: true });
      return;
    }
    openSheet("Mode", MODE_OPTS, state.mode, (id) => { void applyMode(id); });
  });
  $("planApprove")?.addEventListener("click", () => resolvePlan("approve"));
  $("planRevise")?.addEventListener("click", () => resolvePlan("revise"));
  $("planQuit")?.addEventListener("click", () => resolvePlan("quit"));
  $("planBarApprove")?.addEventListener("click", () => resolvePlan("approve"));
  $("planBarRevise")?.addEventListener("click", () => resolvePlan("revise"));
  $("planBarQuit")?.addEventListener("click", () => resolvePlan("quit"));
  $("planCopy")?.addEventListener("click", () => {
    if (state.planMarkdown) copyText(state.planMarkdown);
  });
  $("frameTitle")?.addEventListener("click", () => {
    if (!state.sessionId) return;
    openRenameSheet(state.sessionId, state.title || "");
  });
  $("frameModel")?.addEventListener("click", () => {
    hideHist();
    const models = MODEL_OPTS.map((m) => ({ id: "model:" + m.id, label: m.label }));
    const efforts = EFFORT_OPTS.map((id) => ({ id: "effort:" + id, label: "Effort · " + id }));
    openSheet("Model and effort", [...models, ...efforts], "model:" + (state.model || ""), (id) => {
      const act = frameTapAction(id);
      if (!act) return;
      if (act.kind === "effort") void applyEffort(act.value);
      else void applyModel(act.value);
    });
  });
  $("chipModel")?.addEventListener("click", () => {
    hideHist();
    const models = MODEL_OPTS.slice();
    if (state.model && !models.some((m) => m.id === state.model)) {
      models.unshift({ id: state.model, label: state.model });
    }
    openSheet("Model", models, state.model, (id) => { void applyModel(id); });
  });
  $("chipEffort")?.addEventListener("click", () => {
    hideHist();
    openSheet("Effort", EFFORT_OPTS.map((id) => ({ id, label: id })), state.effort, (id) => { void applyEffort(id); });
  });
  $("chipUsage")?.addEventListener("click", () => {
    hideHist();
    void loadMeta(state.sessionId).then(() => {
      const pct = state.usage?.percent;
      if (pct != null && Number(pct) >= 80) showCompactSheet();
      else showUsageSheet();
    });
  });
  $("chipTodos")?.addEventListener("click", () => {
    hideHist();
    showTodosSheet();
  });
  $("sheetCancel")?.addEventListener("click", () => hideSheet({ cancel: true }));
  $("sheet")?.addEventListener("click", (e) => { if (e.target === $("sheet")) hideSheet(); });
  $("btnAt")?.addEventListener("click", () => {
    hidePopovers();
    void openFileBrowser(state.fsRel || "");
  });
  $("btnAttach")?.addEventListener("click", () => {
    hideHist();
    openSheet("Attach image", [
      { id: "camera", label: "Take photo" },
      { id: "gallery", label: "Photo library" },
    ], "", (id) => {
      if (id === "camera") $("fileCamera")?.click();
      else $("fileAttach")?.click();
    });
  });
  $("fileAttach")?.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) addImageFile(f);
    e.target.value = "";
  });
  $("fileCamera")?.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) addImageFile(f);
    e.target.value = "";
  });
  $("btnMic")?.addEventListener("click", toggleMic);
  $("photoViewClose")?.addEventListener("click", closePhoto);
  bindPhotoZoom();
  $("btnRead")?.addEventListener("click", () => { void readLastReply(); });
  $("btnCatchUp")?.addEventListener("click", () => {
    if (!(state.catchUpIndex >= 0)) return;
    jumpToItem(state.catchUpIndex, "You are already caught up");
  });
  $("btnNow")?.addEventListener("click", jumpToNow);
  $("btnQuiet")?.addEventListener("click", () => {
    state.quietView = !state.quietView;
    localStorage.setItem("gr.quietView", state.quietView ? "1" : "0");
    syncQuietBtn();
    renderThread();
  });
  $("btnProblems")?.addEventListener("click", () => {
    state.problemsOnly = !state.problemsOnly;
    localStorage.setItem("gr.problems", state.problemsOnly ? "1" : "0");
    if (state.problemsOnly) state._scrollFail = true;
    syncQuietBtn();
    renderThread();
  });
  $("btnToday")?.addEventListener("click", () => {
    state.todayOnly = !state.todayOnly;
    localStorage.setItem("gr.today", state.todayOnly ? "1" : "0");
    syncQuietBtn();
    renderThread();
  });
  $("liveChip")?.addEventListener("click", onLiveChip);
  $("chatNote")?.addEventListener("input", saveChatNote);
  syncQuietBtn();
  $("btnJumpUser")?.addEventListener("click", () => cycleJump("user"));
  $("btnJumpErr")?.addEventListener("click", () => cycleJump("error"));
  $("btnFind")?.addEventListener("click", () => {
    const bar = $("findBar");
    if (!bar) return;
    const on = bar.classList.contains("hidden");
    bar.classList.toggle("hidden", !on);
    if (on) {
      $("findQ")?.focus();
      refreshFindCount();
    }
  });
  $("findQ")?.addEventListener("input", () => { state.findIdx = 0; refreshFindCount(); });
  $("findQ")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpFind(e.shiftKey ? -1 : 1);
    }
    if (e.key === "Escape") hideFind();
  });
  $("findNext")?.addEventListener("click", () => jumpFind(1));
  $("findPrev")?.addEventListener("click", () => jumpFind(-1));
  $("findClose")?.addEventListener("click", hideFind);
  document.addEventListener("paste", (e) => {
    if (state.view !== "thread") return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        e.preventDefault();
        const f = it.getAsFile();
        if (f) addImageFile(f);
      }
    }
  });
}

function hideHist() {
  $("histList")?.classList.add("hidden");
}
function hidePopovers() {
  $("slashList")?.classList.add("hidden");
  $("atList")?.classList.add("hidden");
  hideHist();
}
function toggleHist() {
  const box = $("histList");
  if (!box) return;
  if (!box.classList.contains("hidden")) {
    box.classList.add("hidden");
    return;
  }
  const rows = state.prompts || [];
  if (!rows.length) {
    box.innerHTML = `<div class="empty">No earlier commands yet. Send a message and it will be listed here.</div>`;
    box.classList.remove("hidden");
    return;
  }
  box.innerHTML = rows.map((p, i) => {
    const src = p.source === "app" ? "app" : "pc";
    const label = src === "app" ? "App" : "PC";
    return `<button type="button" data-i="${i}"><span class="src ${src}">${label}</span><span class="hist-text">${escapeHtml(p.text)}</span></button>`;
  }).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.getAttribute("data-i"));
      const row = state.prompts[i];
      if (!row) return;
      $("prompt").value = row.text;
      box.classList.add("hidden");
      $("prompt").focus();
    });
  });
  box.classList.remove("hidden");
}

let keepTimer = null;
function startKeepalive() {
  if (keepTimer) return;
  keepTimer = setInterval(() => { void heartbeat(); }, 20000);
}
async function heartbeat() {
  if (state._connecting || state._prompting || state.turn?.active) return;
  try {
    const h = await fetch(api("/api/health"), { cache: "no-store" });
    if (!h.ok) throw new Error("health " + h.status);
    const d = await h.json().catch(() => ({}));
    if (d && d.ok) setSplashVersions(d);
  } catch {
    scheduleReconnect("health");
    return;
  }
  if (state.acp?.ready) {
    try {
      await state.acp.request("session/list", {}, 8000);
    } catch {
      state._attachedId = null;
      try { state.acp.close(); } catch { /* ignore */ }
      state.acp = null;
    }
  }
}

async function healthGw(url, ms = 4000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(String(url).replace(/\/+$/, "") + "/api/health", { cache: "no-store", signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    if (d && d.ok && d.name === "grok-remote") {
      setSplashVersions(d);
      return d;
    }
    return null;
  } catch {
    return null;
  }
}

async function chooseGateway(url) {
  state.gateway = String(url).replace(/\/+$/, "");
  localStorage.setItem("gr.gateway", state.gateway);
  $("connectOverlay")?.classList.add("hidden");
  await connect();
}

function lanScanHosts() {
  const hosts = [];
  for (const prefix of ["10.0.0.", "192.168.1.", "192.168.0.", "10.0.1."]) {
    for (let i = 1; i <= 40; i++) hosts.push(prefix + i);
  }
  return hosts;
}
async function scanGateway() {
  const hosts = lanScanHosts();
  for (let i = 0; i < hosts.length; i += 8) {
    const chunk = [...new Set(hosts.slice(i, i + 8))];
    const hits = await Promise.all(chunk.map(async (h) => {
      const url = "http://" + h + ":2420";
      return (await healthGw(url, 1200)) ? url : null;
    }));
    const found = hits.find(Boolean);
    if (found) return found;
  }
  return null;
}

async function boot() {
  state.appOpenedAt = Date.now();
  bindKeyboardInset();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.view === "thread") cacheTranscript(state.sessionId);
  });
  armNotificationsSoon();
  wireNativeNotify();
  wireWidgetOpen();
  wireHeadset();
  await new Promise((r) => setTimeout(r, 200));
  await clearLegacyNotifications();
  setSplashVersions();
  updatePinHint();
  maybeShowLock();
  showView("roster");
  const overlay = $("connectOverlay");
  const saved = localStorage.getItem("gr.gateway") || "";
  if ($("gatewayUrl")) $("gatewayUrl").value = saved;
  const onGatewayPort = location.port === "2420";
  if (onGatewayPort && (await healthGw(location.origin, 1500))) {
    state.gateway = location.origin;
    await connect();
    return;
  }
  if (NATIVE && overlay) overlay.classList.remove("hidden");
  if (await healthGw(saved, 4000)) {
    await chooseGateway(saved);
    return;
  }
  if (!NATIVE) {
    state.gateway = location.origin;
    await connect();
    return;
  }
  if ($("connectStatus")) $("connectStatus").textContent = "Type the PC gateway URL (port 2420) and tap Connect.";
}

$("btnConnectGw")?.addEventListener("click", async () => {
  const url = ($("gatewayUrl")?.value || "").trim();
  if ($("connectStatus")) $("connectStatus").textContent = "Connecting…";
  if (!(await healthGw(url, 5000))) {
    if ($("connectStatus")) $("connectStatus").textContent = "No gateway at that URL. Start node server.mjs on the PC.";
    return;
  }
  await chooseGateway(url);
});
$("btnScanGw")?.addEventListener("click", async () => {
  if ($("connectStatus")) $("connectStatus").textContent = "Scanning LAN…";
  const found = await scanGateway();
  if (!found) {
    if ($("connectStatus")) $("connectStatus").textContent = "Scan missed. Enter the PC address.";
    return;
  }
  if ($("gatewayUrl")) $("gatewayUrl").value = found;
  await chooseGateway(found);
});

if (window.Capacitor?.Plugins?.App) {
  window.Capacitor.Plugins.App.addListener("backButton", () => {
    if (!goBack()) window.Capacitor.Plugins.App.exitApp();
  });
}

bindUi();
boot().catch((err) => {
  setSub("Connect failed: " + err.message);
  $("roster").innerHTML = `<div class="empty err">${escapeHtml(err.message)}<br/>Is grok-remote running on this PC?</div>`;
  scheduleReconnect("boot");
});
