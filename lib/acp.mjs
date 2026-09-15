/** Node ACP WebSocket client for grok agent serve. */
export function extractSessionId(session, fallback = null) {
  if (!session || typeof session !== "object") return fallback;
  return (
    session.sessionId ||
    session.session_id ||
    session._meta?.sessionId ||
    session._meta?.session_id ||
    fallback
  );
}

export class AcpClient {
  constructor(url, { log = () => {} } = {}) {
    this.url = url;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = null;
    this.onAgentRequest = null;
    this.onClose = null;
    this.ws = null;
    this.agentInfo = null;
    this.sessionId = null;
  }

  get ready() {
    return this.ws?.readyState === 1;
  }

  connect({ timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      this.log("ws", `connecting ${String(this.url).replace(/server-key=[^&]+/, "server-key=…")}`);
      this.ws = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), timeoutMs);
      const onOpen = () => {
        clearTimeout(timer);
        this.log("ws", "open");
        resolve();
      };
      const onError = (ev) => {
        clearTimeout(timer);
        reject(ev.error || new Error("WebSocket error"));
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
      this.ws.addEventListener("message", (ev) => this._onMessage(ev.data));
      this.ws.addEventListener("close", (ev) => {
        this.log("ws", `closed ${ev.code}`);
        for (const [, p] of this.pending) p.reject(new Error("WebSocket closed"));
        this.pending.clear();
        if (this.onClose) this.onClose(ev);
      });
    });
  }

  _onMessage(raw) {
    const text = typeof raw === "string" ? raw : raw.toString();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.log("ws", "non-JSON", text.slice(0, 120));
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          Object.assign(new Error(msg.error.message || "RPC error"), { raw: msg.error })
        );
      } else pending.resolve(msg.result);
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
        const result = await this.onAgentRequest(msg.method, msg.params || {});
        if (result !== undefined) {
          this._respond(msg.id, result ?? {});
          return;
        }
      }
      if (msg.method === "session/request_permission") {
        const options = msg.params?.options || [];
        const allow =
          options.find((o) => o.optionId === "allow_once") ||
          options.find((o) => /allow/i.test(o.optionId || "")) ||
          options[0];
        this._respond(msg.id, {
          outcome: { outcome: "selected", optionId: allow?.optionId || "allow_once" },
        });
        return;
      }
      this._respondError(msg.id, -32601, `Not implemented: ${msg.method}`);
    } catch (err) {
      this._respondError(msg.id, -32000, String(err.message || err));
    }
  }

  request(method, params, { timeoutMs = 120_000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout ${timeoutMs}ms on ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method, params) {
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    this.ws.send(JSON.stringify(msg));
  }

  _respond(id, result) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  _respondError(id, code, message) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  async handshake({ cwd, resumeSessionId, createSession = true } = {}) {
    const initResult = await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "grok-remote", title: "Grok Remote", version: "0.1.0" },
      },
      { timeoutMs: 30_000 }
    );
    this.agentInfo = initResult;
    const methods = initResult?.authMethods || [];
    if (methods.length) {
      const methodId =
        methods.find((m) => m.id === "cached_token")?.id || methods[0].id;
      await this.request(
        "authenticate",
        { methodId },
        { timeoutMs: 45_000 }
      );
    }
    if (!createSession) return { initResult, session: null };
    let session = null;
    if (resumeSessionId) {
      for (const method of ["session/load", "session/resume"]) {
        try {
          session = await this.request(
            method,
            { sessionId: resumeSessionId, cwd, mcpServers: [] },
            { timeoutMs: 60_000 }
          );
          const id = extractSessionId(session, resumeSessionId);
          if (id) {
            this.sessionId = id;
            return { initResult, session: { ...session, sessionId: id } };
          }
        } catch (err) {
          this.log("session", `${method} failed`, err.message);
        }
      }
    }
    session = await this.request(
      "session/new",
      { cwd, mcpServers: [] },
      { timeoutMs: 60_000 }
    );
    this.sessionId = extractSessionId(session, null);
    return { initResult, session: { ...session, sessionId: this.sessionId } };
  }

  async listSessions() {
    try {
      const ext = await this.request("_x.ai/sessions/list", {}, { timeoutMs: 20_000 });
      const body = ext?.result ?? ext;
      if (Array.isArray(body?.sessions)) return body.sessions;
    } catch {
      /* fall through */
    }
    const basic = await this.request("session/list", {}, { timeoutMs: 20_000 });
    return basic?.sessions || [];
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}
