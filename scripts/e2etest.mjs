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
// The routes are gated behind the multiplayer flag and a configured store.
// Both are set here so the suite exercises the routes rather than the gate —
// scripts/flagtest.mjs is what covers the gate itself. The credentials only
// satisfy hasRealStore; _resetStore below injects the store these tests use.
process.env.MULTIPLAYER = "1";
process.env.KV_REST_API_URL ||= "test";
process.env.KV_REST_API_TOKEN ||= "test";

import { call } from "./_mockhttp.mjs";
import { _resetStore } from "../api/_lib/store.js";
import { createMemoryStore } from "../src/store/memory.js";
import { cid, legalPlays, freshHand, ALL_CARDS } from "../src/engine.js";
import { seatOf, isBootable } from "../src/table.js";

import createTableRoute from "../api/tables/index.js";
import joinRoute from "../api/tables/[id]/join.js";
import startRoute from "../api/tables/[id]/start.js";
import stateRoute from "../api/tables/[id]/state.js";
import playRoute from "../api/tables/[id]/play.js";
import pickRoute from "../api/tables/[id]/pick.js";
import buryRoute, { callableSuits } from "../api/tables/[id]/bury.js";
import seatRoute from "../api/tables/[id]/seat.js";

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
    const revealed = g.phase === "handEnd";
    const isPicker = viewerSeat === g.picker;
    const entitled = new Set();
    const add = (c) => c && entitled.add(cid(c));

    (g.hands[viewerSeat] || []).forEach(add);
    (g.played || []).forEach(add);
    (g.trick || []).forEach((p) => add(p.card));
    (g.lastTrick?.trick || []).forEach((p) => add(p.card));
    (g.trickHistory || []).forEach((h) => (h.trick || []).forEach((p) => add(p.card)));
    if (isPicker || revealed) {
      (g.blind || []).forEach(add);
      (g.buried || []).forEach(add);
      // The card set aside to play under. The picker chose it; nobody else may
      // know it until the hand is over.
      add(g.underCard);
    }
    if (revealed) g.hands.forEach((h) => (h || []).forEach(add));

    // A card played under sits on the trick as the 6 of the called suit with
    // its real face alongside as `actual`. That face is legitimately visible to
    // exactly three parties: the picker, whoever WON the trick it fell in (they
    // gathered it), and everyone once the hand ends. So it cannot simply be
    // added to the entitled set — it has to be entitled per viewer, per trick,
    // or this check would wave through the very leak the rule exists to stop.
    const maySeeUnder = (winner) =>
      revealed || isPicker || (winner !== null && winner === viewerSeat);
    if (maySeeUnder(null)) (g.trick || []).forEach((p) => add(p.actual));
    (g.trickHistory || []).forEach((h) => {
      if (maySeeUnder(h.winner)) (h.trick || []).forEach((p) => add(p.actual));
    });
    if (g.lastTrick && maySeeUnder(g.lastTrick.winner)) {
      (g.lastTrick.trick || []).forEach((p) => add(p.actual));
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


// The bury+call payload for a seat, in one place.
//
// It was written out twice — in driveHand and again in the rejection-check
// setup — and when under landed only one copy learned about it. The other kept
// sending an under call with no card to carry it, the server rightly refused
// with `no-under-call`, and the suite failed intermittently in a place that
// had nothing to do with what it was testing. One copy, so there is one thing
// to keep correct.
function buryBody(g, seat, playerId) {
  const buried = g.hands[seat].slice(0, 2);
  const kept = g.hands[seat].slice(2);
  const opt = callableSuits(kept, buried)[0] ?? null;
  const body = {
    playerId,
    cards: buried,
    // The call is a (suit, rank) pair — an ace normally, a ten when the picker
    // holds all three fail aces.
    calledSuit: opt?.suit ?? null,
    calledRank: opt?.rank ?? "A",
  };
  // ...and under is not a call at all until one of the six carries it.
  if (opt?.kind === "under") body.underCard = cid(kept[kept.length - 1]);
  return body;
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

// --- start: anyone seated, and only once ----------------------------------
// Dealing is not the host's office. It was, and that made the host a single
// point of failure the table could not recover from — see the header of
// api/tables/[id]/start.js.
const stranger = await call(startRoute, {
  method: "POST", query: { id: tableId }, body: { playerId: "p-nobody" },
});
check("someone with no seat cannot start the hand", stranger.status === 403, `got ${stranger.status}`);
check("unseated start uses the not-seated code", stranger.body?.error?.code === "not-seated",
  `code=${stranger.body?.error?.code}`);

// Dave holds seat 1 and is not the host.
const started = await call(startRoute, {
  method: "POST", query: { id: tableId }, body: { playerId: DAVE },
});
check("a seated non-host can start the hand", started.status === 200, `got ${started.status}`);
assertNoLeak("start", started.body, await store.get(tableId), 1, DAVE, ALL_IDS);

// Everyone closes their own hand-end summary now, so several players racing to
// deal the same hand is routine rather than exotic. The second one through must
// not deal again — the guard runs inside the CAS callback, against fresh state.
const secondDeal = await call(startRoute, {
  method: "POST", query: { id: tableId }, body: { playerId: HOST },
});
check("a second deal of the same hand is refused", secondDeal.status === 409, `got ${secondDeal.status}`);
check("the refusal is hand-in-progress", secondDeal.body?.error?.code === "hand-in-progress",
  `code=${secondDeal.body?.error?.code}`);
check("the refused deal left the hand alone", (await store.get(tableId)).g.handNum === 1,
  `handNum=${(await store.get(tableId)).g.handNum}`);

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
      res = await call(buryRoute, {
        method: "POST", query: { id: tableId }, body: buryBody(g, seat, pid),
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
      await call(buryRoute, {
        method: "POST", query: { id: tableId }, body: buryBody(g, seat, who.playerId),
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

  // The watcher's own view of the table, which is what they now SEE rather
  // than a holding page. It has to be the maximally-redacted one — seat -1,
  // no hand, nobody's token — because a spectator is the least trusted viewer
  // a table has: possession of the link is their entire credential.
  if (late.body?.status === "pending") {
    check("a watcher is handed the table", Boolean(late.body.table));
    check("...with no seat", late.body.table.you === -1, `you=${late.body.table.you}`);
    check("...and no hand at all",
      (late.body.table.g?.hands || []).every((h) => h === null),
      JSON.stringify(late.body.table.g?.hands?.map((h) => (h ? h.length : null))));
    check("...but can still see the seats to render the table",
      late.body.table.seats.length === 5 && late.body.table.seats.every((s) => s.name));
    check("...and finds themselves in the queue",
      late.body.table.pendingJoins.some((p) => p.isYou && p.name === "Erin"));
    check("...with nobody's token in it",
      late.body.table.pendingJoins.every((p) => p.playerId === undefined));
  }
}

// --- a full table takes a watcher instead of refusing ---------------------
{
  // Five humans used to be a 409. It is now a seat in the queue and a view of
  // the table — the difference between "come back later" and "you're here".
  const t = await call(createTableRoute, {
    method: "POST", body: { playerId: "pid-w-host", hostName: "Host" },
  });
  const wid = t.body.table.id;
  for (const n of [1, 2, 3, 4]) {
    await call(joinRoute, {
      method: "POST", query: { id: wid }, body: { playerId: `pid-w-${n}`, name: `W${n}` },
    });
  }
  const filled = await store.get(wid);
  check("five humans are seated", filled.seats.filter((s) => s.kind === "human").length === 5);

  const sixth = await call(joinRoute, {
    method: "POST", query: { id: wid }, body: { playerId: "pid-w-6", name: "Six" },
  });
  check("a sixth person is admitted as a watcher", sixth.status === 200, `got ${sixth.status}`);
  check("...as pending, not seated", sixth.body?.status === "pending", `status=${sixth.body?.status}`);
  check("...and is told which seat they're waiting on — there is none, so the other line",
    sixth.body?.table?.pendingJoins?.[0]?.name === "Six");
  check("...without displacing anyone",
    (await store.get(wid)).seats.filter((s) => s.kind === "human").length === 5);
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

// --- going alone by choice, with a partner on offer -----------------------
{
  // The picker may decline a perfectly good call and take the 4x. The route
  // used to refuse that: a null calledSuit with a non-empty option list fell
  // past the `no-callable-suit` branch into `bad-call` and came back 400, so
  // the only picker who could go alone was one with nobody to call.
  //
  // Rigged rather than driven, for the same reason the all-pass case above is:
  // reaching a HUMAN bury with something callable depends on which seat the AI
  // let pick, so driving it would silently skip on most runs.
  await call(startRoute, { method: "POST", query: { id: tableId }, body: { playerId: HOST } });

  const live = await store.get(tableId);
  const hostSeat = seatOf(live, HOST);
  // Eight cards holding two clubs and no club ace: clubs is callable, so going
  // alone here is a choice and not the absence of one.
  const hand = [
    { rank: "Q", suit: "C" }, { rank: "Q", suit: "S" }, { rank: "J", suit: "D" },
    { rank: "A", suit: "D" }, { rank: "10", suit: "D" }, { rank: "K", suit: "C" },
    { rank: "9", suit: "C" }, { rank: "8", suit: "H" },
  ];
  // The whole table is dealt, not just the picker's seat. Handing one seat a
  // hand cut from the same deck the others already hold would put duplicate
  // cards on the table, and the leak sweep — which decides ownership by card
  // id — would then read the picker's own cards as somebody else's.
  const mine = new Set(hand.map(cid));
  const others = ALL_CARDS.filter((c) => !mine.has(cid(c)));
  const dealt = freshHand(live.g.dealer, live.g.scores, live.g.handNum);
  let d = 0;
  const rigged = {
    ...live,
    version: live.version + 1,
    // Redealing the same hand number by hand leaves the AI log describing cards
    // that now belong to somebody else, and the leak sweep reads that — rightly
    // — as a seat's card appearing in a payload it has no business being in.
    aiLog: [],
    aiLogHand: live.g.handNum,
    g: {
      ...dealt,
      phase: "bury",
      picker: hostSeat,
      leader: hostSeat,
      turn: hostSeat,
      pickTurn: hostSeat,
      // The picker already holds the blind; six of the eight stay.
      blind: [],
      hands: dealt.hands.map((_, i) => (i === hostSeat ? hand : others.slice(d, (d += 6)))),
    },
  };
  await store.put(rigged, live.version);

  const buried = hand.slice(0, 2);
  const kept = hand.slice(2);
  check("rigged a bury with a partner genuinely available",
    callableSuits(kept, buried).length > 0,
    JSON.stringify(callableSuits(kept, buried)));

  const solo = await call(buryRoute, {
    method: "POST", query: { id: tableId },
    body: { playerId: HOST, cards: buried, calledSuit: null, calledRank: "A" },
  });
  check("going alone is accepted with a suit still callable",
    solo.status === 200, `got ${solo.status} ${solo.body?.error?.code || ""}`);

  const soloState = await store.get(tableId);
  check("no suit was called", soloState.g?.calledSuit === null, `got ${soloState.g?.calledSuit}`);
  check("the picker has no partner", soloState.g?.partner === null, `got ${soloState.g?.partner}`);
  check("and the hand is scored as an alone hand", soloState.g?.alone === true);
  assertNoLeak("go alone", solo.body, soloState, hostSeat, HOST, ALL_IDS);
  // Declaring alone is public — it is announced at the table — so unlike an
  // orphaned called ace, the redacted view is entitled to say so. leaktest
  // owns the per-seat proof of that; this only checks the route ships it.
  check("the view reports the picker as alone",
    solo.body?.table?.g?.alone === true, JSON.stringify(solo.body?.table?.g?.alone));
}

// --- naming: set at the door, changeable afterwards -----------------------
{
  // The host used to be named the literal string "Host" because the create
  // flow never asked, and a returning guest was auto-joined with whatever
  // localStorage held — so there was no point at which a name could be chosen
  // or corrected. The rename route is what makes it correctable.
  const before = await store.get(tableId);
  const hostSeat = seatOf(before, HOST);

  const renamed = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "rename", name: "Jacob D" },
  });
  check("renaming succeeds", renamed.status === 200, `got ${renamed.status}`);
  check("the new name is stored",
    (await store.get(tableId)).seats[hostSeat]?.name === "Jacob D",
    `got ${(await store.get(tableId)).seats[hostSeat]?.name}`);
  assertNoLeak("rename", renamed.body, await store.get(tableId), hostSeat, HOST, ALL_IDS);

  // Re-saving the same name must not keep appending suffixes — the collision
  // check has to exclude your own seat.
  await call(seatRoute, { method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "rename", name: "Jacob D" } });
  check("re-saving your own name doesn't suffix it",
    (await store.get(tableId)).seats[hostSeat]?.name === "Jacob D",
    `got ${(await store.get(tableId)).seats[hostSeat]?.name}`);

  // But it must still collide with everyone else, including the AI.
  const aiName = (await store.get(tableId)).seats.find((x) => x.kind === "ai")?.name;
  if (aiName) {
    await call(seatRoute, { method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "rename", name: aiName } });
    const after = (await store.get(tableId)).seats[hostSeat]?.name;
    check("renaming still collides with an AI name", after !== aiName, `got ${after}`);
  }

  const blank = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "rename", name: "   " },
  });
  check("a blank name is rejected", blank.status === 400, `got ${blank.status}`);

  const stranger = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: "pid-nobody", action: "rename", name: "X" },
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

  // A tab is not a person. The poll fires for as long as a tab is mounted, so
  // if every poll dated the seat, a seat could never go idle: nobody who walked
  // away could be removed, and a seat the table was WAITING on could never be
  // covered either, since coverIdleSeats reads the same clock. `active=0` is
  // the client saying "keep-alive, nobody is here".
  {
    const before = await store.get(tableId);
    const aged = {
      ...before,
      seats: before.seats.map((s, i) => (i === daveSeat ? { ...s, lastSeen: 1000 } : s)),
    };
    await store.put(aged, before.version);

    await call(stateRoute, { method: "GET", query: { id: tableId, playerId: DAVE, active: "0" } });
    check("a keep-alive poll does not date the seat",
      (await store.get(tableId)).seats[daveSeat]?.lastSeen === 1000,
      `lastSeen=${(await store.get(tableId)).seats[daveSeat]?.lastSeen}`);

    // Which is what makes the seat reachable by the boot rule at all.
    check("a seat kept alive by a tab alone is bootable",
      isBootable(await store.get(tableId), daveSeat, Date.now()));

    await call(stateRoute, { method: "GET", query: { id: tableId, playerId: DAVE, active: "1" } });
    check("a poll that speaks for a person does date the seat",
      (await store.get(tableId)).seats[daveSeat]?.lastSeen > 1000);

    // An older cached bundle sends no flag at all and must keep working the way
    // it always did — the costly mistake is calling a present player absent.
    const reaged = await store.get(tableId);
    await store.put(
      { ...reaged, seats: reaged.seats.map((s, i) => (i === daveSeat ? { ...s, lastSeen: 1000 } : s)) },
      reaged.version
    );
    await call(stateRoute, { method: "GET", query: { id: tableId, playerId: DAVE } });
    check("a poll with no flag still dates the seat",
      (await store.get(tableId)).seats[daveSeat]?.lastSeen > 1000);
  }

  const left = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: DAVE, action: "leave" },
  });
  check("leaving succeeds", left.status === 200, `got ${left.status}`);
  const afterLeave = await store.get(tableId);
  check("the vacated seat goes back to an AI",
    afterLeave.seats[daveSeat]?.kind === "ai", `kind=${afterLeave.seats[daveSeat]?.kind}`);
  check("the table stays playable after someone leaves",
    afterLeave.seats.filter((s) => s.kind === "human").length >= 1);
}

