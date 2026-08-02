/* ============================================================================
   Server-side AI driver — the multiplayer port of the solo `engine loop`.

   In the solo game (Sheepshead.jsx) the AI is driven by a useEffect that fires
   one setTimeout per AI action: pick-or-pass, take the blind + bury + call,
   play a card, resolve a finished trick. That works when the only human is
   seat 0 and the browser owns the game state. It can't survive the move to a
   shared table: five clients would each run their own timers against their own
   copy of `g` and disagree about what the AI did.

   So the loop moves here, and changes shape. Instead of "one action per tick",
   `advanceAI` runs the AI forward as far as it legally can in a single pure
   step and stops the instant a human has to act. The caller (a serverless
   handler) wraps it in the same compare-and-swap the rest of table.js uses, so
   the entire burst lands atomically or not at all.

   Three properties this file exists to guarantee:

     1. It never plays a human's card. The stop condition is checked before
        every single action, not after, so there is no window where a human
        seat gets driven "just one more step".
     2. It bumps `version` exactly once for the whole burst. The CAS guard is
        a single-increment protocol — a caller that read version N writes N+1.
        Bumping per AI action would make every advance look like a lost race
        to every other client.
     3. It is pure and clock-free. `now` is passed in, never read, so the same
        (table, now) always produces the same result and the function can be
        replayed or tested headlessly.

   The one thing here that isn't in the solo loop is `aiLog`. Locally the
   staggered timers ARE the animation: you see Gus play, then Bunny, then
   Duane. Collapsing four AI turns into one atomic write destroys that — the
   client polls and four cards appear at once. The log records the order the
   AI acted in so the client can replay the burst at human speed instead of
   snapping to the end state.
   ========================================================================= */
import {
  handStrength, aiBuryAndCall, aiChooseCard, assignPartner, applyPlay,
  resolveTrick, sortHand, isUnderCard, underFace,
} from "./engine.js";
import { commit, startHand, atHandBoundary, coverIdleSeats } from "./table.js";

// Ceiling on actions per advance. A whole hand is bounded well under this:
// 5 pick decisions + 30 card plays + 6 trick resolutions = 41. The cap is not
// a tuning knob, it's a guarantee that a state this file doesn't understand
// (a future phase, a corrupted `g`) can never spin a serverless function until
// it's killed. If it ever trips, we return the progress made so far and the
// next advance picks up where this one stopped.
export const MAX_STEPS = 200;

// Pick thresholds, lifted verbatim from the solo engine loop so multiplayer AI
// play is indistinguishable from single-player AI play. Deliberately named
// rather than inlined: they're a balance decision, and the two copies must
// stay in step.
export const PICK_STRENGTH = 10;
// In the forced-pick seat (four passes already, you're last) the AI stretches
// down to 8 rather than throwing the hand in.
const LAST_SEAT_PICK_STRENGTH = 8;

// "away" counts as AI-driven: the seat still belongs to an absent player, but
// the AI plays it so the table doesn't stall waiting on someone whose phone
// locked (COM-3.4). Only a seat whose player is actually present blocks play.
const isAISeat = (table, i) => table.seats[i]?.kind !== "human";

// The solo loop can hardcode "is it seat 0's turn?" because seat 0 is the only
// human. Here the mix is arbitrary — 1 human + 4 AI through 5 humans + 0 AI —
// so every stop condition routes through the seat roster instead.
function aiWantsToPick(g, idx) {
  const strength = handStrength(g.hands[idx]);
  return strength >= PICK_STRENGTH || (g.passes === 4 && strength >= LAST_SEAT_PICK_STRENGTH);
}

// An AI picker resolves the whole pick in one move: take the blind, bury two,
// call an ace (or go alone), and start play. There's no intermediate state to
// expose the way there is for a human picker, who gets "bury" and "call"
// phases to click through.
function aiTakeBlind(g, idx) {
  const eight = [...g.hands[idx], ...g.blind];
  const { buried, call, callRank, callKind, underCard, hand } = aiBuryAndCall(eight);
  const hands = g.hands.map((h, i) => (i === idx ? sortHand(hand) : h));
  return assignPartner({
    ...g,
    picker: idx,
    hands,
    buried,
    calledSuit: call,
    calledRank: call === null ? null : callRank,
    calledUnder: callKind === "under",
    underCard: underCard ?? null,
    phase: "playing",
    trick: [],
    turn: g.leader,
    message: null,
  });
}

/* ------------------------------------------------------------------------ */

/**
 * Drive every AI seat forward until a human has to act, the hand ends, or the
 * hand is thrown in. Pure: returns a NEW table, or the SAME table reference if
 * there was nothing for the AI to do (so the caller can skip the write).
 *
 * @param {object} table  a table with `g` populated (see table.js)
 * @param {number} now    caller-supplied timestamp; this function never reads a clock
 * @returns {object} the advanced table, or `table` itself when it's a no-op
 */
