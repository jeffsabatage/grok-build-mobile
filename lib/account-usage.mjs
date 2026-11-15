/**
 * Weekly SuperGrok compute-pool usage (Settings → Usage), not session context.
 * Reads GROK_HOME/auth.json. Never logs tokens or auth.json contents.
 */
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { GROK_HOME } from "./leader.mjs";

const DEFAULT_ISSUER = "https://auth.x.ai";
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const GRPC_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const CACHE_MS = 45_000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const PRODUCT_ORDER = ["api", "build", "chat", "imagine", "voice", "other"];
const PRODUCT_LABEL = {
  api: "API",
  build: "Build",
  chat: "Chat",
  imagine: "Imagine",
  voice: "Voice",
  other: "Other",
};
const PRODUCT_ENUM = { 1: "api", 2: "build", 3: "other", 4: "chat", 5: "imagine", 6: "voice" };

let cache = null;
let inflight = null;

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), "[usage]", ...a);
}

function sanitizeError(err) {
  return String(err?.message || err || "usage fetch failed")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, "[jwt]")
    .replace(/refresh_token=[^&\s]+/gi, "refresh_token=***")
    .replace(/access_token=[^&\s]+/gi, "access_token=***")
    .slice(0, 240);
}

function httpsRequest(url, { method = "GET", headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const hdrs = { ...headers };
    let payload = null;
    if (body != null) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      hdrs["content-length"] = String(payload.length);
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: hdrs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJsonSafe(buf) {
  try {
    return JSON.parse(Buffer.from(buf).toString("utf8"));
  } catch {
    return null;
  }
}

function numVal(x) {
  if (x == null) return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() && Number.isFinite(Number(x))) return Number(x);
  if (typeof x === "object") {
    if (typeof x.val === "number" && Number.isFinite(x.val)) return x.val;
    if (typeof x.value === "number" && Number.isFinite(x.value)) return x.value;
  }
  return null;
}

function clampPct(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** 0–100 percent, or a 0–1 fraction. Missing stays null — never invent 0%. */
function normalizePercent(n) {
  const v = numVal(n);
  if (v == null) return null;
  if (v > 0 && v < 1) return clampPct(v * 100);
  return clampPct(v);
}

function productId(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return PRODUCT_ENUM[raw] || null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s) && PRODUCT_ENUM[Number(s)]) return PRODUCT_ENUM[Number(s)];
  const compact = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact === "api" || compact === "grokapi") return "api";
  if (compact === "build" || compact === "grokbuild") return "build";
  if (compact === "chat" || compact === "grokchat") return "chat";
  if (compact === "imagine" || compact === "grokimagine") return "imagine";
  if (compact === "voice" || compact === "grokvoice") return "voice";
  if (compact === "other" || compact === "grokother") return "other";
  if (compact.includes("imagine")) return "imagine";
  if (compact.includes("voice")) return "voice";
  if (compact.includes("build")) return "build";
  if (compact.includes("chat")) return "chat";
  if (compact.includes("api")) return "api";
  if (compact.includes("other")) return "other";
  return null;
}

function collectProducts(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const id = productId(row.product ?? row.id ?? row.type);
    const pct = normalizePercent(row.usagePercent ?? row.percent ?? row.usage_percent);
    if (!id || pct == null || pct <= 0) continue;
    map.set(id, (map.get(id) || 0) + pct);
  }
  return PRODUCT_ORDER.filter((id) => map.has(id)).map((id) => ({
    id,
    label: PRODUCT_LABEL[id],
    percent: map.get(id),
  }));
}

function periodTypeOf(raw) {
  const s = String(raw || "").toUpperCase();
  if (s.includes("WEEK")) return "weekly";
  if (s.includes("MONTH")) return "monthly";
  return raw ? String(raw) : null;
}

