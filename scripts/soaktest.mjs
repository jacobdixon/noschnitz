#!/usr/bin/env node
/* ============================================================================
   Multiplayer soak — five humans, many hands, randomised, through the real
   handlers.

   e2etest proves the happy path once: one human, four AI seats, one hand, a
   fixed sequence of decisions. That is the right shape for a regression test
   and the wrong shape for finding what breaks on a games night. Five people on
   five phones do not take turns politely through a scripted path — they poll
   at random moments, they tap while someone else is tapping, and they play
   hundreds of hands in an evening, any one of which can roll a rule the
   scripted path never reaches.

   So this plays TABLES, not a hand: every seat human, every decision random
   among the legal ones, hands back to back, with the invariants checked after
   every single response rather than at the end.

   What it is actually hunting:

     leaks        the e2e invariant, but across thousands of responses and
                  every phase — including the under card, whose whole point is
                  that only the trick's winner may see it
     legality     the server accepted a play; was it legal by the server's own
                  state, and was it that seat's turn
     termination  every hand reaches handEnd within a bounded number of steps.
                  A table that wedges is the worst outcome on the night: five
                  people staring at a screen that will not advance
     accounting   scores are zero-sum, and carry across hands. Both have been
                  wrong before — `table.scores` was never written once, so
                  every hand re-seeded from zero
     concurrency  two people tapping at the same instant leaves the table in
                  one consistent state, and exactly one of them wins

   Uses the in-memory store, so no credentials and no network.

   Usage: node scripts/soaktest.mjs [tables] [handsPerTable]
   ========================================================================= */
process.env.MULTIPLAYER = "1";
process.env.KV_REST_API_URL ||= "test";
process.env.KV_REST_API_TOKEN ||= "test";

import { call } from "./_mockhttp.mjs";
import { _resetStore } from "../api/_lib/store.js";
import { createMemoryStore } from "../src/store/memory.js";
import { cid, legalPlays, callOptions, trickWinner } from "../src/engine.js";

import createTableRoute from "../api/tables/index.js";
import joinRoute from "../api/tables/[id]/join.js";
import startRoute from "../api/tables/[id]/start.js";
import stateRoute from "../api/tables/[id]/state.js";
import playRoute from "../api/tables/[id]/play.js";
import pickRoute from "../api/tables/[id]/pick.js";
import buryRoute from "../api/tables/[id]/bury.js";

const TABLES = Number(process.argv[2] || 40);
const HANDS = Number(process.argv[3] || 8);

let passed = 0;
let doubleTaps = 0;
// "0 failed" only means something if the rare paths actually ran. A soak that
// never rolled an under call has not tested under, however green it looks.
const cover = { hands: 0, thrownIn: 0, ace: 0, ten: 0, under: 0, alone: 0, underPlayed: 0 };
const failures = [];
const seen = new Set();
// One line per distinct problem. A wedged table produces the same complaint on
// every hand after it, and 300 copies of one bug buries the other two.
const fail = (msg) => {
  const key = msg.slice(0, 120);
  if (seen.has(key)) return;
  seen.add(key);
  failures.push(msg);
};
const check = (label, ok, detail = "") => {
  if (ok) passed++;
  else fail(`${label}${detail ? ` — ${detail}` : ""}`);
};

