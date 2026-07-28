#!/usr/bin/env node
/* ============================================================================
   What the picker may call.

   Three tiers, in order:

     ace     a fail suit you hold a card in and whose ace you lack
     under   if that leaves nothing: an ace you lack in a suit you are VOID in.
             You can never lead or follow it, which is the cost.
     ten     if you hold all three fail aces there is no ace to call, so the
             ten names your partner instead.

   Going alone remains whatever is left when none of those produce an option.

   The rule lives in engine.callOptions() and every consumer reads it from
   there — the solo game, the table screen, the AI, and the bury endpoint that
   is the actual authority. It had been transcribed five times.

   Usage: node scripts/calltest.mjs
   ========================================================================= */
import { callOptions, assignPartner, legalPlays, applyPlay, cid, isTrump, trickWinner, cardPts } from "../src/engine.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};
const C = (s) => ({ rank: s.slice(0, -1), suit: s.slice(-1) });
const H = (a) => a.map(C);
const show = (o) => o.map((x) => `${x.kind}:${x.rank}${x.suit}`).join(" ");

/* --------------------------------- ordinary ------------------------------- */
{
  const o = callOptions(H(["KC", "9S", "8H", "QC", "JD", "AD"]));
  check("every suit you hold a card in is callable", o.length === 3, show(o));
  check("...all as ace calls", o.every((x) => x.kind === "ace" && x.rank === "A"), show(o));

  // Holding the ace removes its suit; so does burying it.
  const held = callOptions(H(["AC", "9C", "9S", "8H", "JD", "AD"]));
  check("a suit whose ace you hold is not callable", !held.some((x) => x.suit === "C"), show(held));
  const buried = callOptions(H(["9C", "9S", "8H", "QC", "JD", "AD"]), H(["AC", "7C"]));
  check("burying the ace does not make it callable", !buried.some((x) => x.suit === "C"), show(buried));
}

/* ----------------------------------- under -------------------------------- */
{
  // Void in spades and hearts, holding the club ace: there is no fail card to
  // call with, so the two suits you are void in become under calls.
  const voidHand = callOptions(H(["AC", "9C", "QC", "QS", "JD", "AD"]));
  check("void suits become under calls", voidHand.length === 2, show(voidHand));
  check("...and only the suits you are actually void in",
    voidHand.every((x) => x.kind === "under") &&
    voidHand.map((x) => x.suit).sort().join("") === "HS", show(voidHand));

  const trumpOnly = callOptions(H(["QC", "QS", "QH", "QD", "JC", "JS"]));
  check("pure trump can call any of the three under", trumpOnly.length === 3, show(trumpOnly));

  // The loophole, and the reason eligibility counts all eight cards: measured
  // against the six you kept, burying your last club manufactures a club-under.
  const dumped = callOptions(H(["AC", "9C", "QC", "QS", "JD", "AD"]), H(["7S", "8S"]));
  check("burying your last spade does not manufacture an under",
    !dumped.some((x) => x.suit === "S"), show(dumped));

  // A suit whose ace is in your own hand is never callable, under included.
  check("you cannot call under in a suit you hold the ace of",
    !voidHand.some((x) => x.suit === "C"), show(voidHand));
}

/* ------------------------------------ ten --------------------------------- */
{
  const o = callOptions(H(["AC", "AS", "AH", "QC", "JD", "AD"]));
  check("holding all three fail aces calls a ten", o.length === 3, show(o));
  check("...as ten calls", o.every((x) => x.kind === "ten" && x.rank === "10"), show(o));

  // A ten you hold is not callable either.
  const holdsTen = callOptions(H(["AC", "AS", "AH", "10C", "JD", "AD"]));
  check("a ten you hold is not callable", !holdsTen.some((x) => x.suit === "C"), show(holdsTen));
  check("...but the others still are", holdsTen.length === 2, show(holdsTen));
}

/* ---------------------------------- alone --------------------------------- */
{
  // All three aces AND all three tens: nothing left to name a partner with.
  const o = callOptions(H(["AC", "AS", "AH", "10C", "10S", "10H"]));
  check("all aces and all tens leaves you alone", o.length === 0, show(o));

  // Every ace and every ten, so nothing names a partner and under has no suit
  // left to call either — this is the only real "alone".
  const noUnder = callOptions(H(["AC", "AS", "AH", "10C", "10S", "10H"]));
  check("holding every ace leaves no suit to call under", noUnder.length === 0, show(noUnder));
}