// --- boot: the table reclaiming an abandoned seat -------------------------
{
  // The threshold is re-checked server-side, so a client that renders the
  // button early can't remove somebody who is present.
  const live = await store.get(tableId);
  const hostSeat = seatOf(live, HOST);
  const victim = live.seats.findIndex((x, i) => i !== hostSeat && (x.kind === "human" || x.kind === "away"));
  const victimPid = victim >= 0 ? live.seats[victim].playerId : null;

  if (victim >= 0) {
    const tooSoon = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "boot", seat: victim },
  });
    check("booting a present player is refused", tooSoon.status === 400, `got ${tooSoon.status}`);
    check("refusal uses a stable code", tooSoon.body?.error?.code === "still-present");
    check("the refused boot changed nothing",
      (await store.get(tableId)).seats[victim]?.kind !== "ai");

    // Age them out, then it works.
    const cur = await store.get(tableId);
    const aged = {
      ...cur,
      version: cur.version + 1,
      seats: cur.seats.map((x, i) => (i === victim ? { ...x, lastSeen: Date.now() - 10 * 60 * 1000 } : x)),
    };
    await store.put(aged, cur.version);

    const ok = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "boot", seat: victim },
  });
    check("booting a long-absent player succeeds", ok.status === 200, `got ${ok.status} ${ok.body?.error?.code || ""}`);
    check("the seat goes back to the house AI",
      (await store.get(tableId)).seats[victim]?.kind === "ai");
    assertNoLeak("boot", ok.body, await store.get(tableId), hostSeat, HOST, ALL_IDS);

    // Booting is not a ban, and later cases in this file still expect this
    // player seated — so put them back, which also exercises the rejoin path.
    const back = await call(joinRoute, {
      method: "POST", query: { id: tableId }, body: { playerId: victimPid, name: "Dave" },
    });
    // Mid-hand this comes back as "pending" — MP-2.3 seats them at the next
    // boundary — so the assertion is that rejoining is ALLOWED, not that it is
    // instant.
    check("a booted player can rejoin the table",
      back.status === 200 && ["seated", "pending"].includes(back.body?.status),
      `status=${back.status} join=${back.body?.status}`);
  }

  const self = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "boot", seat: hostSeat },
  });
  check("you cannot boot yourself", self.status === 403, `got ${self.status}`);
  check("self-boot uses a stable code", self.body?.error?.code === "cannot-boot-self");

  const stranger = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: "pid-nobody", action: "boot", seat: 0 },
  });
  check("a stranger cannot boot anyone", stranger.status === 403, `got ${stranger.status}`);

  const bad = await call(seatRoute, {
    method: "POST", query: { id: tableId }, body: { playerId: HOST, action: "boot", seat: 9 },
  });
  check("an out-of-range seat is rejected", bad.status === 400, `got ${bad.status}`);
}

