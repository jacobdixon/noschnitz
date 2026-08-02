#!/usr/bin/env node
/* ============================================================================
   Voice room tests (COM-1).

   Everything here runs without a network and without a Daily account: the
   provider is injected as a fake `fetch`, which is the only way to drive the
   branches that matter — the create/read race, an expiring room, and a
   provider that says no. Those are exactly the paths a real account would
   exercise least and a games night would hit worst.

   Four properties this asserts, in rough order of what they'd cost to get
   wrong:

     1. The room name is NOT the table code. The code is a bearer credential;
        the room name goes to a third party and lands in their logs.
     2. Everyone at one table converges on ONE room, including under a race
        and including after a key rotation.
     3. The gate refuses in both directions, and the 503 that names the missing
        credential names it WITHOUT its value.
     4. Somebody who isn't at the table can't spend our provider quota.

   Usage: node scripts/voicetest.mjs
   ========================================================================= */
import { createTable, joinTable, setVoiceRoom, voiceRoomIsFresh, VOICE_RENEW_MARGIN_MS } from "../src/table.js";
import { roomNameFor, ensureRoom, voiceEnvReport, hasVoiceProvider, ROOM_TTL_MS, VOICE_ENV_KEYS } from "../api/_lib/voice.js";
import { voiceEnabled, requireVoice } from "../api/_lib/flags.js";
import { createMemoryStore } from "../src/store/memory.js";
import { _resetStore } from "../api/_lib/store.js";
import { call } from "./_mockhttp.mjs";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const mockRes = () => ({
  statusCode: 200, headers: {}, body: "",
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  end(c) { this.body = c || ""; },
});
const codeOf = (res) => { try { return JSON.parse(res.body).error.code; } catch { return null; } };

