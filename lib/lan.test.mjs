import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedLanPeer } from "./lan.mjs";

test("trusts loopback, RFC1918, link-local, and Tailscale CGNAT", () => {
  for (const ip of [
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "10.1.2.3",
    "192.168.1.20",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.1.1",
    "100.64.0.1",
    "100.127.255.1",
    "::ffff:192.168.0.8",
    "fe80::1",
    "fe80::1%eth0",
    "fd12:3456::1",
    "localhost",
  ]) {
    assert.equal(isTrustedLanPeer(ip), true, ip);
  }
});

test("rejects public addresses and the CIDR edges", () => {
  for (const ip of [
    "",
    null,
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.128.0.1",
    "11.0.0.1",
    "192.169.0.1",
    "::ffff:8.8.8.8",
    "2001:db8::1",
    "255.255.255.255",
  ]) {
    assert.equal(isTrustedLanPeer(ip), false, String(ip));
  }
});
