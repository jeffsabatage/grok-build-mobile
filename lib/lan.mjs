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
