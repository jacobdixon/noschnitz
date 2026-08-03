/* ============================================================================
   POST /api/hands — collect finished solo hands for AI analysis.
   GET  /api/hands — read them back (requires HANDS_READ_TOKEN).

   Why this exists: both AI fixes that shipped this week were found by reading
   one reported hand at a time out of a screenshot. `scripts/minehands.mjs`
   does that reading mechanically, but it needs a corpus, and solo runs
   entirely in the browser — on a phone, where nothing can reach localStorage.
   So the hands have to come here.

   WHAT IS STORED, and it matters that the list is short:

     the deal and the play  every card every seat played, plus the burial and
                            the call. This is the whole point.
     which seat was human   so a human's decisions can be told from the AI's.
     the app version        so a hand is attributable to the build that
                            produced it, same reason the recap stamps it.
     an anonymous install   a random id minted here, NOT the multiplayer
     id                     playerId and never joined to a name. Only so one
                            device's hands can be grouped together, which is
                            what makes "does this player beat the engine" a
                            question you can ask at all.

   What is NOT stored: no name, no multiplayer playerId, no table code, no
   contact of any kind. There is nothing in a record that says who played it.

   Gated by requireMultiplayer, and deliberately not by a second gate of its
   own: that gate's second condition is "a real store is configured", which is
   exactly what collection needs. An in-memory store on serverless would accept
   writes and silently lose them, so refusing is the correct answer rather than
   an unfortunate one.

   Since the 2026-07-31 promotion that gate passes on BOTH environments, so
   there are now two corpora in two different Upstash databases — Preview's,
   which is everything collected up to the promotion, and Production's, which
   starts empty and is where real play accumulates from here. They must not be
   merged casually: the hands were played against different builds, which is
   the whole reason a record carries a version. `HANDS_READ_TOKEN` is scoped per
   environment too, so reading www needs the Production copy of it.
   ========================================================================= */
import { redisFromEnv } from "../src/store/upstash.js";
import { readJson, sendJson, fail, methodGuard } from "./_lib/http.js";
import { requireMultiplayer } from "./_lib/flags.js";

const KEY = "hands:v1";

// Bounded on every axis that a public endpoint can be pushed on. None of these
// are tuned; they are the smallest numbers that cannot get in the way of real
// play, so that anything beyond them is not real play.
const MAX_BATCH = 25;          // hands per request
const MAX_BYTES = 200_000;     // ~1.1KB a hand, so this is generous for 25
const MAX_STORED = 50_000;     // ring buffer; oldest fall off the front
const MAX_READ = 5_000;

// A record has to be a played hand and nothing else. This is not a security
// boundary — it is what stops a malformed or hostile body from poisoning the
// corpus that AI decisions get made from, which is the thing actually worth
// protecting here.
export function clean(rec) {
  if (!rec || typeof rec !== "object") return null;
  if (!Array.isArray(rec.tricks) || rec.tricks.length !== 6) return null;
  for (const t of rec.tricks) {
    if (!Array.isArray(t) || t.length !== 5) return null;
    for (const p of t) {
      if (!Array.isArray(p) || p.length !== 2) return null;
      const [seat, card] = p;
      if (!Number.isInteger(seat) || seat < 0 || seat > 4) return null;
      if (!card || typeof card.rank !== "string" || typeof card.suit !== "string") return null;
      if (card.rank.length > 2 || card.suit.length !== 1) return null;
    }
  }
  const num = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  // Rebuilt field by field rather than spread, so anything the client sends
  // that is not on this list cannot reach storage even by accident.
  return {
    at: Date.now(),
    version: typeof rec.version === "string" ? rec.version.slice(0, 16) : null,
    install: typeof rec.install === "string" ? rec.install.slice(0, 40) : null,
    humanSeat: num(rec.humanSeat, 0, 4),
    handNum: num(rec.handNum, 0, 10_000),
    picker: num(rec.picker, 0, 4),
    partner: rec.partner === null ? null : num(rec.partner, 0, 4),
    alone: Boolean(rec.alone),
    calledSuit: typeof rec.calledSuit === "string" ? rec.calledSuit.slice(0, 1) : null,
    calledRank: typeof rec.calledRank === "string" ? rec.calledRank.slice(0, 2) : null,
    calledUnder: Boolean(rec.calledUnder),
    underCard: rec.underCard ?? null,
    buried: Array.isArray(rec.buried) ? rec.buried.slice(0, 2) : [],
    leader: num(rec.leader, 0, 4),
    tricks: rec.tricks,
  };
}

// `deps` is a test seam, not part of the route contract: Vercel invokes the
// handler with (req, res) and nothing else, so the third parameter is free and
// the production path is untouched. Injecting beats monkey-patching here
// because ES module namespaces are frozen — the alternative is a mutable
// module-level global, which is worse in every way that matters.
export default async function handler(req, res, deps = {}) {
  if (!methodGuard(req, res, "POST", "GET")) return;

  // The same gate as every other route, and deliberately not a second one of
  // its own. requireMultiplayer already means "this environment has a real
  // store", which is the condition collection actually needs — and one gate
  // enforced by one test (flagtest walks api/ and requires this call) is safer
  // than two mechanisms a future reader has to know about. It also keeps a
  // public write endpoint off production, which is the conservative default
  // for something anyone can POST to.
  const env = deps.env ?? process.env;
  if (!deps.redis && !requireMultiplayer(res, env)) return;

  let redis = deps.redis;
  if (!redis) {
    try { redis = redisFromEnv(env); }
    catch { return fail(res, 503, "no-store", "Store unavailable."); }
  }

  if (req.method === "GET") {
    // Card play is not sensitive, but handing the whole corpus to anyone who
    // guesses the path is still sloppy, and an unset token must close the door
    // rather than open it.
    // Vercel parses the query string onto req.query; req.url is the raw path
    // and is not always populated the same way, so query is the source here.
    const q = req.query || {};
    const token = env.HANDS_READ_TOKEN;
    const given = req.headers["x-hands-token"] || q.token;
    if (!token || given !== token) return fail(res, 404, "not-found", "Not found.");

    const limit = Math.min(MAX_READ, Number(q.limit) || 1000);
    const rows = await redis.lrange(KEY, -limit, -1);
    const total = await redis.llen(KEY);
    const hands = rows.map((r) => (typeof r === "string" ? JSON.parse(r) : r));
    return sendJson(res, 200, { total, returned: hands.length, hands });
  }

  const body = await readJson(req);
  const raw = Array.isArray(body?.hands) ? body.hands : null;
  if (!raw) return fail(res, 400, "bad-body", "Expected { hands: [...] }.");
  if (raw.length > MAX_BATCH) return fail(res, 400, "too-many", `At most ${MAX_BATCH} hands per request.`);
  if (JSON.stringify(raw).length > MAX_BYTES) return fail(res, 413, "too-big", "Batch too large.");

  const kept = raw.map(clean).filter(Boolean);
  if (kept.length) {
    await redis.rpush(KEY, ...kept.map((h) => JSON.stringify(h)));
    // Trim after the append so a burst can never grow the key without bound.
    await redis.ltrim(KEY, -MAX_STORED, -1);
  }
  // `accepted` is what the client marks as sent. Rejected records are dropped
  // rather than retried forever — a record this rejects is malformed, and
  // sending it again would only fail again.
  return sendJson(res, 200, { accepted: raw.length, stored: kept.length });
}
