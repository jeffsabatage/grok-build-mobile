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
  todos: [],
  view: "roster",
  perm: null,
  dismissedUpdate: localStorage.getItem("gr.dismissedUpdate") || "",
  notifyNeeds: localStorage.getItem("gr.notifyNeeds") !== "0",
  notifyDone: localStorage.getItem("gr.notifyDone") !== "0",
  pinHash: localStorage.getItem("gr.pinHash") || "",
  pinSalt: localStorage.getItem("gr.pinSalt") || "",
  unlocked: false,
  bioEnabled: localStorage.getItem("gr.bioEnabled") !== "0",
  fsRel: "",
  starred: loadIdList("gr.starred"),
  hiddenIds: loadIdList("gr.hidden"),
  showHidden: false,
  grokBuild: "",
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
function goBack() {
  if ($("planSheet") && !$("planSheet").classList.contains("hidden")) {
    if (state.perm?.resolve && isPlanGateTool(state.perm.toolCall?.title || state.perm.title || "")) {
      resolvePlan("quit");
    } else hidePlanSheet();
    return true;
  }
  if (state.view === "thread" || state.view === "settings" || state.view === "new") {
    if (state.view === "thread") {
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

function activityChip(s) {
  const a = String(s.activity || "idle");
  let cls = "";
  if (/need|ask|permission|block|input/i.test(a)) cls = "need";
  else if (/work|run|busy|live/i.test(a)) cls = "work";
  else if (/idle|dormant|live/i.test(a) && s.resident) cls = "live";
  return `<span class="chip ${cls}">${escapeHtml(a)}</span>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderRoster() {
  const q = ($("search")?.value || "").toLowerCase();
  const hiddenN = state.hiddenIds.filter((id) => state.sessions.some((s) => s.sessionId === id)).length;
  const showBtn = $("btnShowHidden");
  if (showBtn) {
    showBtn.classList.toggle("hidden", hiddenN === 0);
    showBtn.textContent = state.showHidden ? `Showing hidden (${hiddenN})` : `Show hidden (${hiddenN})`;
  }
  let rows = state.sessions.filter((s) => {
    if (!state.showHidden && isHiddenSession(s.sessionId)) return false;
    if (!q) return true;
    return (s.title || "").toLowerCase().includes(q) || (s.cwd || "").toLowerCase().includes(q) || (s.lastTurnSummary || "").toLowerCase().includes(q);
  });
  rows = rows.slice().sort((a, b) => {
    const as = isStarred(a.sessionId);
    const bs = isStarred(b.sessionId);
    if (as && !bs) return -1;
    if (!as && bs) return 1;
    if (as && bs) return state.starred.indexOf(a.sessionId) - state.starred.indexOf(b.sessionId);
    return 0;
  });
  if (!rows.length) {
    $("roster").innerHTML = hiddenN && !state.showHidden
      ? `<div class="empty">Hidden sessions are tucked away. Tap <b>Show hidden</b> above, or swipe a hidden row and tap Show.</div>`
      : `<div class="empty">No sessions yet. Tap ＋ to start one.</div>`;
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
      </div>
      <div class="row-front">
        <div class="row" role="button">
          <div class="row-main">
            <div class="title">${activityChip(s)}${escapeHtml(s.title || "Untitled")}</div>
            <div class="meta">${escapeHtml(s.lastTurnSummary || s.cwd || "")}</div>
          </div>
          <button class="row-star${star ? " on" : ""}" type="button" title="${star ? "Unpin" : "Pin"}" aria-label="${star ? "Unpin" : "Pin"}">${star ? "\u2605" : "\u2606"}</button>
        </div>
      </div>
    </div>`;
  }).join("");
  $("roster").querySelectorAll(".row-wrap").forEach((wrap) => {
    const id = wrap.getAttribute("data-id");
    wrap.querySelector(".row").addEventListener("click", (e) => {
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
    wireRowSwipe(wrap);
    let hold = null;
    const startHold = () => {
      hold = setTimeout(() => { hold = null; openRosterMenu(id); }, 520);
    };
    const endHold = () => { if (hold) { clearTimeout(hold); hold = null; } };
    wrap.addEventListener("contextmenu", (e) => { e.preventDefault(); openRosterMenu(id); });
    wrap.addEventListener("touchstart", startHold, { passive: true });
    wrap.addEventListener("touchend", endHold);
    wrap.addEventListener("touchmove", endHold);
  });
}
const SWIPE_W = 88;
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
    if (cur < -SWIPE_W * 1.55) {
      wrap.querySelector(".swipe-hide")?.click();
      return;
    }
    setX(cur < -SWIPE_W * 0.42 ? -SWIPE_W : 0, true);
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
function onThreadScroll() {
  const el = $("thread");
  if (!el) return;
  const near = nearThreadBottom(el);
  if (state._ignoreScroll && near) return;
  state._ignoreScroll = false;
  state.stickBottom = near;
  updateJumpBtn();
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

function renderMarkdown(raw) {
  const src = String(raw || "").replace(/\r\n/g, "\n");
  const fences = [];
  let text = src.replace(/```([\s\S]*?)```/g, (_, code) => {
    const i = fences.length;
    fences.push(`<pre><code>${escapeHtml(code.replace(/^\n/, ""))}</code></pre>`);
    return `\u0000FENCE${i}\u0000`;
  });
  const lines = text.split("\n");
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
  for (const line of lines) {
    const fence = line.match(/^\u0000FENCE(\d+)\u0000$/);
    if (fence) {
      flushPara();
      flushList();
      out.push(fences[Number(fence[1])]);
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
  return out.join("") || `<p>${inlineMd(text)}</p>`;
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

function thinkSummary(it) {
  if (it.live || (state.turn.active && state.turn.phase === "thinking" && lastContentItem() === it)) {
    return "Thinking";
  }
  if (it.durationMs) return "Thought for " + fmtElapsed(it.durationMs);
  return "Thought";
}

function toolMark(it) {
  const st = String(it.status || "").toLowerCase();
  if (/fail|error/.test(st)) return { cls: "bad", mark: "✕" };
  if (/complete|success|ok|done/.test(st)) return { cls: "ok", mark: "◆" };
  return { cls: "run", mark: "◇" };
}

function renderThread() {
  const el = $("thread");
  const prevTop = el.scrollTop;
  const stick = state.stickBottom || nearThreadBottom(el);
  state.items.forEach((it, i) => { it._i = i; });
  el.innerHTML = groupedItems(state.items).map((it) => {
    if (it.kind === "user") {
      const time = fmtClock(it.at);
      return `<div class="bubble user" data-i="${it._i}">${escapeHtml(it.text)}${time ? `<div class="msg-time">${escapeHtml(time)}</div>` : ""}</div>`;
    }
    if (it.kind === "agent") {
      const time = fmtClock(it.at);
      const live = !!(it.live || (state.turn.active && lastAgentItem() === it));
      const foot = live
        ? "Writing…"
        : it.workedMs
          ? "Worked for " + fmtElapsed(it.workedMs)
          : "";
      return `<div class="reply" data-i="${it._i}">
        ${time ? `<div class="reply-time">${escapeHtml(time)}</div>` : ""}
        <div class="md">${renderMarkdown(it.text)}</div>
        <div class="reply-foot">${foot ? `<span>${escapeHtml(foot)}</span>` : `<span></span>`}<button type="button" class="copy-btn" data-i="${it._i}">Copy</button></div>
      </div>`;
    }
    if (it.kind === "think") {
      return `<details class="bubble think" open data-i="${it._i}"><summary>♦ ${escapeHtml(thinkSummary(it))}</summary><div class="think-body">${escapeHtml(it.text)}</div></details>`;
    }
    if (it.kind === "tool") return renderToolRow(it);
    if (it.kind === "toolgroup") return renderToolGroup(it);
    if (it.kind === "plan") return `<div class="tool ok"><span class="mark">◆</span>${escapeHtml(it.text.split("\n")[0] || "plan")}</div>`;
    return "";
  }).join("");
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
      if (d.open) state.openGroups.add(key);
      else state.openGroups.delete(key);
    });
  });
  if (stick) scrollThreadToEnd(true);
  else {
    el.scrollTop = prevTop;
    updateJumpBtn();
  }
  renderTurnStatus();
  renderChips();
  renderQueue();
  if (!$("findBar")?.classList.contains("hidden")) refreshFindCount();
}

function renderToolRow(it) {
  const m = toolMark(it);
  return `<div class="tool ${m.cls}"><span class="mark">${m.mark}</span>${escapeHtml(it.title || it.id || "tool")}</div>`;
}

function toolGroupKind(it) {
  const t = String(it.title || it.toolKind || "").toLowerCase();
  if (/\bexecute\b|\bbash\b|\bshell\b|\brun_terminal\b|\bterminal_command\b/.test(t)) return "execute";
  if (/\bsearch_replace\b|\bstr_replace\b|^edit\b|\bedits?\b|\bwrites?\b|\bwrite_file\b/.test(t)) return "edit";
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
  const flush = () => {
    if (!buf.length) return;
    const kind = toolGroupKind(buf[0]);
    const collapseOne = kind === "execute" || kind === "edit";
    if (kind && (buf.length >= 2 || collapseOne)) {
      out.push({
        kind: "toolgroup",
        group: kind,
        items: buf.slice(),
        key: kind + ":" + (buf[0].id || "") + ":" + buf.length,
      });
    } else out.push(...buf);
    buf = [];
  };
  for (const it of items) {
    const k = it.kind === "tool" ? toolGroupKind(it) : null;
    if (k && buf.length && toolGroupKind(buf[0]) === k) buf.push(it);
    else {
      flush();
      if (k) buf = [it];
      else out.push(it);
    }
  }
  flush();
  return out;
}

function renderToolGroup(g) {
  const key = g.key || g.items[0]?.id || g.group;
  const running = g.items.some((i) => !/complete|success|ok|done|fail|error/i.test(String(i.status || "")));
  const open = running || state.openGroups.has(key);
  const mark = running ? "◇" : "◆";
  return `<details class="tool-group" data-key="${escapeHtml(key)}"${open ? " open" : ""}>
    <summary>${mark} ${escapeHtml(groupLabel(g.group, g.items.length))}</summary>
    <div class="tool-group-list">${g.items.map(renderToolRow).join("")}</div>
  </details>`;
}

function lastAgentItem() {
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (state.items[i].kind === "agent") return state.items[i];
  }
  return null;
}

let renderRaf = 0;
function scheduleRender() {
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
  if (!on) return;
  $("turnStatusLabel").textContent = state.turn.label || "Waiting for response…";
  $("turnStatusTime").textContent = fmtElapsed(Date.now() - (state.turn.phaseAt || state.turn.startedAt || Date.now()));
}
function noteActivity(phase, label) {
  const now = Date.now();
  if (!state.turn) state.turn = {};
  if (!state.turn.active) {
    state.turn.active = true;
    state.turn.startedAt = now;
    startTurnClock();
  }
  if (state.turn.phase !== phase || state.turn.label !== label) {
    state.turn.phase = phase;
    state.turn.label = label;
    state.turn.phaseAt = now;
  }
  state.waiting = phase === "waiting";
  renderTurnStatus();
  clearTimeout(state._turnIdle);
  const delay = phase === "waiting" ? 180000 : 4000;
  state._turnIdle = setTimeout(() => {
    const running = state.items.some((i) => i.kind === "tool" && !/complete|success|ok|done|fail|error/i.test(String(i.status || "")));
    if (running || state.turn.phase === "waiting") return;
    endTurn();
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
    const summary = clipNotify(agent?.text || lastTurnHint(sid), 140);
    const name = notifySessionName(sid);
    void pushNotify(
      "Pass complete",
      summary ? name + " — " + summary : name + " — Grok finished this pass",
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
  state.prompts = state.prompts.filter((p) => p.text !== t);
  state.prompts.unshift({ text: t, source: source || "pc" });
  if (state.prompts.length > 80) state.prompts.length = 80;
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
    if (isPlanGateTool(title) || isPlanGateTool(u.kind)) {
      noteActivity("tool", "Plan");
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
      });
    }
    noteActivity("tool", statusLabelForTool(title));
  } else if (kind === "tool_call_update") {
    const card = [...state.items].reverse().find((x) => x.kind === "tool" && x.id === u.toolCallId);
    if (card) {
      card.status = u.status || card.status;
      if (u.title) card.title = u.title;
      const st = String(card.status || "");
      if (state.turn.active && !/complete|success|ok|done|fail|error/i.test(st)) {
        noteActivity("tool", statusLabelForTool(card.title));
      }
      if (/fail|error/i.test(st) && /bash|shell|terminal|edit|write|search_replace|str_replace/i.test(String(card.title || ""))) {
        void pushNotify(
          "Grok hit a problem",
          clipNotify(notifySessionName() + " — " + (card.title || "a step") + " failed", 160),
          state.sessionId,
          "error"
        );
      }
    }
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
    if (state.liveOn) return;
    void pollHistory(id);
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
    const cur = state.items.filter((i) => i.kind !== "wait");
    if (!hist.items.length) return;
    const lastHist = hist.items[hist.items.length - 1];
    const lastCur = cur[cur.length - 1];
    const histKey = (lastHist?.kind || "") + ":" + (lastHist?.text || lastHist?.title || "") + ":" + hist.items.length;
    const curKey = (lastCur?.kind || "") + ":" + (lastCur?.text || lastCur?.title || "") + ":" + cur.length;
    if (histKey === curKey) return;
    if (hist.items.length < cur.length && lastCur && lastCur.kind === "user") return;
    state.items = hist.items.map((it) => ({
      ...it,
      text: it.kind === "user" ? stripRemotePrefix(it.text) : it.text,
    }));
    if (Array.isArray(hist.prompts)) state.prompts = hist.prompts;
    scheduleRender();
  } catch {
    /* ignore */
  }
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
  const opts = state.perm.options || [];
  box.classList.remove("hidden");
  box.classList.add("blocking");
  box.innerHTML = `<strong>Grok needs a decision</strong><p>${escapeHtml(state.perm.title || state.perm.toolCall?.title || "Permission")}</p>` +
    opts.map((o) => `<button type="button" data-opt="${escapeHtml(o.optionId)}" class="${/allow/i.test(o.optionId) ? "primary" : "ghost"}">${escapeHtml(o.name || o.optionId)}</button>`).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      if (state.perm && state.perm.resolve) state.perm.resolve({ outcome: { outcome: "selected", optionId: b.getAttribute("data-opt") } });
      state.perm = null;
      renderPerm();
    });
  });
  box.scrollIntoView({ block: "nearest" });
}

