import os from "node:os";

export function isLoopback(host) {
  return !host || host === "127.0.0.1" || host === "localhost" || host.startsWith("127.");
}

export function listLanCandidates() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal) continue;
      let score = 10;
      if (a.address.startsWith("10.")) score += 30;
      if (a.address.startsWith("192.168.")) score += 20;
      if (a.address.startsWith("172.")) score += 10;
      if (/ethernet/i.test(name)) score += 8;
      if (/wi-?fi|wlan/i.test(name)) score += 5;
      out.push({ name, addr: a.address, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export function detectLanIp(forced) {
  if (forced && !isLoopback(forced)) return forced;
  const c = listLanCandidates();
  return c[0]?.addr || null;
}

/** Strip IPv4-mapped IPv6 and a zone id. Node reports peers as `::ffff:192.168.1.5`. */
export function normalizePeerIp(addr) {
  if (!addr) return "";
  let s = String(addr).trim().toLowerCase();
  if (s.startsWith("::ffff:")) s = s.slice(7);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  return s;
}

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n;
}

function ipv4InCidr(ipInt, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

const IPV4_TRUSTED = [
  [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("10.0.0.0"), 8],
  [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16],
  [ipv4ToInt("169.254.0.0"), 16],
  // CGNAT block used by Tailscale and similar private overlays.
  [ipv4ToInt("100.64.0.0"), 10],
];

function ipv6Trusted(ip) {
  if (ip === "::1") return true;
  const head = ip.split(":")[0];
  if (!head || !/^[0-9a-f]{1,4}$/.test(head)) return false;
  const n = Number.parseInt(head, 16);
  // fe80::/10 link-local
  if (n >= 0xfe80 && n <= 0xfebf) return true;
  // fc00::/7 unique local
  if (n >= 0xfc00 && n <= 0xfdff) return true;
  return false;
}

/**
 * True when the TCP peer is on this machine, a private LAN, link-local,
 * or a private overlay (Tailscale). Public WAN addresses are false.
 * Do not feed this X-Forwarded-For; that header is spoofable.
 */
export function isTrustedLanPeer(addr) {
  const ip = normalizePeerIp(addr);
  if (!ip || ip === "localhost") return ip === "localhost";
  const v4 = ipv4ToInt(ip);
  if (v4 != null) return IPV4_TRUSTED.some(([base, bits]) => ipv4InCidr(v4, base, bits));
  if (ip.includes(":")) return ipv6Trusted(ip);
  return false;
}
