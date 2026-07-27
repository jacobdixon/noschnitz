#!/usr/bin/env node
/* ============================================================================
   End-to-end regression test — the real HTTP handlers, start to finish.

   The other harnesses each prove one layer: leaktest guards `viewFor`,
   tabletest the lifecycle, storetest the store contract, aitest the AI driver.
   This one wires all of them together the way a live table actually does —
   create, join, start, play a complete hand — through the same (req, res)
   functions Vercel invokes, so an integration mistake between layers can't
   pass by virtue of each layer being individually correct.

   The invariant it exists to protect, checked after EVERY single response:
   no payload ever contains a card belonging to another seat, and no payload
   ever contains another player's playerId (a bearer token — anyone holding it
   can act as that player).

   Uses the in-memory store, so no credentials and no network.

   Usage: node scripts/e2etest.mjs
   ========================================================================= */
import { call } from "./_mockhttp.mjs";
import { _resetStore } from "../api/_lib/store.js";
import { createMemoryStore } from "../src/store/memory.js";
import { cid, legalPlays } from "../src/engine.js";
import { seatOf } from "../src/table.js";

import createTableRoute from "../api/tables/index.js";
import joinRoute from "../api/tables/[id]/join.js";
import startRoute from "../api/tables/[id]/start.js";
import stateRoute from "../api/tables/[id]/state.js";
import playRoute from "../api/tables/[id]/play.js";
import pickRoute from "../api/tables/[id]/pick.js";
import buryRoute, { callableSuits } from "../api/tables/[id]/bury.js";
import leaveRoute from "../api/tables/[id]/leave.js";
import nameRoute from "../api/tables/[id]/name.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* ---------------------------------------------------------------------------
   The security sweep. Runs against every response body in the whole test.
   ------------------------------------------------------------------------ */

