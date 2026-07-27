/* ============================================================================
   Tiny HTTP helpers shared by the table routes.

   Deliberately not a framework: there are six endpoints, and the whole surface
   is "parse a JSON body, send a JSON body, or fail with a stable code". Error
   shapes are consistent so the client can branch on `error.code` rather than
   pattern-matching prose.

   Files under api/_lib are NOT routes — Vercel treats a leading underscore as
   private and won't expose them as endpoints.
   ========================================================================= */

// Vercel's Node runtime usually pre-parses JSON bodies, but not for every
// content-type, and not when the function is invoked directly in tests. Handle
// both: pass through an already-parsed object, otherwise read the stream.
export async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"));
  } catch {
    return {};
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Table state is per-player and changes constantly; never let a CDN or a
  // browser serve a stale hand.
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
  return res;
}

export function fail(res, status, code, message) {
  return sendJson(res, status, { error: { code, message } });
}

// Returns false (and responds) when the method isn't allowed, so callers can
// `if (!methodGuard(req, res, "POST")) return;`
export function methodGuard(req, res, ...allowed) {
  if (allowed.includes(req.method)) return true;
  res.setHeader("Allow", allowed.join(", "));
  fail(res, 405, "method-not-allowed", `${req.method} not allowed here`);
  return false;
}
