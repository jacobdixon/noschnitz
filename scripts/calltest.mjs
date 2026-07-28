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
import { callOptions, assignPartner, legalPlays, applyPlay, cid, isTrump } from "../src/engine.js";

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
  // DISABLED pending the real mechanic. Under is not "call a suit you are void
  // in" — it is designating a card to stand in for that suit — and the version
  // that shipped let the picker trump their own called suit, which is strictly
  // better than playing it straight. These assert it stays off rather than
  // silently coming back in the broken shape.
  const voidHand = callOptions(H(["AC", "9C", "QC", "QS", "JD", "AD"]));
  check("under is not offered while unbuilt", voidHand.length === 0, show(voidHand));

  const trumpOnly = callOptions(H(["QC", "QS", "QH", "QD", "JC", "JS"]));
  check("a hand of pure trump goes alone for now", trumpOnly.length === 0, show(trumpOnly));

  check("no option anywhere is marked under",
    [voidHand, trumpOnly].every((o) => !o.some((x) => x.kind === "under")));
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

  // Pure trump has no fail card to keep, so it is exactly the shape that will
  // call under once that is built. For now it goes alone.
  const trumpOnly = callOptions(H(["QC", "QS", "QH", "QD", "JC", "JS"]));
  check("a hand of pure trump goes alone for now", trumpOnly.length === 0, show(trumpOnly));
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
  // Called hearts under; picker holds no hearts, so when hearts are led the
  // picker simply cannot follow and nothing forces them to.
  const g = {
    picker: 0, partner: 3, calledSuit: "H", calledRank: "A", calledUnder: true,
    partnerRevealed: false, calledAcePlayed: false, calledSuitLed: false, tricksDone: 0,
    trick: [{ player: 1, card: C("9H") }],
    hands: [H(["QC", "JD", "KS"]), H(["8H"]), H(["7C"]), H(["AH"]), H(["9C"])],
  };
  const legal = legalPlays(g, 0);
  check("a picker who called under can play anything when the suit is led",
    legal.length === 3, legal.map(cid).join(" "));
  check("...including trump", legal.some(isTrump));
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — ace and ten name a partner correctly; under stays off until built.");