// Collect every card-shaped object anywhere in a payload, with its path.
const isCard = (v) => v && typeof v === "object" && typeof v.rank === "string" && typeof v.suit === "string";
function collectCards(node, path = "", out = []) {
  if (isCard(node)) { out.push({ id: cid(node), path }); return out; }
  if (Array.isArray(node)) { node.forEach((v, i) => collectCards(v, `${path}[${i}]`, out)); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectCards(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

function collectStrings(node, out = []) {
  if (typeof node === "string") { out.push(node); return out; }
  if (Array.isArray(node)) { node.forEach((v) => collectStrings(v, out)); return out; }
  if (node && typeof node === "object") Object.values(node).forEach((v) => collectStrings(v, out));
  return out;
}

// `truth` is the real table straight out of the store — what the server knows.
// `body` is what we actually sent to `viewer`. Nothing in the second may reveal
// anything the first says belongs to somebody else.
function assertNoLeak(label, body, truth, viewerSeat, viewerPlayerId, allPlayerIds) {
  if (!body || !truth) return;
  const g = truth.g;

  if (g) {
    const entitled = new Set();
    (g.hands[viewerSeat] || []).forEach((c) => entitled.add(cid(c)));
    (g.played || []).forEach((c) => entitled.add(cid(c)));
    (g.trick || []).forEach((p) => entitled.add(cid(p.card)));
    (g.lastTrick?.trick || []).forEach((p) => entitled.add(cid(p.card)));
    (g.trickHistory || []).forEach((h) => (h.trick || []).forEach((p) => entitled.add(cid(p.card))));
    if (viewerSeat === g.picker) {
      (g.blind || []).forEach((c) => entitled.add(cid(c)));
      (g.buried || []).forEach((c) => entitled.add(cid(c)));
    }
    if (g.phase === "handEnd") {
      g.hands.forEach((h) => (h || []).forEach((c) => entitled.add(cid(c))));
      (g.blind || []).forEach((c) => entitled.add(cid(c)));
      (g.buried || []).forEach((c) => entitled.add(cid(c)));
    }
    for (const { id, path } of collectCards(body)) {
      if (!entitled.has(id)) {
        failures.push(`${label}: leaked card ${id} at ${path} (seat ${viewerSeat})`);
        return;
      }
    }
  }

  // playerId is a bearer token: seeing someone else's means you can act as them.
  const strings = new Set(collectStrings(body));
  for (const pid of allPlayerIds) {
    if (pid !== viewerPlayerId && strings.has(pid)) {
      failures.push(`${label}: leaked another player's playerId (seat ${viewerSeat})`);
      return;
    }
  }
  passed++;
}

/* ------------------------------- The flow -------------------------------- */

const store = createMemoryStore();
_resetStore(store);

const HOST = "pid-host-aaa";
const DAVE = "pid-dave-bbb";
const ERIN = "pid-erin-ccc";
const ALL_IDS = [HOST, DAVE, ERIN];

// --- create ---------------------------------------------------------------
const created = await call(createTableRoute, {
  method: "POST",
  body: { hostName: "Jacob", playerId: HOST },
});
check("create returns 201", created.status === 201, `got ${created.status}`);
const tableId = created.body?.table?.id;
check("create returns a table id", typeof tableId === "string" && tableId.length > 0);
check("create seats the host at seat 0", created.body?.you === 0, `you=${created.body?.you}`);
check("create leaves four AI seats",
  created.body?.table?.seats?.filter((s) => s.kind === "ai").length === 4);
assertNoLeak("create", created.body, await store.get(tableId), 0, HOST, ALL_IDS);

// --- wrong methods --------------------------------------------------------
const badMethod = await call(createTableRoute, { method: "GET" });
check("create rejects GET with 405", badMethod.status === 405, `got ${badMethod.status}`);

// --- unknown table --------------------------------------------------------
const ghost = await call(stateRoute, { method: "GET", query: { id: "no-such", playerId: HOST } });
check("state on unknown table is 404", ghost.status === 404, `got ${ghost.status}`);
check("errors use a stable code", ghost.body?.error?.code === "no-such-table",
  `code=${ghost.body?.error?.code}`);

// --- join -----------------------------------------------------------------
const joined = await call(joinRoute, {
  method: "POST", query: { id: tableId }, body: { playerId: DAVE, name: "Dave" },
});
check("join succeeds in the lobby", joined.status === 200, `got ${joined.status}`);
check("join reports seated", joined.body?.status === "seated", `status=${joined.body?.status}`);
assertNoLeak("join", joined.body, await store.get(tableId), 1, DAVE, ALL_IDS);

const rejoin = await call(joinRoute, {
  method: "POST", query: { id: tableId }, body: { playerId: DAVE, name: "Dave" },
});
check("re-joining reclaims the same seat, doesn't consume another",
  (await store.get(tableId)).seats.filter((s) => s.kind === "human").length === 2);

// --- start: only the host -------------------------------------------------
const notHost = await call(startRoute, {
  method: "POST", query: { id: tableId }, body: { playerId: DAVE },
});
check("non-host cannot start the hand", notHost.status === 403, `got ${notHost.status}`);
check("non-host start uses the not-host code", notHost.body?.error?.code === "not-host");

const started = await call(startRoute, {
  method: "POST", query: { id: tableId }, body: { playerId: HOST },
});
check("host can start the hand", started.status === 200, `got ${started.status}`);
assertNoLeak("start", started.body, await store.get(tableId), 0, HOST, ALL_IDS);

// --- play a complete hand -------------------------------------------------
// Drives every HUMAN decision through the API — pick/pass, bury+call, and each
// card — while advanceAI handles the AI seats inside those same requests. The
// loop is bounded so a stuck state fails loudly instead of hanging.
//
// The human always picks when offered, so the bury+call path gets exercised
// rather than being skipped whenever an AI happens to pick first.
async function driveHand({ label = "hand", maxSteps = 160 } = {}) {
  let steps = 0;
  while (steps++ < maxSteps) {
    const truth = await store.get(tableId);
    if (!truth.g) return { done: false, reason: "no hand dealt" };
    const g = truth.g;
    if (g.phase === "handEnd") return { done: true, steps };

    // Whose decision is it, and is it a human's?
    let seat;
    if (g.phase === "picking") seat = g.pickTurn;
    else if (g.phase === "bury" || g.phase === "call") seat = g.picker;
    else seat = g.turn;

    const who = truth.seats[seat];
    if (!who || who.kind !== "human") {
      return { done: false, reason: `stalled with AI seat ${seat} to act in phase ${g.phase} — advanceAI should have handled it` };
    }
    const pid = who.playerId;

    let res;
    if (g.phase === "picking") {
      res = await call(pickRoute, {
        method: "POST", query: { id: tableId }, body: { playerId: pid, action: "pick" },
      });
    } else if (g.phase === "bury" || g.phase === "call") {
      const opts = callableSuits(g.hands[seat].slice(2), g.hands[seat].slice(0, 2));
      res = await call(buryRoute, {
        method: "POST", query: { id: tableId },
        body: { playerId: pid, cards: g.hands[seat].slice(0, 2), calledSuit: opts[0] ?? null },
      });
    } else {
      const legal = legalPlays(g, seat);
      res = await call(playRoute, {
        method: "POST", query: { id: tableId }, body: { playerId: pid, card: legal[0] },
      });
    }

    if (res.status !== 200) {
      return { done: false, reason: `${g.phase} rejected with ${res.status} ${res.body?.error?.code || ""}` };
    }
    assertNoLeak(`${label} ${g.phase} seat ${seat}`, res.body, await store.get(tableId), seat, pid, ALL_IDS);
  }
  return { done: false, reason: `exceeded ${maxSteps} steps` };
}

const hand1 = await driveHand({ label: "hand1" });
check("a full hand plays to completion through the API", hand1.done, hand1.reason);

// --- rejection paths ------------------------------------------------------
{
  // Re-deal, then drive deterministically to the playing phase. Without this
  // the rejection checks below depend on whether an AI happened to pick first,
  // which would make them silently skip on some runs — a flaky regression test
  // is worse than none.
  await call(startRoute, { method: "POST", query: { id: tableId }, body: { playerId: HOST } });

  for (let i = 0; i < 20; i++) {
    const t = await store.get(tableId);
    const g = t.g;
    if (!g || g.phase === "playing" || g.phase === "handEnd") break;
    const seat = g.phase === "picking" ? g.pickTurn : g.picker;
    const who = t.seats[seat];
    if (!who || who.kind !== "human") break;
    if (g.phase === "picking") {
      await call(pickRoute, {
        method: "POST", query: { id: tableId }, body: { playerId: who.playerId, action: "pick" },
      });
    } else {
      const opts = callableSuits(g.hands[seat].slice(2), g.hands[seat].slice(0, 2));
      await call(buryRoute, {
        method: "POST", query: { id: tableId },
        body: { playerId: who.playerId, cards: g.hands[seat].slice(0, 2), calledSuit: opts[0] ?? null },
      });
    }
  }

  const live = await store.get(tableId);
  check("reached the playing phase for rejection checks",
    live.g?.phase === "playing", `phase=${live.g?.phase}`);

  if (live.g && live.g.phase === "playing") {
    const turnSeat = live.g.turn;
    const offSeat = live.seats.findIndex((s, i) => s.kind === "human" && i !== turnSeat);

    if (offSeat >= 0) {
      const outOfTurn = await call(playRoute, {
        method: "POST", query: { id: tableId },
        body: { playerId: live.seats[offSeat].playerId, card: live.g.hands[offSeat][0] },
      });
      check("playing out of turn is rejected", outOfTurn.status === 409, `got ${outOfTurn.status}`);
      check("out-of-turn uses a stable code", outOfTurn.body?.error?.code === "not-your-turn",
        `code=${outOfTurn.body?.error?.code}`);
    }

    // A card the player does not hold — the classic "trust the client" hole.
    const notMine = live.g.hands.flat().find((c) => !live.g.hands[turnSeat].some((h) => cid(h) === cid(c)));
    if (notMine) {
      const cheat = await call(playRoute, {
        method: "POST", query: { id: tableId },
        body: { playerId: live.seats[turnSeat].playerId, card: notMine },
      });
      check("playing a card you don't hold is rejected", cheat.status === 400, `got ${cheat.status}`);
      check("illegal play uses a stable code", cheat.body?.error?.code === "illegal-play",
        `code=${cheat.body?.error?.code}`);
    }

    const stranger = await call(playRoute, {
      method: "POST", query: { id: tableId },
      body: { playerId: "pid-not-at-this-table", card: live.g.hands[turnSeat][0] },
    });
    check("a stranger cannot play", stranger.status === 403, `got ${stranger.status}`);
  }
}

// --- mid-hand join queues, doesn't disrupt --------------------------------
{
  const before = await store.get(tableId);
  const late = await call(joinRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: ERIN, name: "Erin" },
  });
  const after = await store.get(tableId);
  if (before.g && before.g.phase !== "handEnd") {
    check("mid-hand join is queued, not seated", late.body?.status === "pending",
      `status=${late.body?.status}`);
    check("mid-hand join leaves the hand in progress untouched",
      JSON.stringify(after.g) === JSON.stringify(before.g));
  }
  assertNoLeak("late join", late.body, after, -1, ERIN, ALL_IDS);
}

// --- the all-pass deadlock, end to end ------------------------------------
{
  // Everyone passing used to wedge the table permanently: advanceAI stops at
  // five passes and deferred the redeal, startHand refused because a thrown-in
  // hand wasn't a boundary, and no UI offered a way out.
  //
  // Driving this by just passing with every human doesn't reliably reach five
  // passes — the AI seats pick whenever their hand is strong enough, which is
  // ~96% of deals, so the case under test almost never happened and the test
  // passed without proving anything. So the table is put into the exact state
  // that matters (four passes already recorded, a human owing the fifth) and
  // the real route drives it from there.
  await call(startRoute, { method: "POST", query: { id: tableId }, body: { playerId: HOST } });

  const live = await store.get(tableId);
  const hostSeat = seatOf(live, HOST);
  const rigged = {
    ...live,
    version: live.version + 1,
    g: { ...live.g, phase: "picking", passes: 4, pickTurn: hostSeat, picker: null },
  };
  await store.put(rigged, live.version);

  const before = await store.get(tableId);
  check("rigged into the fifth-pass state", before.g.passes === 4 && before.g.pickTurn === hostSeat);

  const res = await call(pickRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "pass" },
  });
  check("the fifth pass is accepted", res.status === 200, `got ${res.status} ${res.body?.error?.code || ""}`);

  const after = await store.get(tableId);
  check("a thrown-in hand does not wedge the table",
    !(after.g && after.g.phase === "picking" && after.g.passes >= 5),
    `phase=${after.g?.phase} passes=${after.g?.passes}`);
  check("the thrown-in hand is redealt", after.g !== null && after.handNum === before.handNum + 1,
    `handNum ${before.handNum} -> ${after.handNum}`);
  // Not an exact card count: the redeal runs advanceTable, so an AI may already
  // have picked and play may have begun. What matters is that a genuine hand
  // exists and every seat holds cards.
  check("the redealt hand is a real deal",
    after.g.hands.every((h) => h && h.length > 0) && after.g.blind.length === 2,
    `sizes=${after.g.hands.map((h) => (h ? h.length : "null")).join(",")}`);
  check("the redealt hand starts from a clean pass count", after.g.passes < 5);
  assertNoLeak("fifth pass", res.body, after, hostSeat, HOST, ALL_IDS);
}