// --- a removed player must be able to tell, and get back ------------------
{
  // Two bugs compounded here. The redactor was called without the viewer's
  // playerId almost everywhere, so pendingJoins[].isYou was ALWAYS false — the
  // client couldn't distinguish "queued for next hand" from "your seat was
  // reclaimed" and told removed players they'd be seated shortly, which was
  // simply untrue: nothing would ever seat them.
  const fresh = await call(createTableRoute, {
    method: "POST", body: { hostName: "H", playerId: "pid-rm-host" },
  });
  const rid = fresh.body.table.id;
  await call(joinRoute, { method: "POST", query: { id: rid }, body: { playerId: "pid-rm-dave", name: "Dave" } });
  await call(startRoute, { method: "POST", query: { id: rid }, body: { playerId: "pid-rm-host" } });

  // Someone joining mid-hand is queued — and must be able to see that it's them.
  const queued = await call(joinRoute, {
    method: "POST", query: { id: rid }, body: { playerId: "pid-rm-late", name: "Late" },
  });
  check("a mid-hand joiner is queued", queued.body?.status === "pending");
  const lateView = await call(stateRoute, { method: "GET", query: { id: rid, playerId: "pid-rm-late" } });
  check("a queued player can tell the queue entry is theirs",
    (lateView.body?.table?.pendingJoins || []).some((p) => p.isYou),
    `pendingJoins=${JSON.stringify(lateView.body?.table?.pendingJoins)}`);
  check("a queued player sees no seat", lateView.body?.table?.you === -1);

  // Someone else's queue entry must NOT be flagged as theirs.
  const hostView = await call(stateRoute, { method: "GET", query: { id: rid, playerId: "pid-rm-host" } });
  check("another player's queue entry isn't flagged as yours",
    (hostView.body?.table?.pendingJoins || []).every((p) => !p.isYou));

  // Now remove Dave, and confirm a removed player is distinguishable from a
  // queued one: no seat AND no queue entry.
  const cur = await store.get(rid);
  const daveSeat = seatOf(cur, "pid-rm-dave");
  await store.put({
    ...cur, version: cur.version + 1,
    seats: cur.seats.map((x, i) => (i === daveSeat ? { ...x, lastSeen: Date.now() - 10 * 60 * 1000 } : x)),
  }, cur.version);

  const booted = await call(seatRoute, {
    method: "POST", query: { id: rid }, body: { playerId: "pid-rm-host", action: "boot", seat: daveSeat },
  });
  check("removing the player succeeds", booted.status === 200, `got ${booted.status}`);

  const daveView = await call(stateRoute, { method: "GET", query: { id: rid, playerId: "pid-rm-dave" } });
  check("a removed player has no seat", daveView.body?.table?.you === -1);
  check("a removed player is NOT in the queue — nothing would ever seat them",
    !(daveView.body?.table?.pendingJoins || []).some((p) => p.isYou));
  check("a removed player can see a seat is free to take",
    daveView.body?.table?.seats?.some((x) => x.kind === "ai"));

  // And they can actually get back in.
  const back = await call(joinRoute, {
    method: "POST", query: { id: rid }, body: { playerId: "pid-rm-dave", name: "Dave" },
  });
  check("a removed player can rejoin", back.status === 200 && ["seated", "pending"].includes(back.body?.status),
    `status=${back.status} join=${back.body?.status}`);
}