function isPlanGateTool(name) {
  return /exit_plan_mode|enter_plan_mode/i.test(String(name || ""));
}
function permOptionId(pred, fallback) {
  const opts = state.perm?.options || [];
  const hit = opts.find((o) => pred(String(o.optionId || "") + " " + String(o.name || "")));
  return hit?.optionId || fallback;
}
function hidePlanSheet() {
  $("planSheet")?.classList.add("hidden");
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
  const secret = state.pair?.secret || "";
  const id = state.sessionId;
  let data = { ok: false, markdown: "", empty: true };
  try {
    data = await fetch(
      api("/api/sessions/" + encodeURIComponent(id) + "/plan?secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
  } catch (err) {
    data = { ok: false, markdown: "", empty: true, error: err.message };
  }
  state.planMarkdown = data.markdown || "";
  $("planTitle").textContent = data.empty ? "No plan written yet" : "Review plan";
  $("planBody").innerHTML = state.planMarkdown
    ? renderMarkdown(state.planMarkdown)
    : `<p class="mute">${escapeHtml(data.error || "No plan written yet.")}</p>`;
  $("planBody").scrollTop = 0;
  sheet.classList.remove("hidden");
}
async function postPlanAction(action) {
  const secret = state.pair?.secret || "";
  const id = state.sessionId;
  if (!id) return;
  await fetch(
    api("/api/sessions/" + encodeURIComponent(id) + "/plan-action?secret=" + encodeURIComponent(secret)),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }
  );
}

async function resolvePlan(action) {
  if (action === "revise") {
    hidePlanSheet();
    if ($("prompt")) {
      $("prompt").disabled = false;
      $("prompt").focus();
    }
    $("composer")?.classList.remove("blocked");
    setSub("Type revision notes for the plan…");
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
  setSub(action === "quit" ? "Left plan review" : action === "revise" ? "Revision notes" : "Plan approved");
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
  const methodId = cached?.id || defaultId || null;
  if (!methodId) {
    const grok = methods.find((m) => m && m.id === "grok.com");
    if (grok) {
      try { await acp.request("authenticate", { methodId: "grok.com" }, 8000); } catch { /* TUI already signed in */ }
    }
    return init;
  }
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      await acp.request("authenticate", { methodId }, 20000);
      return init;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || "");
      if (!/cancel|required|timeout|auth/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  if (/cancel|timeout/i.test(String(lastErr?.message || ""))) return init;
  throw lastErr || new Error("Authentication cancelled");
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
    modelId: s.modelId || s.current_model_id || null,
  };
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
  const live = state.acp?.ready ? "live" : "HTTP";
  setSub(`${state.sessions.length} sessions · ${live}`);
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

function maybeRestoreSession() {
  if (state._restored) return;
  if (state.view !== "roster") return;
  if (pinConfigured() && !state.unlocked) return;
  let id = "";
  try { id = localStorage.getItem("gr.lastSession") || ""; } catch { id = ""; }
  if (!id || !state.sessions.some((s) => s.sessionId === id)) return;
  if (isHiddenSession(id)) return;
  state._restored = true;
  openSession(id);
}

async function openSession(id) {
  const row = state.sessions.find((s) => s.sessionId === id);
  stopLive();
  hidePlanSheet();
  state._openingSession = true;
  state._loadingHistory = true;
  state._openedAt = Date.now();
  state.sessionId = id;
  state._attachedId = null;
  state.title = row?.title || "Session";
  state.cwd = row?.cwd || state.pair?.cwd || "";
  state.items = [];
  state.seenIds = new Set();
  state.prompts = [];
  state.queue = [];
  state.pcQueue = [];
  state.attachments = [];
  state.openGroups = new Set();
  state.model = row?.modelId || row?.model || state.model || "";
  state.busy = false;
  endTurn({ notify: false });
  clearWaiting();
  renderChips();
  renderQueue();
  renderAttach();
  showView("thread");
  state.stickBottom = true;
  try { localStorage.setItem("gr.lastSession", id); } catch { /* ignore */ }
  setSub("Loading history…");
  endTurn({ notify: false });
  try {
    const secret = state.pair?.secret || "";
    const hist = await fetch(
      api("/api/sessions/" + encodeURIComponent(id) + "/history?secret=" + encodeURIComponent(secret)),
      { cache: "no-store" }
    ).then((r) => r.json());
    if (hist && hist.ok && Array.isArray(hist.items) && hist.items.length) {
      state.items = hist.items.map((it) => ({
        ...it,
        text: it.kind === "user" ? stripRemotePrefix(it.text) : it.text,
      }));
      if (Array.isArray(hist.prompts)) state.prompts = hist.prompts;
      if (Array.isArray(hist.todos)) state.todos = hist.todos;
      renderThread();
      scrollThreadToEnd(true);
      syncHeader(connectionLabel());
    }
    startLive(id);
    void loadMeta(id);
    void loadPcQueue(id);
    try {
      await attachSession(id, { replay: !hist?.items?.length });
      syncHeader();
    } catch (err) {
      syncHeader();
      if (!hist?.items?.length) {
        state.items.push({ kind: "agent", text: "Could not attach session: " + err.message });
      }
    }
    if (!hist?.items?.length) renderThread();
    const last = lastContentItem();
    const st = String(last?.status || "");
    if (last && last.kind === "tool" && !/complete|success|ok|done|fail|error/i.test(st)) {
      noteActivity("tool", statusLabelForTool(last.title));
    }
    scrollThreadToEnd(true);
  } catch (err) {
    setSub("Load failed");
    state.items.push({ kind: "agent", text: "Could not load session: " + err.message });
    renderThread();
  } finally {
    state._openingSession = false;
    state._loadingHistory = false;
  }
}

const MODE_OPTS = [
  { id: "plan", label: "Plan", slash: "/plan" },
  { id: "ask", label: "Ask", slash: null },
  { id: "auto", label: "Auto", slash: "/auto" },
  { id: "always-approve", label: "Approve", slash: "/always-approve" },
];
const MODEL_OPTS = ["grok-4.6", "grok-4.5"];
const EFFORT_OPTS = ["low", "medium", "high", "xhigh"];
const BUILTIN_CMDS = [
  { name: "compact", description: "Compress context", run: true, confirm: "Compact this session now?" },
  { name: "rewind", description: "Undo last turns", run: true, confirm: "Rewind the last turn?" },
  { name: "fork", description: "Branch this session", run: true, confirm: "Fork this session?" },
  { name: "usage", description: "Context usage", run: "usage" },
  { name: "session-info", description: "Session details", run: "usage" },
  { name: "view-plan", description: "Show todos", run: "todos" },
  { name: "rename", description: "Rename session" },
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
  model.textContent = state.model || "Model";
  effort.textContent = state.effort || "Effort";
  if (usage) {
    const pct = state.usage?.percent;
    usage.textContent = pct != null ? pct + "%" : "Usage";
  }
  if (todos) {
    const n = (state.todos || []).length;
    todos.classList.toggle("hidden", n === 0);
    todos.textContent = n ? "Todos " + n : "Todos";
  }
}
function hideSheet() {
  $("sheet")?.classList.add("hidden");
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
  if (!entries.length) rows.push(`<div class="empty">Empty folder</div>`);
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
    renderChips();
  } catch {
    /* ignore */
  }
}

function showUsageSheet() {
  const u = state.usage || {};
  const used = u.tokensUsed ? u.tokensUsed.toLocaleString() : "—";
  const win = u.windowTokens ? u.windowTokens.toLocaleString() : "—";
  openSheet("Usage", [], state.model, () => {});
  $("sheetTitle").textContent = "Session info";
  $("sheetOpts").innerHTML = `<div class="usage-grid">
    <div><span>Context</span><br><strong>${u.percent != null ? u.percent + "%" : "—"}</strong></div>
    <div><span>Tokens</span><br><strong>${escapeHtml(used)} / ${escapeHtml(win)}</strong></div>
    <div><span>Model</span><br><strong>${escapeHtml(state.model || "—")}</strong></div>
    <div><span>Effort</span><br><strong>${escapeHtml(state.effort || "—")}</strong></div>
    <div><span>Turns</span><br><strong>${u.turns ?? "—"}</strong></div>
    <div><span>Tools</span><br><strong>${u.tools ?? "—"}</strong></div>
  </div>`;
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
  openSheet(row?.title || "Session", [
    { id: "open", label: "Open" },
    { id: "star", label: star ? "Unpin" : "Pin / star" },
    { id: "hide", label: hid ? "Show in list" : "Hide from list" },
    { id: "rename", label: "Rename" },
    { id: "delete", label: "Delete" },
  ], "", (action) => {
    if (action === "open") openSession(id);
    if (action === "star") toggleStar(id);
    if (action === "hide") toggleHiddenSession(id);
    if (action === "rename") openRenameSheet(id, row?.title || "");
    if (action === "delete") confirmDeleteSession(id, row);
  });
}

function openRenameSheet(id, current) {
  const sheet = $("sheet");
  $("sheetTitle").textContent = "Rename session";
  $("sheetOpts").innerHTML = `<input id="renameInput" type="text" value="${escapeHtml(current)}" />
    <button type="button" class="primary" id="renameSave">Save</button>`;
  sheet.classList.remove("hidden");
  $("renameSave").addEventListener("click", () => {
    const title = $("renameInput").value.trim();
    hideSheet();
    if (title) void renameRemoteSession(id, title);
  });
  $("renameInput").focus();
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
  sheet.classList.remove("hidden");
}

async function sendSlash(cmd) {
  if (!state.sessionId) return;
  try {
    const acp = await attachSession(state.sessionId, { replay: false });
    await acp.request("session/prompt", {
      sessionId: state.sessionId,
      prompt: [{ type: "text", text: cmd }],
    }, /^\s*\/plan\b/i.test(cmd) ? 8000 : 60000);
  } catch (err) {
    setSub("Command failed: " + err.message);
  }
}

async function applyMode(id) {
  const prev = state.mode;
  state.mode = id;
  renderChips();
  const acp = await attachSession(state.sessionId, { replay: false }).catch(() => null);
  if (acp) {
    try {
      await acp.request("session/set_mode", { sessionId: state.sessionId, modeId: id }, 15000);
      return;
    } catch { /* slash fallback */ }
  }
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
      <span class="q-num">${i + 1}.</span>
      <span class="src ${q.source === "app" ? "app" : "pc"}">${q.origin === "pc" ? "PC" : "App"}</span>
      <span class="q-text">${escapeHtml(q.text || (q.images?.length ? "image" : "") )}${q.running ? " · running" : ""}</span>
      <button type="button" class="ghost q-start" data-i="${i}">Start</button>
      <button type="button" class="q-x" data-i="${i}" aria-label="Cancel">×</button>
    </div>`).join("") +
    `<div class="q-foot"><span>${rows.length} queued</span></div>`;
  box.querySelectorAll(".q-x").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.getAttribute("data-i"));
      void cancelQueued(mergedQueue()[i]);
    });
  });
  box.querySelectorAll(".q-start").forEach((b) => {
    b.addEventListener("click", () => {
      const i = Number(b.getAttribute("data-i"));
      void startQueued(mergedQueue()[i]);
    });
  });
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
      body: JSON.stringify({ action, id: row?.id, index: row?.index }),
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
async function startQueued(row) {
  if (!row) return;
  if (row.origin === "app") {
    const i = Number(row.index);
    const local = state.queue.splice(i, 1)[0];
    renderQueue();
    cancelTurn();
    if (local) void sendPrompt(local.text, { now: true, images: local.images });
    return;
  }
  try {
    await queueAction("start", row);
    setSub("Starting queued item…");
  } catch (err) {
    setSub("Start failed: " + err.message);
  }
}

function enqueueFollowUp(text, images) {
  state.queue.push({ text: String(text || "").trim(), source: "app", images: images || [] });
  renderQueue();
}

function sendNow() {
  const top = state.queue.shift();
  renderQueue();
  cancelTurn();
  if (top) void sendPrompt(top.text, { now: true, images: top.images });
}

function drainQueue() {
  if (state._prompting || (state.turn && state.turn.active)) return;
  const next = state.queue.shift();
  if (!next) {
    renderQueue();
    return;
  }
  renderQueue();
  void sendPrompt(next.text, { now: true, images: next.images });
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

async function sendPrompt(text, opts = {}) {
  text = String(text || "").trim();
  const images = opts.images || state.attachments || [];
  if (!text && !images.length) return;
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
  if (!opts.now && !slash && (state.turn.active || state._prompting)) {
    enqueueFollowUp(text, images.slice());
    state.attachments = [];
    renderAttach();
    return;
  }
  if (!slash) {
    state.items.push({ kind: "user", text: text || "(image)", source: "app", at: Date.now() });
    if (text) rememberPrompt(text, "app");
  }
  const pendingImages = images.slice();
  state.attachments = [];
  renderAttach();
  state._prompting = true;
  state._userTurnAt = Date.now();
  noteActivity("waiting", slash ? "Running " + text : "Waiting for response…");
  renderThread();
  try {
    const outbound = slash ? text : (text.startsWith("[Grok Remote]") ? text : (text ? `[Grok Remote] ${text}` : "[Grok Remote]"));
    const secret = state.pair?.secret || "";
    const ctrl = new AbortController();
    const abortAt = setTimeout(() => ctrl.abort(), 25000);
    let httpRes;
    try {
      httpRes = await fetch(
        api("/api/sessions/" + encodeURIComponent(state.sessionId) + "/prompt?secret=" + encodeURIComponent(secret)),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: outbound,
            images: slash ? [] : pendingImages.map((img) => ({ mime: img.mime, b64: img.b64 })),
          }),
          signal: ctrl.signal,
        }
      );
    } finally {
      clearTimeout(abortAt);
    }
    const httpBody = await httpRes.json().catch(() => ({}));
    if (!httpRes.ok || httpBody.ok === false) {
      throw new Error(httpBody.error || "send HTTP " + httpRes.status);
    }
    syncHeader();
  } catch (err) {
    state._attachedId = null;
    endTurn({ notify: false });
    const msg = String(err.name === "AbortError" ? "timed out" : err.message || err);
    state.items.push({ kind: "agent", text: "Send failed: " + msg });
    renderThread();
    let healthy = false;
    try {
      const h = await fetch(api("/api/health"), { cache: "no-store" });
      healthy = h.ok;
    } catch { /* ignore */ }
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
  if (!state.sessionId || !state.acp) return;
  state.acp.notify("session/cancel", { sessionId: state.sessionId });
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
        if (isPlanGateTool(toolName)) {
          if (planPromptAllowed()) {
            showView("thread");
            void openPlanPreview({ user: false });
          }
          return;
        }
        if (state._openingSession || state._loadingHistory) return;
        showView("thread");
        renderPerm();
        const copy = describePermission(params);
        void pushNotify(copy.title, copy.body, state.sessionId, "needs");
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
    setTimeout(() => connect().catch(() => {}), 1500);
  };
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
  const base = { needs: 2100, done: 2200, error: 2300 }[kind] || 2000;
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

async function pushNotify(title, body, sessionId, kind) {
  if (kind === "needs" && !state.notifyNeeds) return;
  if (kind === "error" && !state.notifyNeeds) return;
  if (kind === "uac" && !state.notifyNeeds) return;
  if (kind === "done" && !state.notifyDone) return;
  if (kind !== "uac" && watchingSession(sessionId)) return;
  const key = `${kind}:${sessionId || ""}:${title}`;
  const now = Date.now();
  if (!state._notifyAt) state._notifyAt = {};
  if (state._notifyAt[key] && now - state._notifyAt[key] < 25000) return;
  state._notifyAt[key] = now;
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
      const actionTypeId = kind === "needs" ? "GROK_NEED" : "GROK_DONE";
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
          ],
        },
        {
          id: "GROK_DONE",
          actions: [{ id: "open", title: "Open", foreground: true }],
        },
      ],
    });
  } catch { /* ignore */ }
  LN.addListener("localNotificationActionPerformed", (ev) => {
    const extra = ev?.notification?.extra || {};
    const action = ev?.actionId || extra.actionId || "open";
    if (action === "allow" && state.perm) {
      const opt = (state.perm.options || []).find((o) => /allow/i.test(String(o.optionId || o.name || "")));
      if (opt && state.perm.resolve) {
        state.perm.resolve({ outcome: { outcome: "selected", optionId: opt.optionId } });
        state.perm = null;
        renderPerm();
        return;
      }
    }
    if (extra.sessionId) openSession(extra.sessionId);
  });
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
    await loadRoster();
    listenEvents();
    wireNativeNotify();
    checkForAppUpdate();
    loadChangelog();
    setSub(`${state.sessions.length} sessions · opening ACP…`);
    const acp = new AcpClient(pair.ws);
    wireAcp(acp);
    await acp.connect();
    state.acp = acp;
    state._attachedId = null;
    await handshake(acp);
    await loadRoster();
    startKeepalive();
    maybeRestoreSession();
    if (state.view === "thread" && state.sessionId) {
      syncHeader("Connected");
      startLive(state.sessionId);
      try {
        await attachSession(state.sessionId, { replay: false });
      } catch (err) {
        setSub("Reconnect ok, session attach failed: " + err.message);
      }
    } else {
      setSub(`${state.sessions.length} sessions · live`);
    }
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
    if (msg.type === "needs_input") {
      const name = notifySessionName(msg.sessionId);
      const why = clipNotify(msg.summary || msg.activity || "", 120);
      void pushNotify(
        "Approval needed",
        why ? name + " — " + why : name + " is waiting on a decision",
        msg.sessionId,
        "needs"
      );
      if (msg.sessionId && state.view === "roster" && !isHiddenSession(msg.sessionId)) openSession(msg.sessionId);
      loadRoster();
    }
    if (msg.type === "queue_changed") {
      if (msg.sessionId === state.sessionId && Array.isArray(msg.entries)) {
        state.pcQueue = msg.entries;
        renderQueue();
      }
    }
    if (msg.type === "uac_prompt") {
      void pushNotify(
        "UAC on the PC",
        msg.summary || "Windows needs administrator approval on this PC.",
        "",
        "uac"
      );
    }
    if (msg.type === "turn_complete") {
      if (msg.sessionId === state.sessionId) endTurn();
      const name = notifySessionName(msg.sessionId);
      const summary = clipNotify(msg.summary || "", 140);
      void pushNotify(
        "Pass complete",
        summary ? name + " — " + summary : name + " — Grok finished this pass",
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
function showUpdateBanner(manifest) {
  const latest = String(manifest.latestVersion || "").trim();
  if (!latest) return hideUpdateBanner();
  if (!manifest.forceUpdate && state.dismissedUpdate === latest) return hideUpdateBanner();
  state.updateManifest = manifest;
  $("updateTitle").textContent = manifest.forceUpdate ? `Update required: v${latest}` : `Update available: v${latest}`;
  $("updateNotes").textContent = manifest.releaseNotes || `You have v${APP_VERSION}.`;
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
      showUpdateBanner(data);
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
  let url = state.updateManifest?.downloadUrl || "/downloads/Grok-Remote.apk";
  if (url.startsWith("/")) url = gatewayBase() + url;
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
function findHits(q) {
  const needle = String(q || "").trim().toLowerCase();
  if (needle.length < 2) return [];
  return state.items
    .map((it, i) => ({ it, i }))
    .filter((x) => (x.it.kind === "user" || x.it.kind === "agent" || x.it.kind === "think") && String(x.it.text || "").toLowerCase().includes(needle));
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
  $("btnBack").addEventListener("click", () => { goBack(); });
  $("btnSettings").addEventListener("click", () => {
    showView(state.view === "settings" ? "roster" : "settings");
    if (state.view === "settings") { checkForAppUpdate(); loadChangelog(); }
  });
  $("btnNew").addEventListener("click", () => showView("new"));
  $("search").addEventListener("input", renderRoster);
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
  $("prompt").addEventListener("input", () => { void onPromptAtSuggest(); });
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
  $("btnStartSession").addEventListener("click", () => startNew().catch((err) => setSub(err.message)));
  $("btnReconnect").addEventListener("click", () => connect().catch((err) => setSub(err.message)));
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
  $("notifyNeeds").addEventListener("change", () => {
    state.notifyNeeds = $("notifyNeeds").checked;
    localStorage.setItem("gr.notifyNeeds", state.notifyNeeds ? "1" : "0");
  });
  $("notifyDone").addEventListener("change", () => {
    state.notifyDone = $("notifyDone").checked;
    localStorage.setItem("gr.notifyDone", state.notifyDone ? "1" : "0");
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
  $("planCopy")?.addEventListener("click", () => {
    if (state.planMarkdown) copyText(state.planMarkdown);
  });
  $("chipModel")?.addEventListener("click", () => {
    hideHist();
    const models = MODEL_OPTS.slice();
    if (state.model && !models.includes(state.model)) models.unshift(state.model);
    openSheet("Model", models.map((id) => ({ id, label: id })), state.model, (id) => { void applyModel(id); });
  });
  $("chipEffort")?.addEventListener("click", () => {
    hideHist();
    openSheet("Effort", EFFORT_OPTS.map((id) => ({ id, label: id })), state.effort, (id) => { void applyEffort(id); });
  });
  $("chipUsage")?.addEventListener("click", () => {
    hideHist();
    void loadMeta(state.sessionId).then(showUsageSheet);
  });
  $("chipTodos")?.addEventListener("click", () => {
    hideHist();
    showTodosSheet();
  });
  $("sheetCancel")?.addEventListener("click", hideSheet);
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
    box.innerHTML = `<div class="empty">No commands in this session yet.</div>`;
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
  if (state._connecting || state._prompting) return;
  if (!state.acp?.ready) {
    try { await connect(); } catch { /* ignore */ }
    return;
  }
  try {
    await state.acp.request("session/list", {}, 8000);
  } catch {
    state._attachedId = null;
    try { state.acp.close(); } catch { /* ignore */ }
    state.acp = null;
    try { await connect(); } catch { /* ignore */ }
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
});