function isoOrNull(v) {
  if (!v) return null;
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function authPath() {
  return path.join(GROK_HOME, "auth.json");
}

function loadAuth() {
  const file = authPath();
  if (!fs.existsSync(file)) throw new Error("not signed in");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object") throw new Error("auth.json invalid");
  if (data.key || data.access_token || data.refresh_token) {
    return { file, data, entry: data };
  }
  const entries = Object.entries(data).filter(
    ([, v]) => v && typeof v === "object" && (v.key || v.access_token || v.refresh_token)
  );
  if (!entries.length) throw new Error("not signed in");
  const preferred =
    entries.find(
      ([k, v]) =>
        String(v.oidc_client_id || "") === DEFAULT_CLIENT_ID || String(k).includes(DEFAULT_CLIENT_ID)
    ) || entries[0];
  return { file, data, entry: preferred[1] };
}

function atomicWrite(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* windows */
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

function persistAuth(ctx) {
  atomicWrite(ctx.file, JSON.stringify(ctx.data, null, 2) + "\n");
}

function tokenOf(entry) {
  return String(entry?.access_token || entry?.key || "").trim();
}

function expiresSoon(entry) {
  const t = Date.parse(entry?.expires_at || "");
  if (!Number.isFinite(t)) return false;
  return t - Date.now() <= REFRESH_SKEW_MS;
}

async function refreshOidc(ctx) {
  const entry = ctx.entry;
  const refresh = entry.refresh_token;
  if (!refresh) throw new Error("no refresh token");
  const issuer = String(entry.oidc_issuer || DEFAULT_ISSUER).replace(/\/+$/, "");
  const clientId = entry.oidc_client_id || DEFAULT_CLIENT_ID;
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: clientId,
  }).toString();
  const res = await httpsRequest(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": "xai-grok-cli",
    },
    body: form,
    timeoutMs: 15000,
  });
  if (res.status < 200 || res.status >= 300) throw new Error("oidc refresh HTTP " + res.status);
  const json = parseJsonSafe(res.body);
  const access = json?.access_token;
  if (!access) throw new Error("oidc refresh missing token");
  entry.key = access;
  entry.access_token = access;
  if (json.refresh_token) entry.refresh_token = json.refresh_token;
  const expIn = Number(json.expires_in);
  if (Number.isFinite(expIn) && expIn > 0) {
    entry.expires_at = new Date(Date.now() + expIn * 1000).toISOString();
  }
  persistAuth(ctx);
  log("oidc refreshed");
}

function cliHeaders(token, extra = {}) {
  return {
    authorization: "Bearer " + token,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "user-agent": "xai-grok-cli",
    "x-grok-client-surface": "grok-remote",
    accept: "application/json",
    ...extra,
  };
}

function extraFromConfig(config) {
  const extra = {};
  const prepaid = numVal(config?.prepaidBalance ?? config?.prepaid_balance);
  const onDemandCap = numVal(config?.onDemandCap ?? config?.on_demand_cap);
  const onDemandUsed = numVal(config?.onDemandUsed ?? config?.on_demand_used);
  if (prepaid != null) extra.prepaidBalance = prepaid;
  if (onDemandCap != null) extra.onDemandCap = onDemandCap;
  if (onDemandUsed != null) extra.onDemandUsed = onDemandUsed;
  return extra;
}

function snapshotFromConfig(config, { source, plan } = {}) {
  if (!config || typeof config !== "object") return null;
  const period = config.currentPeriod || config.current_period || {};
  const usedPercent = normalizePercent(config.creditUsagePercent ?? config.credit_usage_percent);
  const products = collectProducts(config.productUsage || config.product_usage || []);
  const resetsAt =
    isoOrNull(period.end) || isoOrNull(config.billingPeriodEnd || config.billing_period_end);
  const periodStart =
    isoOrNull(period.start) || isoOrNull(config.billingPeriodStart || config.billing_period_start);
  const periodType = periodTypeOf(period.type) || (period.start || period.end ? "weekly" : null);
  const remainingPercent = usedPercent == null ? null : clampPct(100 - usedPercent);
  return {
    ok: true,
    usedPercent,
    remainingPercent,
    resetsAt,
    periodStart,
    periodType,
    products,
    plan: plan || config.subscriptionTierDisplay || config.subscription_tier_display || config.subscriptionTier || null,
    extra: extraFromConfig(config),
    source: source || "credits",
    fetchedAt: new Date().toISOString(),
  };
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let next = offset;
  while (next < buf.length) {
    const byte = buf[next++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, next };
    shift += 7;
    if (shift > 63) break;
  }
  return null;
}

