#!/usr/bin/env node
/* ============================================================================
   Store contract conformance.

   src/store/memory.js is the reference implementation of the store contract;
   src/store/upstash.js has to behave identically or the lifecycle logic that
   passes in tests will misbehave in production. So this is ONE suite run
   against BOTH — the memory store proves the suite is right, the Upstash store
   proves the adapter matches.

   The Upstash pass is skipped (not failed) when no credentials are present, so
   the suite still runs in a bare checkout. Get credentials with:

     vercel env pull .env.development.local

   Every key this writes is namespaced with a per-run prefix and deleted
   afterwards, so it never collides with a real table or leaves debris behind.

   Usage: node scripts/storetest.mjs
   ========================================================================= */
import { readFileSync } from "node:fs";
import { createMemoryStore } from "../src/store/memory.js";
import { createUpstashStore } from "../src/store/upstash.js";
import { createTable, joinTable, seatOf, humanSeats } from "../src/table.js";
import { mutate } from "../src/store/mutate.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
const freshTable = (now) => createTable({
  hostPlayerId: "p-host", hostName: "Jacob", now, id: `test-${RUN}-${n++}`,
});

/* ---------------------------------------------------------------------------
   The suite. `makeStore({ ttlMs })` returns a store; `realClock` is true when
   the store's TTL is enforced by wall-clock time (Redis) rather than an
   injectable clock (memory), which changes only how the expiry case is driven.
   ------------------------------------------------------------------------ */
