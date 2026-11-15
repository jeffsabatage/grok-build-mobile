import assert from "node:assert/strict";
import test from "node:test";
import { handleApi } from "../server.mjs";

function mockRes() {
  return {
    status: 0,
    body: "",
    setHeader() {},
    writeHead(code) {
      this.status = code;
    },
    end(payload) {
      this.body = String(payload ?? "");
    },
  };
}

function pair(remoteAddress) {
  const req = {
    method: "GET",
    url: "/api/pair",
    headers: {},
    socket: { remoteAddress },
  };
  const res = mockRes();
  const handled = handleApi(req, res, new URL("/api/pair", "http://127.0.0.1"), "pairing-secret-value", "192.168.1.5");
  return { handled, res, json: JSON.parse(res.body) };
}

test("LAN peer receives the pairing secret", () => {
  const { handled, res, json } = pair("::ffff:192.168.1.40");
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.equal(json.secret, "pairing-secret-value");
  assert.equal(json.host, "192.168.1.5");
});

test("health stays open and does not return the secret", () => {
  const req = {
    method: "GET",
    url: "/api/health",
    headers: {},
    socket: { remoteAddress: "203.0.113.9" },
  };
  const res = mockRes();
  handleApi(req, res, new URL("/api/health", "http://127.0.0.1"), "pairing-secret-value", "192.168.1.5");
  const json = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(Object.hasOwn(json, "secret"), false);
});

test("other API routes still require the pairing secret", () => {
  const denied = mockRes();
  handleApi(
    { method: "GET", url: "/api/sessions", headers: {}, socket: { remoteAddress: "192.168.1.40" } },
    denied,
    new URL("/api/sessions", "http://127.0.0.1"),
    "pairing-secret-value",
    "192.168.1.5",
  );
  assert.equal(denied.status, 401);

  const allowed = mockRes();
  const url = "/api/sessions?secret=pairing-secret-value";
  handleApi(
    { method: "GET", url, headers: {}, socket: { remoteAddress: "10.0.0.2" } },
    allowed,
    new URL(url, "http://127.0.0.1"),
    "pairing-secret-value",
    "192.168.1.5",
  );
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).ok, true);
});

test("public peer gets 403 and no secret", () => {
  const { handled, res, json } = pair("203.0.113.9");
  assert.equal(handled, true);
  assert.equal(res.status, 403);
  assert.equal(json.ok, false);
  assert.equal(res.body.includes("pairing-secret-value"), false);
  assert.equal(Object.hasOwn(json, "secret"), false);
});
