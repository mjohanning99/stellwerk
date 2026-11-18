// JSON-RPC 2.0 over the Stellwerk bridge (/ws), which relays verbatim to the
// Hermes gateway (hermes-gateway-v1). Handles reconnects, request/response
// matching, gateway events, and server->client requests.

export class Rpc extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();      // id -> {resolve, reject, method, timer}
    this.state = 'idle';           // idle | connecting | open | closed
    this.backoff = 500;
    this.serverRequestHandler = null; // async (method, params, id) => result
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
    // Phones freeze background tabs; the socket can die without a close event. When the
    // page comes back, check that the connection still answers, else reconnect.
    if (!this._wake) {
      this._wake = () => { if (document.visibilityState === 'visible') this.checkAlive(); };
      document.addEventListener('visibilitychange', this._wake);
      window.addEventListener('online', this._wake);
      window.addEventListener('pageshow', this._wake);
    }
  }

  // Any reply (even "unknown method") proves the socket is alive.
  async checkAlive(timeout = 4000) {
    if (this.stopped || this.state !== 'open' || this._checking) return;
    this._checking = true;
    try {
      await this.request('bridge.ping', {}, { timeout });
    } catch (e) {
      if (!(e instanceof RpcError) || e.code === -32001) this._kill();
    } finally { this._checking = false; }
  }

  _kill() {
    const ws = this.ws;
    if (!ws) return;
    try { ws.close(); } catch { /* already gone */ }
    ws.onclose?.({ code: 1006 });
  }
  stop() {
    this.stopped = true;
    if (this._wake) {
      document.removeEventListener('visibilitychange', this._wake);
      window.removeEventListener('online', this._wake);
      window.removeEventListener('pageshow', this._wake);
      this._wake = null;
    }
    this.ws?.close();
  }

  _setState(s, detail) {
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: { state: s, ...detail } }));
  }

  _connect() {
    if (this.stopped) return;
    this._setState('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${this.url}`);
    this.ws = ws;
    ws.onopen = () => { this.backoff = 500; };
    ws.onmessage = (ev) => this._onFrame(ev.data);
    ws.onclose = (ev) => {
      if (this.ws !== ws || ws._closed) return;
      ws._closed = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new RpcError(-32000, 'connection closed')); }
      this.pending.clear();
      this._setState('closed', { code: ev.code });
      if (!this.stopped && [1006, 1008, 4401].includes(ev.code)) {
        // 4401: the server signed this socket out (password changed, other
        // browsers signed out). A refused upgrade (401, or 404 for a backend
        // turned off elsewhere) looks like 1006. Ask the server which it was;
        // if we still have a valid cookie, the reconnect below just works.
        fetch('/api/me').then((r) => r.json()).then((me) => {
          if (!me.authed) { this.stopped = true; this.dispatchEvent(new Event('unauthorized')); }
          else if (me.backends && this.backendName && !me.backends[this.backendName]?.enabled) {
            this.stopped = true; this.dispatchEvent(new CustomEvent('disabled'));
          }
        }).catch(() => {});
      }
      if (!this.stopped) {
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 10000);
        setTimeout(() => this._connect(), delay);
      }
    };
  }

  _onFrame(raw) {
    let f;
    try { f = JSON.parse(raw); } catch { return; }
    if (Array.isArray(f)) { f.forEach((x) => this._handle(x)); return; }
    this._handle(f);
  }

  _handle(f) {
    // response
    if (f.id !== undefined && f.id !== null && !f.method) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.error) p.reject(new RpcError(f.error.code, f.error.message, f.error.data));
      else p.resolve(f.result);
      return;
    }
    if (!f.method) return;
    // server -> client request
    if (f.id !== undefined && f.id !== null) {
      this._answerServerRequest(f);
      return;
    }
    // notification
    if (f.method === 'bridge.hello') { this._setState('open', { hello: f.params }); return; }
    if (f.method === 'bridge.error') { this.dispatchEvent(new CustomEvent('bridge-error', { detail: f.params })); return; }
    if (f.method === 'event') {
      const { type, payload, session_id } = f.params || {};
      this.dispatchEvent(new CustomEvent('event', { detail: { type, payload: payload || {}, session_id: session_id ?? payload?.session_id, raw: f.params } }));
      return;
    }
    this.dispatchEvent(new CustomEvent('notify', { detail: f }));
  }

  async _answerServerRequest(f) {
    const reply = (obj) => this._send({ jsonrpc: '2.0', id: f.id, ...obj });
    if (!this.serverRequestHandler) { reply({ error: { code: -32601, message: 'not implemented' } }); return; }
    try {
      const result = await this.serverRequestHandler(f.method, f.params || {}, f.id);
      if (result === undefined) reply({ error: { code: -32601, message: `method ${f.method} not supported by Stellwerk` } });
      else reply({ result });
    } catch (e) {
      reply({ error: { code: e.code ?? -32000, message: String(e.message || e) } });
    }
  }

  _send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new RpcError(-32000, 'not connected');
    this.ws.send(JSON.stringify(obj));
  }

  request(method, params = {}, { timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      try { this._send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { reject(e); return; }
      const timer = timeout ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32001, `${method} timed out`));
      }, timeout) : null;
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  notify(method, params = {}) { this._send({ jsonrpc: '2.0', method, params }); }

  // Cancel a server request we are showing UI for (gateway sent request.cancel).
}

export class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