// --- naming: set at the door, changeable afterwards -----------------------
{
  // The host used to be named the literal string "Host" because the create
  // flow never asked, and a returning guest was auto-joined with whatever
  // localStorage held — so there was no point at which a name could be chosen
  // or corrected. The rename route is what makes it correctable.
  const before = await store.get(tableId);
  const hostSeat = seatOf(before, HOST);

  const renamed = await call(nameRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, name: "Jacob D" },
  });
  check("renaming succeeds", renamed.status === 200, `got ${renamed.status}`);
  check("the new name is stored",
    (await store.get(tableId)).seats[hostSeat]?.name === "Jacob D",
    `got ${(await store.get(tableId)).seats[hostSeat]?.name}`);
  assertNoLeak("rename", renamed.body, await store.get(tableId), hostSeat, HOST, ALL_IDS);

  // Re-saving the same name must not keep appending suffixes — the collision
  // check has to exclude your own seat.
  await call(nameRoute, { method: "POST", query: { id: tableId }, body: { playerId: HOST, name: "Jacob D" } });
  check("re-saving your own name doesn't suffix it",
    (await store.get(tableId)).seats[hostSeat]?.name === "Jacob D",
    `got ${(await store.get(tableId)).seats[hostSeat]?.name}`);

  // But it must still collide with everyone else, including the AI.
  const aiName = (await store.get(tableId)).seats.find((x) => x.kind === "ai")?.name;
  if (aiName) {
    await call(nameRoute, { method: "POST", query: { id: tableId }, body: { playerId: HOST, name: aiName } });
    const after = (await store.get(tableId)).seats[hostSeat]?.name;
    check("renaming still collides with an AI name", after !== aiName, `got ${after}`);
  }

  const blank = await call(nameRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, name: "   " },
  });
  check("a blank name is rejected", blank.status === 400, `got ${blank.status}`);

  const stranger = await call(nameRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: "pid-nobody", name: "X" },
  });
  check("a stranger cannot rename a seat", stranger.status === 403, `got ${stranger.status}`);
}

