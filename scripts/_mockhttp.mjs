/* ============================================================================
   Minimal req/res doubles for driving Vercel handlers headlessly.

   The routes are plain (req, res) functions, so they can be exercised without
   a server, a port, or a deployment — which keeps the end-to-end test fast
   enough to run on every change instead of only before a deploy.
   ========================================================================= */

export function mockReq({ method = "GET", body = null, query = {}, headers = {} } = {}) {
  return {
    method,
    body,
    query,
    headers,
    // Handlers that stream (SSE) register a close listener; capture it so a
    // test can simulate the client hanging up.
    _listeners: {},
    on(event, fn) {
      (this._listeners[event] ||= []).push(fn);
      return this;
    },
    emit(event) {
      (this._listeners[event] || []).forEach((fn) => fn());
    },
  };
}

export function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    writeHead(status, hdrs = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v);
      return this;
    },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk));
      this.ended = true;
      return this;
    },
    get text() { return this.chunks.join(""); },
    get json() {
      try { return JSON.parse(this.text); } catch { return null; }
    },
  };
}

// Runs a handler and resolves once it has responded.
//
// DO NOT use this on api/tables/[id]/events.js. That handler returns a promise
// that intentionally resolves only when the stream closes — an SSE invocation
// has to outlive its handler body — so awaiting it here hangs forever. Drive
// the stream endpoint the way scripts/streamtest.mjs does: hold the promise,
// advance the injected clock, then await it.
export async function call(handler, reqOpts) {
  const req = mockReq(reqOpts);
  const res = mockRes();
  await handler(req, res);
  return { req, res, status: res.statusCode, body: res.json };
}
