#!/usr/bin/env node
/* ============================================================================
   /api/hands — the collection endpoint.

   This is a public POST that writes into the corpus AI decisions get made
   from, which is the thing actually worth protecting here. Card play is not
   sensitive; a poisoned corpus is, because a fabricated "hand" that survives
   validation becomes evidence in `minehands.mjs` and could argue for a change
   to how the game plays.

   So the assertions are mostly about what the endpoint REFUSES, and about the
   record it stores being built field by field rather than echoed back — a
   client must not be able to get an extra key into storage even by accident.

   Usage: node scripts/handstest.mjs
   ========================================================================= */
import { call } from "./_mockhttp.mjs";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* A fake Redis, so this runs with no credentials and no network. */
const store = [];
const fakeRedis = {
  async rpush(_k, ...vals) { store.push(...vals); return store.length; },
  async ltrim(_k, start) { if (start < 0 && store.length > -start) store.splice(0, store.length + start); return "OK"; },
  async lrange(_k, from, to) { return store.slice(from, to === -1 ? undefined : to + 1); },
  async llen() { return store.length; },
};

// The route takes an optional third argument purely so this can drive it with
// a fake store and a controlled env. Wrapped here so `call` — which only ever
// passes (req, res) — still works unchanged.
import route from "../api/hands.js";
const env = { KV_REST_API_URL: "https://example.invalid", KV_REST_API_TOKEN: "t" };
const hands = (req, res) => route(req, res, { redis: fakeRedis, env });
const handsNoStore = (req, res) => route(req, res, { env: {} });

/* ---------------------------- a valid record ----------------------------- */
const C = (rank, suit) => ({ rank, suit });
const trick = (seats) => seats.map((s, i) => [s, C(["7", "8", "9", "K", "10", "A"][i], "C")]);
const goodHand = () => ({
  version: "0.31.0", humanSeat: 0, handNum: 3, picker: 2, partner: 4, alone: false,
  calledSuit: "C", calledRank: "A", calledUnder: false, underCard: null,
  buried: [C("K", "H"), C("9", "S")], leader: 0,
  tricks: Array.from({ length: 6 }, () => trick([0, 1, 2, 3, 4])),
});

/* ------------------------------- shape ----------------------------------- */
{
  const r = await call(hands, { method: "POST", body: { hands: [goodHand()] } });
  check("a well-formed hand is stored", r.status === 200 && r.body.stored === 1, JSON.stringify(r.body));
}
{
  const r = await call(hands, { method: "POST", body: {} });
  check("a body without hands is refused", r.status === 400, `status=${r.status}`);
}
{
  const r = await call(hands, { method: "POST", body: { hands: Array(26).fill(goodHand()) } });
  check("an oversized batch is refused", r.status === 400, `status=${r.status}`);
}
{
  const r = await call(hands, { method: "DELETE", body: {} });
  check("only POST and GET are allowed", r.status === 405, `status=${r.status}`);
}

/* --------------------- records that are not played hands ------------------ */
const rejects = {
  "five tricks, not six": { ...goodHand(), tricks: Array.from({ length: 5 }, () => trick([0, 1, 2, 3, 4])) },
  "a trick with four plays": (() => { const h = goodHand(); h.tricks[2] = trick([0, 1, 2, 3]); return h; })(),
  "a seat outside 0-4": (() => { const h = goodHand(); h.tricks[0][0] = [9, C("A", "C")]; return h; })(),
  "a card that is not a card": (() => { const h = goodHand(); h.tricks[0][0] = [0, { rank: 5 }]; return h; })(),
  "tricks that are not an array": { ...goodHand(), tricks: "nope" },
};
for (const [name, bad] of Object.entries(rejects)) {
  const before = store.length;
  const r = await call(hands, { method: "POST", body: { hands: [bad] } });
  check(`rejected: ${name}`, r.status === 200 && r.body.stored === 0 && store.length === before,
    `status=${r.status} stored=${r.body?.stored}`);
}

/* ----------------- nothing extra reaches storage, ever -------------------- */
{
  const sneaky = { ...goodHand(), playerName: "Jacob", email: "a@b.c", cookie: "x", nested: { a: 1 } };
  const before = store.length;
  await call(hands, { method: "POST", body: { hands: [sneaky] } });
  const rec = JSON.parse(store[store.length - 1]);
  check("an extra field is stored anyway?", store.length === before + 1);
  check("client-supplied name never reaches storage", !("playerName" in rec));
  check("client-supplied email never reaches storage", !("email" in rec));
  check("no unexpected key survives the rebuild",
    Object.keys(rec).every((k) => [
      "at", "version", "install", "humanSeat", "handNum", "picker", "partner", "alone",
      "calledSuit", "calledRank", "calledUnder", "underCard", "buried", "leader", "tricks",
    ].includes(k)), Object.keys(rec).join(","));
  check("the server stamps its own timestamp", typeof rec.at === "number" && rec.at > 1_700_000_000_000);
}

/* ------------------------------- reading --------------------------------- */
{
  delete env.HANDS_READ_TOKEN;
  const r = await call(hands, { method: "GET", query: {} });
  check("reading without a configured token is a 404, not an open door", r.status === 404, `status=${r.status}`);
}
{
  env.HANDS_READ_TOKEN = "s3cret";
  const r = await call(hands, { method: "GET", query: { token: "wrong" } });
  check("a wrong token is a 404", r.status === 404, `status=${r.status}`);
}
{
  env.HANDS_READ_TOKEN = "s3cret";
  const r = await call(hands, { method: "GET", query: { token: "s3cret", limit: "10" } });
  check("the right token reads the corpus back",
    r.status === 200 && Array.isArray(r.body.hands) && r.body.hands.length > 0,
    `status=${r.status}`);
  check("what comes back parses as hands", r.body.hands.every((h) => Array.isArray(h.tricks) && h.tricks.length === 6));
}

/* --------------------------- no store, no writes -------------------------- */
{
  const r = await call(handsNoStore, { method: "POST", body: { hands: [goodHand()] } });
  check("with no store configured it refuses rather than accepting and losing it",
    r.status === 503, `status=${r.status}`);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — /api/hands stores played hands and refuses everything else.");