// --- presence is written by inbound requests, nothing else ----------------
{
  // The counterpart to the stream test: since the stream no longer vouches for
  // its own viewer, something has to. That something is the client pinging the
  // state route, plus every action route marking its actor.
  const fresh = await call(createTableRoute, {
    method: "POST", body: { hostName: "H", playerId: "pid-pres-host" },
  });
  const pid = fresh.body.table.id;
  await call(joinRoute, { method: "POST", query: { id: pid }, body: { playerId: "pid-pres-dave", name: "Dave" } });

  const t0 = await store.get(pid);
  const daveSeat = seatOf(t0, "pid-pres-dave");
  const hostSeat = seatOf(t0, "pid-pres-host");

  // Age BOTH players, then have only the host check in.
  const old = Date.now() - 5 * 60 * 1000;
  await store.put({
    ...t0, version: t0.version + 1,
    seats: t0.seats.map((x) => (x.playerId ? { ...x, lastSeen: old } : x)),
  }, t0.version);

  await call(stateRoute, { method: "GET", query: { id: pid, playerId: "pid-pres-host" } });
  const after = await store.get(pid);

  check("a state request marks the caller present",
    after.seats[hostSeat].lastSeen > old, `lastSeen ${after.seats[hostSeat].lastSeen}`);
  check("and marks nobody else — presence is per-client evidence",
    after.seats[daveSeat].lastSeen === old,
    `dave ${after.seats[daveSeat].lastSeen} vs ${old}`);
  check("a presence ping does not bump the version",
    after.version === t0.version + 1, `${t0.version + 1} -> ${after.version}`);

  // So the player who never checked in is the one who becomes removable.
  check("the silent player is removable", isBootable(after, daveSeat, Date.now()));
  check("the player who checked in is not", !isBootable(after, hostSeat, Date.now()));
}