async function runSuite(name, makeStore, { realClock } = {}) {
  const T = Date.now();
  const store = makeStore({});
  const created = [];
  const track = (t) => { created.push(t.id); return t; };

  try {
    // --- create / get -------------------------------------------------------
    const t = track(freshTable(T));
    const c = await store.create(t);
    check(`${name}: create succeeds`, c.ok === true);

    const got = await store.get(t.id);
    check(`${name}: get round-trips the table`, got && got.id === t.id);
    check(`${name}: round-trip preserves structure`,
      got && got.seats?.length === 5 && got.seats[0].kind === "human" && got.g === null,
      `seats=${got?.seats?.length}`);
    check(`${name}: round-trip preserves version`, got?.version === t.version);

    const dup = await store.create(t);
    check(`${name}: create refuses to overwrite`, dup.ok === false && dup.error === "exists");

    check(`${name}: get returns null for an unknown id`, (await store.get(`nope-${RUN}`)) === null);

    // --- CAS ----------------------------------------------------------------
    const next = joinTable(got, { playerId: "p1", name: "A", now: T }).table;
    const w = await store.put(next, got.version);
    check(`${name}: put succeeds at the expected version`, w.ok === true);
    check(`${name}: put persists`, humanSeats(await store.get(t.id)) === 2);

    // Same expected version again — stale by now, must be refused.
    const stale = joinTable(got, { playerId: "p2", name: "B", now: T }).table;
    const conflict = await store.put(stale, got.version);
    check(`${name}: stale put is refused`, conflict.ok === false && conflict.conflict === true);
    check(`${name}: conflict returns the CURRENT stored table`,
      conflict.table?.version === next.version && seatOf(conflict.table, "p1") > 0);
    check(`${name}: refused put did not write`, seatOf(await store.get(t.id), "p2") === -1);

    const ghost = track(freshTable(T));
    const missing = await store.put(ghost, 0);
    check(`${name}: put on an absent table reports no-such-table`,
      missing.ok === false && missing.error === "no-such-table" && !missing.conflict);

    // --- touch / del --------------------------------------------------------
    check(`${name}: touch on a live table succeeds`, (await store.touch(t.id)).ok === true);
    check(`${name}: touch on an absent table fails`, (await store.touch(`nope-${RUN}`)).ok === false);

    const doomed = track(freshTable(T));
    await store.create(doomed);
    await store.del(doomed.id);
    check(`${name}: del removes the table`, (await store.get(doomed.id)) === null);

    // --- mutate() over this store -------------------------------------------
    // The concurrency case: a competing write lands between the read and the
    // write, so the loop must retry and both joins must survive.
    const race = track(freshTable(T));
    await store.create(race);
    let injected = false;
    const racing = {
      ...store,
      get: async (id) => {
        const cur = await store.get(id);
        if (!injected && cur) {
          injected = true;
          const other = joinTable(cur, { playerId: "p-fast", name: "Fast", now: T });
          await store.put(other.table, cur.version);
        }
        return cur;
      },
    };
    const res = await mutate(racing, race.id, (cur) =>
      joinTable(cur, { playerId: "p-slow", name: "Slow", now: T }));
    const final = await store.get(race.id);
    check(`${name}: CAS retried after losing the race`, res.ok && res.attempts === 2,
      `attempts=${res.attempts}`);
    check(`${name}: both concurrent joins landed`,
      seatOf(final, "p-fast") > 0 && seatOf(final, "p-slow") > 0);
    check(`${name}: they took different seats`, seatOf(final, "p-fast") !== seatOf(final, "p-slow"));

    // --- genuinely parallel writers -----------------------------------------
    // The injected-write case above proves the retry loop reacts to a conflict,
    // but it serializes the two writers by construction. This fires four joins
    // at the store at once with no coordination, which is what actually happens
    // when four friends tap a link at the same moment on four function
    // instances. If the CAS weren't atomic on the server, some of these would
    // read the same version, all believe they won, and silently overwrite each
    // other — leaving fewer than four seated.
    const par = track(freshTable(T));
    await store.create(par);
    const joiners = ["p-a", "p-b", "p-c", "p-d"];
    const results = await Promise.all(
      joiners.map((pid) =>
        mutate(store, par.id, (cur) => joinTable(cur, { playerId: pid, name: pid, now: T })))
    );
    const parFinal = await store.get(par.id);
    check(`${name}: parallel — every writer succeeded`, results.every((r) => r.ok),
      results.filter((r) => !r.ok).map((r) => r.error).join(","));
    check(`${name}: parallel — all four joins landed, none lost`,
      joiners.every((pid) => seatOf(parFinal, pid) >= 0),
      `seated=${joiners.filter((p) => seatOf(parFinal, p) >= 0).length}/4`);
    check(`${name}: parallel — table is full with distinct seats`,
      humanSeats(parFinal) === 5 &&
      new Set(joiners.map((p) => seatOf(parFinal, p))).size === 4);
    check(`${name}: parallel — version advanced once per write`,
      parFinal.version === par.version + joiners.length,
      `version=${parFinal.version} expected=${par.version + joiners.length}`);

    // --- TTL ----------------------------------------------------------------
    if (realClock) {
      const shortStore = makeStore({ ttlMs: 1200 });
      const exp = track(freshTable(T));
      await shortStore.create(exp);
      check(`${name}: TTL — live before expiry`, (await shortStore.get(exp.id)) !== null);
      await sleep(1600);
      check(`${name}: TTL — expires once idle`, (await shortStore.get(exp.id)) === null);
    } else {
      let clock = T;
      const shortStore = makeStore({ ttlMs: 1000, now: () => clock });
      const exp = track(freshTable(T));
      await shortStore.create(exp);
      clock = T + 500;
      check(`${name}: TTL — live before expiry`, (await shortStore.get(exp.id)) !== null);
      await shortStore.touch(exp.id);
      clock = T + 1400;
      check(`${name}: TTL — touch extends the lease`, (await shortStore.get(exp.id)) !== null);
      clock = T + 3000;
      check(`${name}: TTL — expires once idle`, (await shortStore.get(exp.id)) === null);
    }
  } finally {
    // Never leave test keys behind in a shared store.
    for (const id of created) {
      try { await store.del(id); } catch { /* best effort */ }
    }
  }
}

/* ------------------------------ Credentials ------------------------------- */
// Read from .env.development.local without echoing anything: values go
// straight into process.env and are never printed.
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
    return true;
  } catch {
    return false;
  }
}

loadEnvFile(new URL("../.env.development.local", import.meta.url).pathname);
loadEnvFile(new URL("../.env.local", import.meta.url).pathname);

await runSuite("memory", ({ ttlMs, now }) => createMemoryStore({ ttlMs, now }), { realClock: false });

const haveCreds = Boolean(
  (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
  (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
);

if (haveCreds) {
  await runSuite("upstash", ({ ttlMs }) => createUpstashStore({ ttlMs }), { realClock: true });
} else {
  console.log("upstash: SKIPPED (no credentials — run `vercel env pull .env.development.local`)");
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log(`PASS — store contract holds${haveCreds ? " for both memory and Upstash" : " for memory"}.`);
