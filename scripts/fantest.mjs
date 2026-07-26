#!/usr/bin/env node
/* ============================================================================
   Hand fan geometry tests.

   Cards hanging off the edge of the screen has now happened twice: six cards
   laid out flat overflowed a 375px phone by 39px, and then a fixed overlap
   tuned for six clipped the picker's 8-card bury view. Both shipped with a
   passing build, because a build has no opinion about whether something fits.

   The rule is one line and worth asserting directly: for every hand size the
   game can produce, on every width a phone can have, the fan fits.

   Usage: node scripts/fantest.mjs
   ========================================================================= */
import { fanOverlap, fanWidth, CARD_W, MIN_OVERLAP, MAX_OVERLAP } from "../src/fan.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

// Narrowest phone still in circulation through the widest the table renders at.
const WIDTHS = [320, 360, 375, 390, 414, 428, 480];
// 8 while burying (six dealt plus the two-card blind), down to 1 on the last
// trick. 0 is the moment after the final card.
const COUNTS = [8, 7, 6, 5, 4, 3, 2, 1, 0];

/* --------------------------- The whole matrix ----------------------------- */
{
  const tooWide = [];
  for (const w of WIDTHS) {
    const avail = w - 12; // the hand row's horizontal padding
    for (const n of COUNTS) {
      if (n === 0) continue;
      const width = fanWidth(n, fanOverlap(n, avail));
      // MAX_OVERLAP is a deliberate floor on readability, so a genuinely
      // impossible case is allowed to exceed — but nothing in this matrix
      // should, and if that changes the test should say so loudly.
      if (width > avail) tooWide.push(`${n} cards @ ${w}px -> ${Math.round(width)} > ${avail}`);
    }
  }
  check("every hand size fits at every phone width", tooWide.length === 0, tooWide.join(" | "));
}

/* ------------------------- The two real regressions ------------------------ */
{
  // Regression 1: six cards flat on a 375px phone.
  const avail = 375 - 12;
  check("6 cards fit at 375px", fanWidth(6, fanOverlap(6, avail)) <= avail,
    `${Math.round(fanWidth(6, fanOverlap(6, avail)))} vs ${avail}`);

  // Regression 2: the picker's 8-card bury view, which a six-card overlap
  // does not accommodate.
  check("8 cards fit at 375px", fanWidth(8, fanOverlap(8, avail)) <= avail,
    `${Math.round(fanWidth(8, fanOverlap(8, avail)))} vs ${avail}`);
  check("8 cards need a tighter fan than 6",
    fanOverlap(8, avail) > fanOverlap(6, avail),
    `8->${fanOverlap(8, avail)} 6->${fanOverlap(6, avail)}`);

  // The old fixed value is exactly what didn't fit — proof the constant was
  // the bug rather than the layout around it.
  check("the old fixed overlap of 14 genuinely did not fit 8 cards",
    fanWidth(8, 14) > avail, `${fanWidth(8, 14)} vs ${avail}`);
}

/* -------------------------------- Clamping -------------------------------- */
{
  const roomy = 2000;
  check("a small hand in a wide space uses the minimum overlap",
    fanOverlap(3, roomy) === MIN_OVERLAP, `got ${fanOverlap(3, roomy)}`);
  check("overlap never goes below the minimum",
    COUNTS.filter((n) => n > 1).every((n) => fanOverlap(n, roomy) >= MIN_OVERLAP));
  check("overlap never exceeds the readable maximum",
    WIDTHS.every((w) => COUNTS.filter((n) => n > 1).every((n) => fanOverlap(n, w - 12) <= MAX_OVERLAP)));
  check("a single card needs no overlap", fanOverlap(1, 363) === 0);
  check("a lone card is exactly one card wide", fanWidth(1, 0) === CARD_W);
  check("an empty hand has no width", fanWidth(0, 20) === 0);
}

/* ------------------------------- Monotonic -------------------------------- */
{
  // More cards must never mean a looser fan, and a wider screen must never
  // mean a tighter one — either would be a sign the formula is inverted.
  const avail = 363;
  let ok = true;
  for (let n = 2; n < 8; n++) if (fanOverlap(n + 1, avail) < fanOverlap(n, avail)) ok = false;
  check("overlap never loosens as the hand grows", ok);

  let ok2 = true;
  for (let i = 1; i < WIDTHS.length; i++) {
    if (fanOverlap(8, WIDTHS[i] - 12) > fanOverlap(8, WIDTHS[i - 1] - 12)) ok2 = false;
  }
  check("overlap never tightens as the screen widens", ok2);
}

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — every hand size fits on every width.");