/* ----------------------- the called card names the partner ---------------- */
{
  // A ten call must find the holder of the TEN, not of the ace.
  const g = {
    picker: 0, calledSuit: "S", calledRank: "10", partner: null,
    hands: [H(["AC","AS","AH"]), H(["9C"]), H(["10S"]), H(["KH"]), H(["7C"])],
  };
  const withTen = assignPartner(g);
  check("a ten call partners whoever holds the ten", withTen.partner === 2, `got ${withTen.partner}`);
  check("...and is not alone", withTen.alone === false);

  // The same layout called as an ace finds nobody — seat 0 holds every ace.
  const asAce = assignPartner({ ...g, calledRank: "A" });
  check("the same hand called as an ace finds no partner", asAce.partner === null);

  // Missing calledRank still means the ace, so old states keep working.
  const legacy = assignPartner({
    picker: 0, calledSuit: "H", partner: null,
    hands: [H(["9H"]), H(["AH"]), H(["9C"]), H(["KH"]), H(["7C"])],
  });
  check("a state with no calledRank still means the ace", legacy.partner === 1, `got ${legacy.partner}`);
}

/* ------------- the partner must play the called card, ace or ten ----------- */
{
  // Spades led, partner holds the called TEN and a spare spade: only the ten
  // is legal, exactly as the ace would be.
  const g = {
    picker: 0, partner: 2, calledSuit: "S", calledRank: "10",
    partnerRevealed: false, calledAcePlayed: false, calledSuitLed: false, tricksDone: 0,
    trick: [{ player: 0, card: C("9S") }],
    hands: [H(["QC"]), H(["QS"]), H(["10S", "8S", "QH"]), H(["KH"]), H(["7C"])],
  };
  const legal = legalPlays(g, 2);
  check("the called ten must be played when its suit is led",
    legal.length === 1 && cid(legal[0]) === "10S", legal.map(cid).join(" "));

  // And playing it reveals the partner.
  const after = applyPlay(g, 2, C("10S"));
  check("playing the called ten reveals the partner", after.partnerRevealed === true);
  check("...and marks the called card as played", after.calledAcePlayed === true);

  // The ace of that suit is NOT the called card here, so it does not reveal.
  const aceInstead = applyPlay({ ...g, hands: g.hands.map((h,i) => i===2 ? H(["AS","8S"]) : h) }, 2, C("AS"));
  check("the ace does not reveal when the ten was called",
    aceInstead.partnerRevealed === false && aceInstead.calledAcePlayed === false);
}

/* ------------------------- under: the picker is void ---------------------- */
{
  // Called hearts under, designating Q♣ — the top trump in the deck. Holding no
  // hearts is exactly why the card was designated; it now IS the picker's
  // hearts, and hearts led drags it out.
  //
  // This is the bug that reached real play, inverted: the shipped version let
  // the picker trump their own called suit, which is strictly better than
  // playing the hand straight and made the call free.
  const g = {
    picker: 0, partner: 3, calledSuit: "H", calledRank: "A", calledUnder: true,
    underCard: C("QC"),
    partnerRevealed: false, calledAcePlayed: false, calledSuitLed: false, tricksDone: 0,
    trick: [{ player: 1, card: C("9H") }],
    hands: [H(["QC", "JD", "KS"]), H(["8H"]), H(["7C"]), H(["AH"]), H(["9C"])],
  };
  const legal = legalPlays(g, 0);
  check("hearts led forces the under card out", legal.length === 1, legal.map(cid).join(" "));
  check("...and it is the designated card", cid(legal[0]) === "QC", legal.map(cid).join(" "));

  const after = applyPlay(g, 0, C("QC"));
  const entry = after.trick.find((t) => t.under);
  check("it lands as the 6 of the called suit",
    entry.card.rank === "6" && entry.card.suit === "H", JSON.stringify(entry.card));
  check("the real card travels alongside it", cid(entry.actual) === "QC");
  check("the highest trump in the deck cannot win the trick",
    trickWinner(after.trick) === 1, `winner ${trickWinner(after.trick)}`);
  check("but it still scores its own three points",
    after.trick.reduce((s, t) => s + cardPts(t.actual ?? t.card), 0) === 3);

  // Playing the under card is not playing the called ace: no partner reveal.
  check("playing under does not reveal a partner", after.partnerRevealed === false);

  // Once it is gone the picker is void for real and may trump freely.
  const gone = { ...g, underCard: C("QC"), hands: g.hands.map((h, i) => (i === 0 ? H(["JD", "KS"]) : h)) };
  check("with the under card spent, the picker may trump hearts",
    legalPlays(gone, 0).length === 2, legalPlays(gone, 0).map(cid).join(" "));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — ace, ten and under name a partner correctly; the under card plays as a 6.");
