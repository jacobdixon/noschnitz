/* ============================================================================
   Full-hand double-dummy solver.

   `engine.js` already solves the last two tricks exactly (`solveEndgameCard`).
   That was cheap because the tree is tiny there. This solves the *whole* hand
   the same way — every seat playing optimally with all five hands visible —
   which is what "double dummy" means and what the play brief used to put a
   number on each decision.

   Why it's needed: the grader in `engine.js` values a candidate card by rolling
   the hand forward with `aiChooseCard` for every remaining decision. That makes
   it a measure of the AI *against itself*, so a systematic bias in the policy is
   invisible to it — the rollout commits the same error in every branch and the
   comparison cancels it out. Six hand-reconstructed deals found defects that
   200,000 simulated hands had not, purely because a human solved the
   alternatives instead. This module removes the human from that loop.

   What it is NOT: double dummy gives every seat perfect knowledge and perfect
   coordination, so it is an upper bound on what a real player could achieve and
   it flatters the defenders most (four seats coordinating). It is also ex post
   — a decision that was right given what a seat knew but wrong given the actual
   layout scores as an error. Read the output as "where are the points", not as
   "the AI should have known".

   The objective is picker-team card points, matching both `endgameValue` and
   the brief. It is deliberately not the scored outcome: card points decompose
   across tricks, which is what makes the transposition table sound, whereas the
   61/91/120 thresholds depend on the running total and would have to be carried
   in the key. `gradeHandExact` converts to game points afterwards, at the root,
   where the running total is known.

   The rules are never reimplemented here. Legality, play and trick resolution
   all go through `engine.js`, so there is exactly one definition of the game.
   ========================================================================= */
import {
  legalPlays, applyPlay, resolveTrick, trickWinner, pickerTeamOf, sortHand,
  cid, cardPts, power, effSuit,
} from "./engine.js";

/* ----------------------------- Card indexes ------------------------------ */

// Card identity, power and effective suit are pure functions of the card, so
// index them once rather than recomputing inside the hot loop. `BIT_BY_CID`
// also gives the transposition key a 5-integer hand signature instead of a
// 30-character string, which is most of what the table costs.
const BIT_BY_CID = new Map();
const POWER_BY_CID = new Map();
const SUIT_BY_CID = new Map();
{
  let bit = 0;
  for (const suit of ["C", "S", "H", "D"]) {
    for (const rank of ["7", "8", "9", "K", "10", "A", "J", "Q"]) {
      const c = { rank, suit };
      BIT_BY_CID.set(cid(c), 1 << bit++);
      POWER_BY_CID.set(cid(c), power(c));
      SUIT_BY_CID.set(cid(c), effSuit(c));
    }
  }
}

// For each effective suit, the cards of that suit as (bit, power) pairs sorted
// high to low. Lets the equivalence test ask "is anything outstanding strictly
// between these two" with a couple of integer comparisons.
const SUIT_LADDER = new Map();
for (const [c, suit] of SUIT_BY_CID) {
  if (!SUIT_LADDER.has(suit)) SUIT_LADDER.set(suit, []);
  SUIT_LADDER.get(suit).push({ bit: BIT_BY_CID.get(c), power: POWER_BY_CID.get(c) });
}
for (const ladder of SUIT_LADDER.values()) ladder.sort((a, b) => b.power - a.power);

/* ------------------------------ Search state ----------------------------- */

// Everything that varies inside one solved hand and can change either the value
// or what is legal. The hand context that stays fixed for the whole search —
// picker, partner, called suit, burial — is deliberately absent: it is constant
// per solve, so including it would only make every key longer.
//
// Hands are joined without sorting because `applyPlay` filters rather than
// rebuilds, so a hand sorted at the root stays sorted at every node below it.
// `solve` sorts once on entry to make that true.
function ttKey(g) {
  let s = "";
  for (let p = 0; p < 5; p++) s += `${handMask(g.hands[p])},`;
  for (const t of g.trick) s += `${t.player}.${BIT_BY_CID.get(cid(t.card))}.`;
  return `${s}|${g.turn}${g.calledAcePlayed ? 1 : 0}${g.calledSuitLed ? 1 : 0}`;
}