const KEY = "test-daily-key-do-not-use";
const ENV_ON = { MULTIPLAYER: "1", VOICE: "1", DAILY_API_KEY: KEY, KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t" };

/* ------------------------- 1. the name is not the code -------------------- */
{
  const code = "abc23xyz";
  const name = roomNameFor(code, { DAILY_API_KEY: KEY });

  check("the room name does not contain the table code", !name.includes(code), name);
  check("the room name is deterministic", name === roomNameFor(code, { DAILY_API_KEY: KEY }));
  check("different tables get different rooms",
    name !== roomNameFor("zzz45678", { DAILY_API_KEY: KEY }));

  // The keying is the part that makes a leaked room list worthless. Same table,
  // different key, different name — so a name cannot be brute-forced back to a
  // table code by anyone who doesn't already hold the key.
  check("the name is keyed on the API key",
    name !== roomNameFor(code, { DAILY_API_KEY: "a-different-key" }));

  check("the room name is safe for a URL", /^ns-[0-9a-f]{24}$/.test(name), name);
}

/* --------------------------- 2. freshness + races ------------------------- */
{
  const now = 1_000_000_000_000;
  const fresh = { url: "https://x.daily.co/ns-a", expiresAt: now + ROOM_TTL_MS };
  const expiring = { url: "https://x.daily.co/ns-a", expiresAt: now + VOICE_RENEW_MARGIN_MS - 1 };

  check("a new room is fresh", voiceRoomIsFresh(fresh, now));
  check("a room inside the renew margin is not", !voiceRoomIsFresh(expiring, now));
  check("no room is not fresh", !voiceRoomIsFresh(null, now) && !voiceRoomIsFresh({}, now));

  const t0 = createTable({ hostPlayerId: "h", hostName: "Host", now, id: "abc23xyz" });
  check("a new table has no room", t0.voice === null);

  const t1 = setVoiceRoom(t0, { voice: fresh, now });
  check("provisioning caches the room", t1.voice.url === fresh.url);
  check("...and bumps the version so other clients hear about it", t1.version === t0.version + 1);

  // Idempotent: four more people tapping the button must not write four times.
  const t2 = setVoiceRoom(t1, { voice: fresh, now });
  check("caching the same room again is a no-op", t2 === t1);

  // The race that matters. A key rotation between two provisioning calls makes
  // two genuinely different rooms; the table must not flip to the second, or
  // the people already talking in the first are stranded.
  const other = { url: "https://x.daily.co/ns-b", expiresAt: now + ROOM_TTL_MS };
  const t3 = setVoiceRoom(t1, { voice: other, now });
  check("a second, different room does not displace a fresh one", t3 === t1);

  // ...but an expiring room must still be replaceable, or a long session
  // silently loses audio at the TTL with no error anywhere.
  const held = setVoiceRoom(t0, { voice: expiring, now });
  const renewed = setVoiceRoom(held, { voice: other, now });
  check("an expiring room IS replaced", renewed.voice.url === other.url);
}

/* ------------------------------ 3. the gate ------------------------------- */
{
  check("voice off when unset", !voiceEnabled({}));
  check("voice off when not exactly 1", !voiceEnabled({ VOICE: "true" }));
  check("voice on when 1", voiceEnabled({ VOICE: "1" }));

  check("no provider when unset", !hasVoiceProvider({}));
  check("provider when the key is set", hasVoiceProvider({ DAILY_API_KEY: KEY }));

  // Production's shape today: multiplayer on, voice off.
  let res = mockRes();
  check("production is refused",
    requireVoice(res, { MULTIPLAYER: "1", KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t" }) === false);
  check("...with 503", res.statusCode === 503, `got ${res.statusCode}`);
  check("...and a code distinct from multiplayer's", codeOf(res) === "voice-disabled", `got ${codeOf(res)}`);

  // The half-configured case — flag on, key missing — which is the one that
  // shows a working button that fails when tapped.
  res = mockRes();
  check("voice on with no key is refused",
    requireVoice(res, { MULTIPLAYER: "1", VOICE: "1", KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t" }) === false);
  check("...with its own code", codeOf(res) === "no-voice-provider", `got ${codeOf(res)}`);

  // Voice never bypasses the multiplayer gate beneath it.
  res = mockRes();
  check("voice on but multiplayer off is still refused", requireVoice(res, { VOICE: "1", DAILY_API_KEY: KEY }) === false);
  check("...as multiplayer, not as voice", codeOf(res) === "multiplayer-disabled", `got ${codeOf(res)}`);

  check("the gate passes when everything is set", requireVoice(mockRes(), ENV_ON) === true);

  // NAMES ONLY. This body goes to any client that trips the failure, and
  // DAILY_API_KEY is account-wide — it can create, list and delete every room.
  const report = voiceEnvReport({ DAILY_API_KEY: KEY, DAILY_SUBDOMAIN: "nope", VOICE_THING: "x" });
  const serialized = JSON.stringify(report);
  check("the report names the accepted key", report.accepted.DAILY_API_KEY === true);
  check("the report NEVER carries a value", !serialized.includes(KEY), serialized);
  check("...not even a near-miss value", !serialized.includes("nope"), serialized);
  check("the report lists near-miss NAMES", report.otherNamesPresent.includes("DAILY_SUBDOMAIN"));
  check("the accepted list matches the predicate", VOICE_ENV_KEYS.length === Object.keys(report.accepted).length);
}

/* ------------------------- 4. ensureRoom against a fake ------------------- */
{
  const now = 1_000_000_000_000;

  // Happy path.
  {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, method: opts?.method || "GET", body: opts?.body });
      return { ok: true, status: 200, json: async () => ({ url: "https://ns.daily.co/ns-x", name: "ns-x" }) };
    };
    const room = await ensureRoom("abc23xyz", { now, env: { DAILY_API_KEY: KEY }, fetchImpl });
    check("a room is created", room.url === "https://ns.daily.co/ns-x");
    check("...with an expiry we can cache against", room.expiresAt === now + ROOM_TTL_MS);

    const sent = JSON.parse(calls[0].body);
    check("the room is public, so guests need no token", sent.privacy === "public");
    check("video starts off — this is audio only", sent.properties.start_video_off === true);
    check("Daily's own pre-join UI is off", sent.properties.enable_prejoin_ui === false);
    check("the room expires on its own", typeof sent.properties.exp === "number");
    check("...in SECONDS, not milliseconds",
      Math.abs(sent.properties.exp - (now + ROOM_TTL_MS) / 1000) < 2, `${sent.properties.exp}`);
    check("the table code is not in the request", !calls[0].body.includes("abc23xyz"));
  }

  // Lost the create race: Daily says the name is taken, so read it back. This
  // is the normal outcome when five people tap the button at once, not an error.
  {
    const fetchImpl = async (url, opts) => {
      if ((opts?.method || "GET") === "POST") {
        return { ok: false, status: 400, text: async () => "name taken" };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ url: "https://ns.daily.co/ns-x", name: "ns-x", config: { exp: Math.floor((now + 3600_000) / 1000) } }),
      };
    };
    const room = await ensureRoom("abc23xyz", { now, env: { DAILY_API_KEY: KEY }, fetchImpl });
    check("losing the create race reads the winner's room", room.url === "https://ns.daily.co/ns-x");
    // Trusting our own arithmetic here would cache a URL past the point the
    // room stops existing, which is the one thing this cache must never do.
    check("...and takes ITS expiry, not ours",
      Math.abs(room.expiresAt - (now + 3600_000)) < 2000, `${room.expiresAt}`);
  }

  // A provider that is simply down. Must throw rather than resolve to
  // something falsy — a silent failure looks to a player exactly like a room
  // nobody else has joined yet.
  {
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "boom" });
    let threw = null;
    try {
      await ensureRoom("abc23xyz", { now, env: { DAILY_API_KEY: KEY }, fetchImpl });
    } catch (e) { threw = e; }
    check("a provider failure throws", threw !== null);
    check("...with a stable code", threw?.code === "voice-provider-error", `${threw?.code}`);
  }
}