// Deterministic randomness: a failure prints its seed and can be replayed.
let rngState = 1;
const rnd = () => {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

/* ----------------------------- leak checking ------------------------------ */

function collectCards(node, path = "", out = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectCards(v, `${path}[${i}]`, out));
    return out;
  }
  if (node && typeof node === "object") {
    if (typeof node.rank === "string" && typeof node.suit === "string") {
      out.push({ id: `${node.rank}${node.suit}`, path });
      return out;
    }
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

/**
 * Nothing in `body` may reveal anything `truth` says belongs to someone else.
 *
 * The under card is the subtle one. It sits on the trick as the 6 of the called
 * suit with the real card alongside as `actual`, and `actual` is legitimately
 * visible to three parties and nobody else: the picker, whoever won the trick
 * it fell in, and everyone once the hand is over. So it cannot simply be added
 * to the entitled set, or the test would wave through the exact leak the rule
 * exists to prevent — it has to be entitled per viewer, per trick.
 */
function assertNoLeak(label, body, truth, viewerSeat, viewerPlayerId, allIds) {
  if (!body || !truth) return;
  const g = truth.g;

  if (g) {
    const revealed = g.phase === "handEnd";
    const entitled = new Set();
    const add = (c) => c && entitled.add(cid(c));

    (g.hands[viewerSeat] || []).forEach(add);
    (g.played || []).forEach(add);
    (g.trick || []).forEach((p) => add(p.card));
    (g.lastTrick?.trick || []).forEach((p) => add(p.card));
    (g.trickHistory || []).forEach((h) => (h.trick || []).forEach((p) => add(p.card)));

    const isPicker = viewerSeat === g.picker;
    if (isPicker || revealed) {
      (g.blind || []).forEach(add);
      (g.buried || []).forEach(add);
      add(g.underCard);
    }
    if (revealed) g.hands.forEach((h) => (h || []).forEach(add));

    // The under card's real face, entitled only where the rule allows.
    const maySeeUnder = (winner) => revealed || isPicker || (winner !== null && winner === viewerSeat);
    if (maySeeUnder(null)) (g.trick || []).forEach((p) => add(p.actual));
    (g.trickHistory || []).forEach((h) => {
      if (maySeeUnder(h.winner)) (h.trick || []).forEach((p) => add(p.actual));
    });
    if (g.lastTrick && maySeeUnder(g.lastTrick.winner)) {
      (g.lastTrick.trick || []).forEach((p) => add(p.actual));
    }

    for (const { id, path } of collectCards(body)) {
      if (!entitled.has(id)) {
        fail(`${label}: leaked card ${id} at ${path} (seat ${viewerSeat}, phase ${g.phase})`);
        return;
      }
    }
  }

  const strings = new Set(collectStrings(body));
  for (const pid of allIds) {
    if (pid !== viewerPlayerId && strings.has(pid)) {
      fail(`${label}: leaked another player's playerId (seat ${viewerSeat})`);
      return;
    }
  }
  passed++;
}

/* ------------------------------- one table -------------------------------- */

async function runTable(t) {
  const store = createMemoryStore();
  _resetStore(store);

  const ids = [0, 1, 2, 3, 4].map((i) => `p${t}-${i}-secret`);
  const created = await call(createTableRoute, {
    method: "POST", body: { playerId: ids[0], hostName: "Host" },
  });
  if (created.status !== 201) return fail(`table ${t}: create failed ${created.status}`);
  const id = created.body?.table?.id;

  // Fill every seat with a human. This is the configuration the games night
  // actually runs in, and the one no other suite covers.
  for (let i = 1; i < 5; i++) {
    const j = await call(joinRoute, {
      method: "POST", query: { id }, body: { playerId: ids[i], name: `P${i}` },
    });
    if (j.status !== 200) return fail(`table ${t}: join ${i} failed ${j.status} ${j.body?.error?.code || ""}`);
    assertNoLeak(`t${t} join${i}`, j.body, await store.get(id), i, ids[i], ids);
  }

  const truth0 = await store.get(id);
  const humans = truth0.seats.filter((s) => s.kind === "human").length;
  check(`table ${t}: five human seats`, humans === 5, `got ${humans}`);

  let prevHandNum = -1;

  for (let hand = 0; hand < HANDS; hand++) {
    const started = await call(startRoute, {
      method: "POST", query: { id }, body: { playerId: ids[0] },
    });
    if (started.status !== 200) {
      return fail(`t${t} hand${hand}: start failed ${started.status} ${started.body?.error?.code || ""}`);
    }

    const before = await store.get(id);
    const scoresBefore = [...(before.scores || [0, 0, 0, 0, 0])];
    check(`t${t}: handNum advances`, before.handNum > prevHandNum,
      `${prevHandNum} -> ${before.handNum}`);
    prevHandNum = before.handNum;

    const done = await drivePhases(t, hand, id, store, ids);
    if (!done.ok) return;

    const after = await store.get(id);

    // Scores are zero-sum in sheepshead, and they must CARRY. Both have been
    // wrong before: `table.scores` was once never written at all, so every
    // hand re-seeded from zero and the running total silently reset.
    const scores = after.scores || [0, 0, 0, 0, 0];
    const sum = scores.reduce((a, b) => a + b, 0);
    check(`t${t} hand${hand}: scores are zero-sum`, sum === 0, `sum ${sum} of ${scores}`);
    if (done.thrownIn) {
      check(`t${t} hand${hand}: a thrown-in hand moves no points`,
        scores.every((s, i) => s === scoresBefore[i]), `${scoresBefore} -> ${scores}`);
    }
  }
}

/**
 * Drive one hand to completion, every seat human, choosing randomly among the
 * legal options at each decision.
 */
async function drivePhases(t, hand, id, store, ids) {
  const label = `t${t} hand${hand}`;
  let steps = 0;
  let underSeen = null;

  while (steps++ < 300) {
    const truth = await store.get(id);
    const g = truth.g;
    if (!g) return fail(`${label}: no hand dealt`) || { ok: false };
    if (g.phase === "handEnd") {
      cover.hands++;
      await verifyHandEnd(label, g, store, id, ids, underSeen);
      return { ok: true, thrownIn: false };
    }

    // A thrown-in hand: everyone passed and the table redeals. Not a failure.
    if (g.phase === "picking" && g.passes >= 5) { cover.thrownIn++; return { ok: true, thrownIn: true }; }

    let seat;
    if (g.phase === "picking") seat = g.pickTurn;
    else if (g.phase === "bury" || g.phase === "call" || g.phase === "under") seat = g.picker;
    else seat = g.turn;

    const who = truth.seats[seat];
    if (!who || who.kind !== "human") {
      return fail(`${label}: non-human seat ${seat} to act in ${g.phase}`) || { ok: false };
    }
    const pid = who.playerId;

    // Someone else polls state at a random moment, the way five idle phones do.
    // Every one of those responses is leak-checked too.
    if (rnd() < 0.3) {
      const spy = Math.floor(rnd() * 5);
      const st = await call(stateRoute, { method: "GET", query: { id, playerId: ids[spy] } });
      if (st.status === 200) {
        assertNoLeak(`${label} poll seat${spy}`, st.body, await store.get(id), spy, ids[spy], ids);
      }
    }

    // The invariant the live stream depends on. The browser holds a version
    // and DROPS any frame at or below it (src/useTableStream.js), because
    // presence pings are written deliberately without a bump. So a write that
    // changes the game but leaves the version alone is invisible: the server
    // believes it is your turn, the browser sits inert, and a reload fixes it
    // — which is the intermittent stall that has been reported from live play.
    const verBefore = truth.version;
    const gBefore = JSON.stringify(g);

    let res;
    if (g.phase === "picking") {
      // Pass most of the time so throw-ins and last-seat forced picks both get
      // exercised, rather than seat 0 always picking.
      const action = rnd() < 0.45 ? "pick" : "pass";
      res = await call(pickRoute, {
        method: "POST", query: { id }, body: { playerId: pid, action },
      });
    } else if (g.phase === "bury" || g.phase === "call" || g.phase === "under") {
      const hand6 = [...g.hands[seat]];
      // Bury two at random, then call from whatever that leaves — which is how
      // an under call gets reached at all.
      const i1 = Math.floor(rnd() * hand6.length);
      const c1 = hand6.splice(i1, 1)[0];
      const i2 = Math.floor(rnd() * hand6.length);
      const c2 = hand6.splice(i2, 1)[0];
      const opts = callOptions(hand6, [c1, c2]);
      const opt = opts.length ? pick(opts) : null;
      const body = {
        playerId: pid, cards: [c1, c2],
        calledSuit: opt ? opt.suit : null,
        calledRank: opt ? opt.rank : "A",
      };
      // Under is not a call until a card carries it.
      if (opt && opt.kind === "under") body.underCard = cid(pick(hand6));
      if (!opt) cover.alone++; else cover[opt.kind]++;
      res = await call(buryRoute, { method: "POST", query: { id }, body });
    } else {
      const legal = legalPlays(g, seat);
      check(`${label}: the seat to act has a legal card`, legal.length > 0,
        `seat ${seat} phase ${g.phase}`);
      if (!legal.length) return { ok: false };
      res = await call(playRoute, {
        method: "POST", query: { id }, body: { playerId: pid, card: pick(legal) },
      });
    }

    if (res.status >= 500) {
      return fail(`${label}: ${g.phase} returned ${res.status} — server error`) || { ok: false };
    }
    if (res.status !== 200) {
      return fail(`${label}: ${g.phase} rejected ${res.status} ${res.body?.error?.code || ""}`) || { ok: false };
    }
    const post0 = await store.get(id);
    if (JSON.stringify(post0.g) !== gBefore) {
      check(`${label}: a change to the game bumps the version (${g.phase})`,
        post0.version > verBefore, `version stuck at ${verBefore}`);
    }

    assertNoLeak(`${label} ${g.phase} seat${seat}`, res.body, await store.get(id), seat, pid, ids);

    const post = await store.get(id);
    if (post.g?.calledUnder && post.g.underCard) underSeen = post.g;

    // Two people tapping at once. The loser must be refused cleanly — never a
    // 500, never a second card on the trick.
    if (g.phase === "playing" && rnd() < 0.12) await probeRace(label, id, store, ids);
  }
  return fail(`${label}: hand did not finish in 300 steps — the table wedged`) || { ok: false };
}

/** Fire two conflicting plays at once and insist the table stays coherent. */
async function probeRace(label, id, store, ids) {
  const truth = await store.get(id);
  const g = truth.g;
  if (!g || g.phase !== "playing" || g.turn < 0) return;
  const seat = g.turn;
  const pid = truth.seats[seat]?.playerId;
  if (!pid) return;
  const legal = legalPlays(g, seat);
  if (legal.length < 2) return;

  const trickBefore = g.trick.length;
  const [a, b] = await Promise.all([
    call(playRoute, { method: "POST", query: { id }, body: { playerId: pid, card: legal[0] } }),
    call(playRoute, { method: "POST", query: { id }, body: { playerId: pid, card: legal[1] } }),
  ]);

  const ok = [a, b].filter((r) => r.status === 200).length;
  check(`${label}: neither half of a race 500s`, a.status < 500 && b.status < 500,
    `${a.status}/${b.status}`);

  const after = await store.get(id);
  const tricks = [...(after.g.trickHistory || []).map((h) => h.trick), after.g.trick];
  const mine = tricks.map((tr) => tr.filter((x) => x.player === seat).length);

  // The invariant that actually matters: however the race resolved, this seat
  // never has two cards in one trick.
  check(`${label}: a race never puts two cards from one seat in a trick`,
    mine.every((n) => n <= 1), `${mine}`);

  if (ok === 2) {
    // Both landed. That is legitimate in exactly one shape: the first card
    // completed a trick, this seat won it, and the second card became the lead
    // of the next one. Two turns really did happen. Anything else is a race
    // the CAS loop failed to serialise.
    const spanned = mine.filter((n) => n === 1).length >= 2;
    check(`${label}: a double 200 means the seat genuinely led the next trick`,
      spanned && trickBefore + 1 === 5, `trickBefore ${trickBefore}, mine ${mine}`);
    doubleTaps++;
  } else {
    check(`${label}: otherwise a double tap plays exactly one card`, ok === 1,
      `${a.status}/${b.status}`);
  }

  // The realistic phone input: the same card tapped twice in a row. The second
  // must be refused cleanly — the card is gone from the hand by then.
  if (after.g.phase === "playing" && after.g.turn >= 0) {
    const s2 = after.g.turn;
    const pid2 = after.seats[s2]?.playerId;
    const legal2 = legalPlays(after.g, s2);
    if (pid2 && legal2.length) {
      const card = legal2[0];
      const [c, d] = await Promise.all([
        call(playRoute, { method: "POST", query: { id }, body: { playerId: pid2, card } }),
        call(playRoute, { method: "POST", query: { id }, body: { playerId: pid2, card } }),
      ]);
      const ok2 = [c, d].filter((r) => r.status === 200).length;
      check(`${label}: the same card tapped twice plays once`, ok2 === 1, `${c.status}/${d.status}`);
      check(`${label}: the refused duplicate does not 500`, c.status < 500 && d.status < 500,
        `${c.status}/${d.status}`);
      const post = await store.get(id);
      const inTrick = post.g.trick.filter((x) => x.player === s2).length;
      check(`${label}: a duplicate tap leaves one card on the trick`, inTrick <= 1, `${inTrick}`);
    }
  }
}

/** End-of-hand accounting, plus the under card's reveal. */
async function verifyHandEnd(label, g, store, id, ids, underSeen) {
  const played = (g.trickHistory || []).flatMap((h) => h.trick);
  check(`${label}: every card was played`, played.length === 30, `${played.length}`);

  const winners = (g.trickHistory || []).map((h) => h.winner);
  check(`${label}: every trick has a winner`,
    winners.every((w) => typeof w === "number" && w >= 0 && w < 5), `${winners}`);
  for (const h of g.trickHistory || []) {
    check(`${label}: the recorded winner is the real winner`,
      trickWinner(h.trick) === h.winner, `${trickWinner(h.trick)} vs ${h.winner}`);
  }

  if (underSeen) {
    cover.underPlayed++;
    const unders = played.filter((p) => p.under);
    check(`${label}: an under call plays exactly one card under`, unders.length === 1,
      `${unders.length}`);
    if (unders.length === 1) {
      check(`${label}: the under card is the picker's`, unders[0].player === g.picker);
      check(`${label}: it went down as the called suit`,
        unders[0].card.suit === g.calledSuit && unders[0].card.rank === "6",
        JSON.stringify(unders[0].card));
    }
    // And at hand end everyone may finally see it.
    const st = await call(stateRoute, { method: "GET", query: { id, playerId: ids[4] } });
    if (st.status === 200) {
      const body = JSON.stringify(st.body);
      check(`${label}: the under card is revealed in the recap`, body.includes('"actual"'));
    }
  }
}

/* --------------------------------- run ------------------------------------ */

for (let t = 0; t < TABLES; t++) {
  rngState = t * 7919 + 1;
  await runTable(t);
}

console.log(`${passed} passed, ${failures.length} failed  (${TABLES} tables x up to ${HANDS} hands, five humans)`);
if (doubleTaps) console.log(`  (${doubleTaps} races where the seat legitimately led the next trick)`);
console.log(`  coverage: ${cover.hands} hands played out, ${cover.thrownIn} thrown in · calls: ` +
  `${cover.ace} ace, ${cover.ten} ten, ${cover.under} under, ${cover.alone} alone · ` +
  `${cover.underPlayed} hands reached the end with an under card down`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.slice(0, 25).forEach((f) => console.error(`  ${f}`));
  if (failures.length > 25) console.error(`  ...and ${failures.length - 25} more`);
  process.exit(1);
}
console.log("PASS — five-human tables play hands back to back without leaking, wedging, or miscounting.");