// `applyPlay` rebuilds only the hand that played and returns the other four
// arrays by reference, so keying this cache on the array identity hits four
// times out of five. Rebuilding all five masks per node was the single largest
// cost in the search.
const MASK_CACHE = new WeakMap();
function handMask(hand) {
  const hit = MASK_CACHE.get(hand);
  if (hit !== undefined) return hit;
  let m = 0;
  for (const c of hand) m |= BIT_BY_CID.get(cid(c));
  MASK_CACHE.set(hand, m);
  return m;
}

/* --------------------------- Equivalent moves ---------------------------- */

// Two cards in one hand are interchangeable when nothing another seat could
// still play falls between them AND they are worth the same points. Both halves
// matter: in most trick-taking games only rank matters, but here A-diamonds and
// 10-diamonds are adjacent in the trump order and worth 11 and 10, so
// collapsing them by rank alone would silently change the value of the hand.
//
// This is the single largest reduction in the search. A hand holding 9-8-7 of
// diamonds has one move there, not three.
function dedupeEquivalent(g, idx, legal) {
  if (legal.length < 2) return legal;

  // Perfect information: "could still be played by someone else" is exactly
  // "is in another seat's hand".
  let elsewhere = 0;
  for (let p = 0; p < 5; p++) {
    if (p !== idx) elsewhere |= handMask(g.hands[p]);
  }

  // Group by effective suit — cards in different fail suits never compare.
  const bySuit = new Map();
  for (const c of legal) {
    const k = effSuit(c);
    if (!bySuit.has(k)) bySuit.set(k, []);
    bySuit.get(k).push(c);
  }

  const out = [];
  for (const [suit, group] of bySuit) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const ladder = SUIT_LADDER.get(suit);
    const ranked = [...group].sort((a, b) => power(b) - power(a));
    let keptHigh = ranked[0];
    out.push(keptHigh);
    for (let i = 1; i < ranked.length; i++) {
      const c = ranked[i];
      const lo = power(c), hi = power(keptHigh);
      let blocked = false;
      for (const rung of ladder) {
        if (rung.power <= lo) break;
        if (rung.power < hi && (elsewhere & rung.bit) !== 0) { blocked = true; break; }
      }
      // Both halves are required: same points AND nothing in between. Rank
      // equivalence alone would merge A-diamonds with 10-diamonds, which are
      // adjacent in the trump order and worth 11 and 10.
      if (!blocked && cardPts(c) === cardPts(keptHigh)) continue;
      out.push(c);
      keptHigh = c;
    }
  }
  return out;
}

/* -------------------------------- Search --------------------------------- */