function forEachField(buf, fn) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let offset = 0;
  while (offset < b.length) {
    const tag = readVarint(b, offset);
    if (!tag) break;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    offset = tag.next;
    if (wire === 0) {
      const v = readVarint(b, offset);
      if (!v) break;
      fn({ field, wire, int: v.value });
      offset = v.next;
    } else if (wire === 1) {
      if (offset + 8 > b.length) break;
      fn({ field, wire, bytes: b.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const v = readVarint(b, offset);
      if (!v) break;
      const end = v.next + v.value;
      if (end > b.length) break;
      fn({ field, wire, bytes: b.subarray(v.next, end) });
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > b.length) break;
      fn({ field, wire, bytes: b.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      break;
    }
  }
}

function floatLE(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const n = b.readFloatLE(0);
  return Number.isFinite(n) ? n : null;
}

function doubleLE(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const n = b.readDoubleLE(0);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(bytes) {
  if (!bytes || !bytes.length) return null;
  let seconds = null;
  let nanos = 0;
  forEachField(bytes, ({ field, wire, int }) => {
    if (field === 1 && wire === 0) seconds = int;
    if (field === 2 && wire === 0) nanos = int;
  });
  if (seconds == null) return null;
  const ms = seconds * 1000 + nanos / 1e6;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function grpcPayload(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!b.length) return null;
  if (b[0] === 0x7b) return null;
  let offset = 0;
  let data = null;
  while (offset + 5 <= b.length) {
    const flags = b[offset];
    const len = b.readUInt32BE(offset + 1);
    offset += 5;
    if (len < 0 || offset + len > b.length) break;
    const frame = b.subarray(offset, offset + len);
    offset += len;
    if (flags === 0x80) continue;
    if (flags !== 0) continue;
    if (frame.length >= 11 && frame.subarray(0, 11).toString("utf8") === "grpc-status") continue;
    data = frame;
    break;
  }
  return data && data.length ? data : b;
}

function parseCreditsProto(buf) {
  const payload = grpcPayload(buf);
  if (!payload || !payload.length) return null;
  let configBuf = null;
  forEachField(payload, ({ field, wire, bytes }) => {
    if (field === 1 && wire === 2) configBuf = bytes;
  });
  const config = configBuf && configBuf.length ? configBuf : payload;
  let usedPercent = null;
  let periodStart = null;
  let periodEnd = null;
  const products = [];
  forEachField(config, ({ field, wire, bytes }) => {
    if (field === 1 && wire === 5) usedPercent = floatLE(bytes);
    if (field === 1 && wire === 1) usedPercent = doubleLE(bytes);
    if (field === 4 && wire === 2) periodStart = parseTimestamp(bytes);
    if (field === 5 && wire === 2) periodEnd = parseTimestamp(bytes);
    if (field === 7 && wire === 2) {
      let enumVal = null;
      let pct = null;
      forEachField(bytes, ({ field: f, wire: w, int, bytes: inner }) => {
        if (f === 1 && w === 0) enumVal = int;
        if (f === 2 && w === 5) pct = floatLE(inner);
        if (f === 2 && w === 1) pct = doubleLE(inner);
      });
      products.push({ product: enumVal, usagePercent: pct });
    }
  });
  const used = usedPercent == null ? null : normalizePercent(usedPercent);
  return {
    ok: true,
    usedPercent: used,
    remainingPercent: used == null ? null : clampPct(100 - used),
    resetsAt: periodEnd,
    periodStart,
    periodType: periodStart || periodEnd ? "weekly" : null,
    products: collectProducts(products),
    plan: null,
    extra: {},
    source: "grpc",
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchSettingsPlan(token) {
  try {
    const res = await httpsRequest(SETTINGS_URL, {
      headers: cliHeaders(token),
      timeoutMs: 4000,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const json = parseJsonSafe(res.body);
    return (
      json?.subscription_tier_display ||
      json?.subscriptionTierDisplay ||
      json?.subscription_tier ||
      json?.subscriptionTier ||
      json?.config?.subscription_tier_display ||
      null
    );
  } catch {
    return null;
  }
}

async function fetchCreditsJson(token) {
  const res = await httpsRequest(BILLING_URL, {
    headers: cliHeaders(token),
    timeoutMs: 12000,
  });
  return res;
}

async function fetchCreditsGrpc(token) {
  const res = await httpsRequest(GRPC_URL, {
    method: "POST",
    headers: cliHeaders(token, {
      accept: "application/grpc-web+proto",
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      origin: "https://grok.com",
      referer: "https://grok.com/?_s=usage",
    }),
    body: Buffer.from([0, 0, 0, 0, 0]),
    timeoutMs: 12000,
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error("grpc HTTP " + res.status);
    err.status = res.status;
    throw err;
  }
  const grpcStatus = String(res.headers["grpc-status"] || "");
  if (grpcStatus && grpcStatus !== "0") throw new Error("grpc-status " + grpcStatus);
  if (res.status < 200 || res.status >= 300) throw new Error("grpc HTTP " + res.status);
  return parseCreditsProto(res.body);
}

async function doFetch() {
  const ctx = loadAuth();
  if (expiresSoon(ctx.entry) && ctx.entry.refresh_token) {
    try {
      await refreshOidc(ctx);
    } catch (err) {
      log("oidc refresh skipped", sanitizeError(err));
    }
  }

  const tryBilling = async (token) => {
    const res = await fetchCreditsJson(token);
    if (res.status === 401 || res.status === 403) {
      const err = new Error("billing HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new Error("billing HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const json = parseJsonSafe(res.body);
    const config = json?.config || json;
    return snapshotFromConfig(config, { source: "credits" });
  };

  let token = tokenOf(ctx.entry);
  if (!token) throw new Error("not signed in");

  let snap = null;
  try {
    snap = await tryBilling(token);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      await refreshOidc(ctx);
      token = tokenOf(ctx.entry);
      snap = await tryBilling(token);
    } else {
      log("credits json fail", sanitizeError(err));
    }
  }

  if (!snap || snap.usedPercent == null) {
    try {
      const grpcSnap = await fetchCreditsGrpc(token);
      if (grpcSnap) {
        if (snap) {
          if (snap.usedPercent == null && grpcSnap.usedPercent != null) snap.usedPercent = grpcSnap.usedPercent;
          if (snap.remainingPercent == null && snap.usedPercent != null) {
            snap.remainingPercent = clampPct(100 - snap.usedPercent);
          }
          if (!snap.products.length && grpcSnap.products.length) snap.products = grpcSnap.products;
          if (!snap.resetsAt && grpcSnap.resetsAt) snap.resetsAt = grpcSnap.resetsAt;
          if (!snap.periodStart && grpcSnap.periodStart) snap.periodStart = grpcSnap.periodStart;
          snap.source = snap.usedPercent != null && snap.source === "credits" ? "credits+grpc" : "grpc";
        } else {
          snap = grpcSnap;
        }
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        try {
          await refreshOidc(ctx);
          token = tokenOf(ctx.entry);
          const grpcSnap = await fetchCreditsGrpc(token);
          if (grpcSnap) snap = snap || grpcSnap;
        } catch (err2) {
          log("grpc fail", sanitizeError(err2));
        }
      } else {
        log("grpc fail", sanitizeError(err));
      }
    }
  }

  if (!snap) throw new Error("usage unavailable");

  const plan = await fetchSettingsPlan(token);
  if (plan) snap.plan = plan;

  const pct = snap.usedPercent == null ? "unknown" : Math.round(snap.usedPercent) + "%";
  log("usage fetch", pct, "products=" + (snap.products?.length || 0));
  return snap;
}

export async function fetchAccountUsage({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (!force && inflight) return inflight;
  inflight = (async () => {
    try {
      const snap = await doFetch();
      cache = { at: Date.now(), value: snap };
      return snap;
    } catch (err) {
      const error = sanitizeError(err);
      log("usage fetch fail", error);
      return { ok: false, error };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