// --- away / back through the real routes ----------------------------------
{
  const fresh = await call(createTableRoute, {
    method: "POST", body: { hostName: "H", playerId: "pid-back-host" },
  });
  const bid = fresh.body.table.id;
  await call(joinRoute, { method: "POST", query: { id: bid }, body: { playerId: "pid-back-dave", name: "Dave" } });
  const seat = seatOf(await store.get(bid), "pid-back-dave");

  const away = await call(seatRoute, {
    method: "POST", query: { id: bid }, body: { playerId: "pid-back-dave", action: "away" },
  });
  check("stepping away succeeds", away.status === 200, `got ${away.status}`);
  check("the seat is now AI-covered", (await store.get(bid)).seats[seat]?.kind === "away");

  const back = await call(seatRoute, {
    method: "POST", query: { id: bid }, body: { playerId: "pid-back-dave", action: "back" },
  });
  check("taking the seat back succeeds", back.status === 200, `got ${back.status}`);
  check("control is restored", (await store.get(bid)).seats[seat]?.kind === "human");
  check("the response reports the right seat", back.body?.you === seat);
  assertNoLeak("back", back.body, await store.get(bid), seat, "pid-back-dave", ALL_IDS);

  const stranger = await call(seatRoute, {
    method: "POST", query: { id: bid }, body: { playerId: "pid-not-here", action: "back" },
  });
  check("a stranger cannot take a seat back", stranger.status === 403, `got ${stranger.status}`);

  const twice = await call(seatRoute, {
    method: "POST", query: { id: bid }, body: { playerId: "pid-back-dave", action: "back" },
  });
  check("taking back a seat you already control is harmless", twice.status === 200);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.slice(0, 25).forEach((f) => console.error(`  ${f}`));
  if (failures.length > 25) console.error(`  ...and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("PASS — full table flow works end to end, and no response leaked a card or a playerId.");