// --- state + leave --------------------------------------------------------
{
  const st = await call(stateRoute, { method: "GET", query: { id: tableId, playerId: DAVE } });
  check("state returns 200 for a seated player", st.status === 200, `got ${st.status}`);
  const truth = await store.get(tableId);
  const daveSeat = truth.seats.findIndex((s) => s.playerId === DAVE);
  assertNoLeak("state", st.body, truth, daveSeat, DAVE, ALL_IDS);

  const versionBefore = truth.version;
  await call(stateRoute, { method: "GET", query: { id: tableId, playerId: DAVE } });
  check("state (presence ping) does not bump the CAS version",
    (await store.get(tableId)).version === versionBefore,
    `${versionBefore} -> ${(await store.get(tableId)).version}`);

  const left = await call(leaveRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: DAVE },
  });
  check("leaving succeeds", left.status === 200, `got ${left.status}`);
  const afterLeave = await store.get(tableId);
  check("the vacated seat goes back to an AI",
    afterLeave.seats[daveSeat]?.kind === "ai", `kind=${afterLeave.seats[daveSeat]?.kind}`);
  check("the table stays playable after someone leaves",
    afterLeave.seats.filter((s) => s.kind === "human").length >= 1);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.slice(0, 25).forEach((f) => console.error(`  ${f}`));
  if (failures.length > 25) console.error(`  ...and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("PASS — full table flow works end to end, and no response leaked a card or a playerId.");
