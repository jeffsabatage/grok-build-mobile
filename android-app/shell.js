const APP_VERSION = "0.1.40";
const PORT = 2420;
const KEY = "grokRemoteServerUrl";

const $ = (id) => document.getElementById(id);
const notes = [];
function log(msg) {
  notes.push(msg);
  $("log").textContent = notes.slice(-8).join("\n");
  $("status").textContent = msg;
}

function dash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function health(base, ms = 4000) {
  const url = dash(base);
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url + "/api/health", { cache: "no-store", signal: ctrl.signal });
    const data = await res.json();
    if (data && data.ok && data.name === "grok-remote") return data;
    log("Unexpected health from " + url);
    return null;
  } catch (err) {
    log("No gateway at " + url + " (" + (err.name === "AbortError" ? "timeout" : "blocked or down") + ")");
    return null;
  } finally {
    clearTimeout(t);
  }
}

function openGateway(url) {
  const dest = dash(url) + "/?cap=1&apk=" + encodeURIComponent(APP_VERSION);
  localStorage.setItem(KEY, dash(url));
  log("Opening " + dest);
  window.location.replace(dest);
}

function lanScanHosts() {
  const hosts = [];
  for (const prefix of ["10.0.0.", "192.168.1.", "192.168.0.", "10.0.1."]) {
    for (let i = 1; i <= 40; i++) hosts.push(prefix + i);
  }
  return hosts;
}

async function tryKnown() {
  const saved = localStorage.getItem(KEY) || "";
  const candidates = [saved, $("url").value].map(dash).filter(Boolean);
  const unique = [...new Set(candidates)];
  for (const url of unique) {
    log("Trying " + url);
    const ok = await health(url, 4000);
    if (ok) {
      log("Found gateway · " + ok.sessions + " sessions");
      openGateway(url);
      return true;
    }
  }
  return false;
}

async function scan() {
  log("Scanning LAN for port " + PORT);
  const hosts = lanScanHosts();
  for (let i = 0; i < hosts.length; i += 8) {
    const chunk = hosts.slice(i, i + 8);
    const hits = await Promise.all(chunk.map(async (h) => {
      const url = "http://" + h + ":" + PORT;
      const ok = await health(url, 1200);
      return ok ? url : null;
    }));
    const found = hits.find(Boolean);
    if (found) return found;
  }
  return null;
}

$("url").value = localStorage.getItem(KEY) || "";

$("btnGo").addEventListener("click", async () => {
  const url = dash($("url").value);
  $("url").value = url;
  log("Connecting to " + url);
  const ok = await health(url, 5000);
  if (!ok) {
    log("Still no Grok Remote there. On the PC run: node server.mjs");
    return;
  }
  openGateway(url);
});

$("btnScan").addEventListener("click", async () => {
  const found = await scan();
  if (!found) {
    log("Scan missed. Type the PC gateway URL and Connect.");
    return;
  }
  $("url").value = found;
  openGateway(found);
});

(async function boot() {
  const ok = await tryKnown();
  if (ok) return;
  const found = await scan();
  if (found) {
    $("url").value = found;
    openGateway(found);
    return;
  }
  log("Could not auto-find the PC. Type the gateway URL (port 2420) and tap Connect. Phone and PC must be on the same Wi-Fi.");
})();