export function advanceAI(table, now) {
  if (!table || !table.g) return table;

  let g = table.g;

  // The log is per-hand. Carrying it across hands would grow it without bound
  // over a long session and, worse, make the client replay last hand's cards.
  // `aiLogHand` is what makes "is this log stale?" answerable without keeping
  // a parallel timestamp — a hand number that doesn't match the hand in play
  // means the log belongs to a hand nobody is looking at any more.
  const logIsCurrent = table.aiLogHand === g.handNum && Array.isArray(table.aiLog);
  const priorLog = logIsCurrent ? table.aiLog : [];
  // seq is monotonic within a hand and survives across separate advances, so a
  // client that saw up to seq N can ask for "everything after N" and get the
  // plays in the order they happened even when they arrived in two bursts.
  let seq = priorLog.length ? priorLog[priorLog.length - 1].seq : 0;
  const entries = [];

  let changed = false;
  let steps = 0;

  while (steps < MAX_STEPS) {
    steps++;

    // Terminal: the hand is scored. Dealing the next one is the caller's
    // decision (it's a table-level action, and it's where pending joins land).
    if (g.phase === "handEnd") break;

    if (g.phase === "picking") {
      // Terminal: everyone passed. The solo loop redeals on a timer here; on a
      // shared table the redeal is the caller's call, for the same reason as
      // handEnd — the next hand may seat players who are currently queued.
      if (g.passes >= 5) break;

      const idx = g.pickTurn;
      // Stop condition #1: a human owes us a pick/pass decision.
      if (!isAISeat(table, idx)) break;

      if (aiWantsToPick(g, idx)) {
        g = aiTakeBlind(g, idx);
      } else {
        const passes = g.passes + 1;
        g = {
          ...g,
          passes,
          pickTurn: (idx + 1) % 5,
          message: passes === 5 ? "Everyone passed — throwing it in." : null,
        };
      }
      changed = true;
      continue;
    }

    if (g.phase === "playing") {
      // A finished trick belongs to nobody: `turn` is -1 and no seat, human or
      // AI, can act until it's resolved. Resolving it here (rather than making
      // it a human's job) is what keeps a 5-human table from deadlocking on a
      // completed trick.
      if (g.trick.length === 5) {
        g = resolveTrick(g);
        changed = true;
        continue;
      }

      const idx = g.turn;
      // -1 means "awaiting trick resolution", already handled above; anything
      // else out of range is a state we don't understand, so stop rather than
      // guess.
      if (idx < 0 || idx > 4) break;
      // Stop condition #2, the important one: it's a human's card to play.
      // Checked before choosing a card, so we never even compute a play for a
      // seat we aren't allowed to move.
      if (!isAISeat(table, idx)) break;

      const card = aiChooseCard(g, idx);
      // The face the table shows — for an under card the 6 of the called suit,
      // not the card the picker actually laid. The log ships to every client
      // with the rest of the table state and `viewFor` does not redact it, so
      // recording the physical card published the picker's under card to the
      // whole table the moment she played it: precisely what the under rule
      // exists to hide. Nothing is lost by logging the face. The log's job is
      // to replay a burst of AI plays at human speed, and what a client draws
      // is what is on the table; the real card still travels on the trick as
      // `actual`, which `viewFor` releases only to the picker, to whoever won
      // that trick, and to everyone once the hand is over.
      const face = isUnderCard(g, idx, card) ? underFace(g) : card;
      g = applyPlay(g, idx, card);
      seq++;
      // Copied rather than referenced: the log outlives the hand state it came
      // from and gets serialized to the store on its own.
      entries.push({ seq, seat: idx, card: { suit: face.suit, rank: face.rank }, at: now });
      changed = true;
      continue;
    }

    // "bury" and "call" are human-picker-only phases (an AI picker never
    // enters them — aiTakeBlind does the whole thing in one move), and "lobby"
    // has no game to advance. Either way there's nothing for the AI to do.
    break;
  }

  // Nothing happened — most often because it was a human's turn the moment we
  // were called. Returning the identical reference lets the caller skip a
  // pointless CAS write, which on a polled table is the common case by far.
  if (!changed) return table;

  return commit(
    { ...table, g, aiLog: [...priorLog, ...entries], aiLogHand: g.handNum },
    now
  );
}

/* ------------------------------------------------------------------------ */

// Redeals a table that has been thrown in, up to this many times in one
// request. All five passing twice running is unlikely but not impossible, and
// an unbounded loop here would spin a serverless invocation until it timed out.
export const MAX_REDEALS = 4;

/**
 * advanceAI plus the one thing it deliberately refuses to do: redeal a hand
 * that everybody passed on.
 *
 * The split exists because a redeal is a table-level decision — it bumps the
 * hand number, rotates the dealer, and seats anyone queued — none of which
 * belongs in a function whose job is "move the AI seats". But nothing was
 * picking that decision up, so a thrown-in hand deadlocked the table
 * permanently. This is the seam where the two meet, and every route that
 * advances play goes through it rather than calling advanceAI directly.
 *
 * Pure, like everything it calls: returns a new table, or the same reference
 * when there was nothing to do.
 *
 * @param {object} table
 * @param {number} now  caller-supplied timestamp; never reads a clock
 */
export function advanceTable(table, now) {
  // Cover anyone who has gone quiet BEFORE trying to advance, so a table
  // blocked on an absent player un-sticks itself rather than sitting on a turn
  // that will never be taken (COM-3.4).
  let t = advanceAI(coverIdleSeats(table, now), now);

  for (let i = 0; i < MAX_REDEALS; i++) {
    const g = t.g;
    const thrownIn = g && g.phase === "picking" && g.passes >= 5;
    if (!thrownIn) break;
    // startHand applies pending joins first, so a player who was queued while
    // the dead hand was being passed around gets seated in the redeal rather
    // than waiting for a hand that will never be played.
    if (!atHandBoundary(t)) break;
    t = startHand(t, now);
    t = advanceAI(t, now);
  }

  return t;
}