/* --------------------------- 5. the route end to end ---------------------- */
{
  const prevEnv = {};
  for (const [k, v] of Object.entries(ENV_ON)) { prevEnv[k] = process.env[k]; process.env[k] = v; }

  const store = createMemoryStore();
  _resetStore(store);

  const now = Date.now();
  let table = createTable({ hostPlayerId: "host-1", hostName: "Jake", now, id: "abc23xyz" });
  // A watcher, who is at the table but has no seat.
  table = joinTable(table, { playerId: "watch-1", name: "Dave", now }).table;
  await store.create(table, now);

  // The route provisions through the real handler, with only the network faked.
  globalThis.fetch = async (url, opts) =>
    (opts?.method || "GET") === "POST"
      ? { ok: true, status: 200, json: async () => ({ url: "https://ns.daily.co/ns-x", name: "ns-x" }) }
      : { ok: false, status: 404, text: async () => "" };

  const handler = (await import("../api/tables/[id]/voice.js")).default;

  let r = await call(handler, { method: "GET", query: { id: "abc23xyz" } });
  check("GET is refused", r.status === 405, `${r.status}`);

  r = await call(handler, { method: "POST", query: { id: "abc23xyz" }, body: {} });
  check("a playerId is required", r.status === 400, `${r.status}`);

  r = await call(handler, { method: "POST", query: { id: "nosuchtb" }, body: { playerId: "host-1" } });
  check("an unknown table 404s", r.status === 404, `${r.status}`);

  // The quota gate. Someone holding a table code but not at the table cannot
  // make us call a third party.
  r = await call(handler, { method: "POST", query: { id: "abc23xyz" }, body: { playerId: "stranger" } });
  check("a stranger cannot provision", r.status === 403, `${r.status}`);
  check("...with a stable code", r.body?.error?.code === "not-at-table", `${r.body?.error?.code}`);

  r = await call(handler, { method: "POST", query: { id: "abc23xyz" }, body: { playerId: "host-1" } });
  check("a seated player gets a room", r.status === 200 && r.body?.voice?.url === "https://ns.daily.co/ns-x",
    `${r.status} ${JSON.stringify(r.body)}`);

  // A watcher is AT the table — they arrived from the link and are announced to
  // the room. Keeping them out of the conversation while they wait for a seat
  // would be exactly backwards.
  r = await call(handler, { method: "POST", query: { id: "abc23xyz" }, body: { playerId: "watch-1" } });
  check("a queued watcher gets the SAME room", r.body?.voice?.url === "https://ns.daily.co/ns-x");

  // And the second call must not have gone to the provider at all.
  let hits = 0;
  globalThis.fetch = async () => { hits++; return { ok: false, status: 500, text: async () => "" }; };
  r = await call(handler, { method: "POST", query: { id: "abc23xyz" }, body: { playerId: "host-1" } });
  check("a cached room is served without calling the provider", hits === 0, `${hits} calls`);
  check("...and still returns the room", r.body?.voice?.url === "https://ns.daily.co/ns-x");

  const stored = await store.get("abc23xyz");
  check("the room is cached on the table", stored.voice?.url === "https://ns.daily.co/ns-x");
  check("the table code is not in the room URL", !stored.voice.url.includes("abc23xyz"));

  _resetStore(null);
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

/* -------------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  console.log("\nFAIL");
  process.exit(1);
}
console.log("PASS — voice rooms are per-table, converge under races, and leak neither the code nor the key.");