// Value is picker-team points taken from this node onward, NOT the hand total.
// Making it incremental is what lets one transposition entry serve every path
// that reaches the same position with a different running score — without it
// the table would barely hit at all.
function search(g, alpha, beta, ctx) {
  if (g.tricksDone >= 6) return 0;

  if (g.trick.length === 5) {
    const w = trickWinner(g.trick);
    const pts = g.trick.reduce((s, t) => s + cardPts(t.card), 0);
    const gain = ctx.pickerTeam.includes(w) ? pts : 0;
    ctx.nodes++;
    return gain + search(resolveTrick(g), alpha - gain, beta - gain, ctx);
  }

  const key = ttKey(g);
  const hit = ctx.tt.get(key);
  if (hit !== undefined) {
    if (hit.flag === 0) return hit.value;
    if (hit.flag === 1 && hit.value >= beta) return hit.value;   // lower bound
    if (hit.flag === 2 && hit.value <= alpha) return hit.value;  // upper bound
  }

  const idx = g.turn;
  const maximizing = ctx.pickerTeam.includes(idx);
  const legal = legalPlays(g, idx);
  let moves = orderMoves(g, idx, ctx.dedupe ? dedupeEquivalent(g, idx, legal) : legal);

  // A stored entry that couldn't be used for its value is still worth its move:
  // whatever was best here last time is the most likely thing to cause a cutoff
  // now, and trying it first is free.
  if (hit !== undefined && hit.move && moves.length > 1) {
    const i = moves.findIndex((c) => cid(c) === hit.move);
    if (i > 0) moves = [moves[i], ...moves.slice(0, i), ...moves.slice(i + 1)];
  }

  const alpha0 = alpha, beta0 = beta;
  let best = maximizing ? -1 : 1e6;
  let bestMove = null;
  for (const card of moves) {
    ctx.nodes++;
    const val = search(applyPlay(g, idx, card), alpha, beta, ctx);
    if (maximizing) {
      if (val > best) { best = val; bestMove = card; }
      if (best > alpha) alpha = best;
    } else {
      if (val < best) { best = val; bestMove = card; }
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
  }

  const flag = best <= alpha0 ? 2 : best >= beta0 ? 1 : 0;
  ctx.tt.set(key, { value: best, flag, move: bestMove ? cid(bestMove) : null });
  return best;
}

// Ordering only affects speed, never the result. Trying the cards most likely
// to be best first is what makes the alpha-beta cutoffs happen early: the side
// that wants the trick tries to take it with its strongest card, the side that
// does not tries to get out cheapest.
function orderMoves(g, idx, moves) {
  if (moves.length < 2) return moves;
  if (!g.trick.length) return [...moves].sort((a, b) => power(b) - power(a));
  const wins = (c) => trickWinner([...g.trick, { player: idx, card: c }]) === idx;
  return [...moves].sort((a, b) => {
    const d = (wins(b) ? 1 : 0) - (wins(a) ? 1 : 0);
    return d || power(b) - power(a);
  });
}

/* ------------------------------ Public API ------------------------------- */

// Picker-team card points from `g` to the end of the hand, under optimal play by
// both sides. Add the points already taken plus the burial to get the hand total.
export function solveValue(g, ctx = newContext(g)) {
  const root = { ...g, hands: g.hands.map(sortHand) };
  return search(root, -1, 1e6, ctx);
}

// `dedupe` is switchable only so the tests can assert that collapsing
// equivalent moves is a pure speedup — same value, fewer nodes. It is the one
// part of the search that could silently change an answer, so it is checked
// rather than trusted.
export function newContext(g, { dedupe = true } = {}) {
  return { tt: new Map(), nodes: 0, pickerTeam: pickerTeamOf(g), dedupe };
}

// Every legal card at this decision with its exact value, sharing one
// transposition table. Sharing matters: the alternatives transpose into each
// other's subtrees constantly, so the second and later cards cost a fraction of
// the first.
export function solveRootValues(g, idx, ctx = newContext(g)) {
  const root = { ...g, hands: g.hands.map(sortHand) };
  return legalPlays(root, idx).map((card) => ({
    card,
    value: search(applyPlay(root, idx, card), -1, 1e6, ctx),
  }));
}

/* ------------------------- Solver-backed grading ------------------------- */

// Replays a finished hand and solves every real decision exactly: each legal
// alternative gets the value it would have had with optimal play by all five
// seats afterwards. This is the same method the play brief applied by hand to
// six deals, run automatically.
//
// The difference from `gradeHandPlays` in engine.js is the yardstick, and it is
// the whole point. That one values an alternative by playing `aiChooseCard`
// forward, so it can only ever find places where the AI disagrees with itself —
// a bias present in every branch cancels out and reads as zero cost. This one
// compares against optimal play, so a systematic error shows up at full size.
//
// One transposition table is shared across the entire hand. Later decisions sit
// inside the trees the earlier ones already searched, so grading a whole hand
// costs far less than solving each decision from scratch.
// `fromTrick` skips grading (but still replays) the decisions before a given
// trick. Cost is dominated almost entirely by the early ones — a trick-1
// decision searches the whole hand, a trick-3 decision a small fraction of it —
// so this is the difference between hundreds of hands and thousands. Anything
// it skips is simply absent from the output rather than counted as clean.
export function gradeHandExact(g, { fromTrick = 0 } = {}) {
  if (!g.trickHistory || g.trickHistory.length < 6) return null;

  const startingHands = [[], [], [], [], []];
  for (const th of g.trickHistory) for (const p of th.trick) startingHands[p.player].push(p.card);

  let sim = {
    ...g,
    phase: "playing",
    hands: startingHands.map(sortHand),
    played: [], trick: [], tricksDone: 0,
    trickCounts: [0, 0, 0, 0, 0], ptsTaken: [0, 0, 0, 0, 0],
    calledAcePlayed: false, calledSuitLed: false, partnerRevealed: false,
    trickHistory: [], lastTrick: null,
    leader: g.trickHistory[0].trick[0].player,
    turn: g.trickHistory[0].trick[0].player,
  };

  const ctx = newContext(sim);
  const pickerTeam = pickerTeamOf(sim);
  const buriedPts = sim.buried.reduce((s, c) => s + cardPts(c), 0);
  const decisions = [];

  for (const th of g.trickHistory) {
    for (const play of th.trick) {
      const idx = play.player;
      const legal = legalPlays(sim, idx);
      if (legal.length > 1 && sim.tricksDone >= fromTrick) {
        const onPickerTeam = pickerTeam.includes(idx);
        // Points this seat's side has already banked, so a solved remainder can
        // be turned back into a hand total and scored.
        const banked = pickerTeam.reduce((s, p) => s + sim.ptsTaken[p], 0) + buriedPts;
        const vals = solveRootValues(sim, idx, ctx).map((v) => ({
          ...v,
          total: banked + v.value,
        }));

        // "Best" is always from the mover's own side's point of view.
        const totals = vals.map((v) => v.total);
        const bestTotal = onPickerTeam ? Math.max(...totals) : Math.min(...totals);
        const actual = vals.find((v) => cid(v.card) === cid(play.card));
        const best = vals.find((v) => v.total === bestTotal);
        const cost = onPickerTeam ? bestTotal - actual.total : actual.total - bestTotal;

        decisions.push({
          trick: sim.tricksDone,
          player: idx,
          role: idx === g.picker ? "picker" : idx === g.partner ? "partner" : "defender",
          onPickerTeam,
          card: cid(play.card),
          bestCard: cid(best.card),
          legalCount: legal.length,
          cost,
          // Did the choice change who won the hand? Derived from the exact
          // totals rather than from card points, because a 2-point leak across
          // 61 costs the whole hand and a 15-point leak in a blowout costs
          // nothing. No-tricker is not captured here — it needs trick counts,
          // which a points-valued solve doesn't carry.
          flipped: (actual.total >= 61) !== (bestTotal >= 61),
          swing: Math.max(...totals) - Math.min(...totals),
          // The three shapes the brief bucketed errors by. "concede" is the one
          // that turned out to hold most of them: a decision where no legal
          // card takes the trick, so the only question is what to throw.
          kind: sim.trick.length === 0
            ? "lead"
            : legal.some((c) => trickWinner([...sim.trick, { player: idx, card: c }]) === idx)
              ? "win-option"
              : "concede",
        });
      }
      sim = applyPlay(sim, idx, play.card);
    }
    sim = resolveTrick(sim);
  }

  return { decisions, nodes: ctx.nodes, result: g.result };
}

// Convenience for callers that just want the headline pair, matching the shape
// `gradeHandPlays` returns so a UI can swap one for the other.
export function bestAndWorst(graded) {
  if (!graded) return { best: null, worst: null };
  let worst = null, best = null;
  for (const d of graded.decisions) {
    if (d.cost > 0 && (!worst || d.cost > worst.cost)) worst = d;
    if (d.cost === 0 && d.swing > 0 && (!best || d.swing > best.swing)) best = d;
  }
  return { best, worst };
}
