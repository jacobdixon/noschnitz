import React, { useState, useEffect, useMemo } from "react";

/* ================= SHEEPSHEAD — Call an Ace, 5-handed ================= */

const SUITS = ["C", "S", "H", "D"];
const RANKS = ["7", "8", "9", "K", "10", "A", "J", "Q"];
const SUIT_SYM = { C: "♣", S: "♠", H: "♥", D: "♦" };
const SUIT_NAME = { C: "Clubs", S: "Spades", H: "Hearts", D: "Diamonds" };
const CARD_POINTS = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0 };
const NAMES = ["You", "Gus", "Lorraine", "Werner", "Patty"];

const isTrump = (c) => c.rank === "Q" || c.rank === "J" || c.suit === "D";
const effSuit = (c) => (isTrump(c) ? "T" : c.suit);
const cardPts = (c) => CARD_POINTS[c.rank];
const cid = (c) => c.rank + c.suit;

function trumpPower(c) {
  const qOrder = { C: 14, S: 13, H: 12, D: 11 };
  const jOrder = { C: 10, S: 9, H: 8, D: 7 };
  if (c.rank === "Q") return qOrder[c.suit];
  if (c.rank === "J") return jOrder[c.suit];
  return { A: 6, "10": 5, K: 4, "9": 3, "8": 2, "7": 1 }[c.rank];
}
const failPower = (c) => ({ A: 6, "10": 5, K: 4, "9": 3, "8": 2, "7": 1 }[c.rank]);
const power = (c) => (isTrump(c) ? 100 + trumpPower(c) : failPower(c));

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function sortHand(hand) {
  const suitOrd = { C: 0, S: 1, H: 2 };
  return [...hand].sort((a, b) => {
    const at = isTrump(a), bt = isTrump(b);
    if (at && bt) return trumpPower(b) - trumpPower(a);
    if (at) return -1;
    if (bt) return 1;
    if (a.suit !== b.suit) return suitOrd[a.suit] - suitOrd[b.suit];
    return failPower(b) - failPower(a);
  });
}

function trickWinner(trick) {
  const led = effSuit(trick[0].card);
  let best = trick[0];
  for (const p of trick.slice(1)) {
    const bt = isTrump(best.card), pt = isTrump(p.card);
    if (pt && !bt) best = p;
    else if (pt && bt && trumpPower(p.card) > trumpPower(best.card)) best = p;
    else if (!pt && !bt && effSuit(p.card) === led && failPower(p.card) > failPower(best.card)) best = p;
  }
  return best.player;
}

/* ---------- Legality (follow suit + called-ace constraints) ---------- */
function legalPlays(g, playerIdx) {
  const hand = g.hands[playerIdx];
  const called = g.calledSuit; // null when picker went alone
  const isPartner = playerIdx === g.partner;
  const isPicker = playerIdx === g.picker;
  const aceOut = g.calledAcePlayed;
  const lastTrick = g.tricksDone === 5;

  const calledAce = (c) => called && c.suit === called && c.rank === "A" && !isTrump(c);
  const inCalled = (c) => called && !isTrump(c) && c.suit === called;

  let legal;
  if (g.trick.length === 0) {
    legal = [...hand];
    // Partner may not lead the called suit except with the ace itself (until ace is played)
    if (isPartner && !aceOut && !lastTrick) {
      const filtered = legal.filter((c) => !inCalled(c) || calledAce(c));
      if (filtered.length) legal = filtered;
    }
  } else {
    const led = effSuit(g.trick[0].card);
    const follow = hand.filter((c) => effSuit(c) === led);
    legal = follow.length ? follow : [...hand];
    // Partner must play the called ace the first time the suit is led
    if (isPartner && !aceOut && led === called) {
      const ace = legal.find(calledAce);
      if (ace) legal = [ace];
    }
  }

  // Partner may not throw the called ace off-suit before the suit is led (unless forced or last trick)
  if (isPartner && !aceOut && !lastTrick && g.trick.length > 0) {
    const led = effSuit(g.trick[0].card);
    if (led !== called) {
      const filtered = legal.filter((c) => !calledAce(c));
      if (filtered.length) legal = filtered;
    }
  }
  // Picker must retain a called-suit card until the suit has been led
  if (isPicker && called && !g.calledSuitLed && !lastTrick) {
    const calledCards = hand.filter(inCalled);
    if (calledCards.length === 1 && g.trick.length > 0 && effSuit(g.trick[0].card) !== called) {
      const filtered = legal.filter((c) => !inCalled(c));
      if (filtered.length) legal = filtered;
    }
  }
  return legal;
}

/* ------------------------------ AI brains ------------------------------ */
function handStrength(hand) {
  const t = hand.filter(isTrump);
  const q = t.filter((c) => c.rank === "Q").length;
  const j = t.filter((c) => c.rank === "J").length;
  return t.length * 2 + q * 2 + j;
}

function aiBuryAndCall(hand) {
  // choose 2 to bury from 8, then a suit to call
  let h = [...hand];
  const fails = () => h.filter((c) => !isTrump(c));
  const suitsHeld = (arr) => {
    const m = { C: [], S: [], H: [] };
    arr.forEach((c) => m[c.suit].push(c));
    return m;
  };
  const callable = (arr, buriedSoFar = []) => {
    const m = suitsHeld(arr.filter((c) => !isTrump(c)));
    return ["C", "S", "H"].filter(
      (s) =>
        m[s].length > 0 &&
        !m[s].some((c) => c.rank === "A") &&
        !buriedSoFar.some((c) => c.suit === s && c.rank === "A")
    );
  };

  const buried = [];
  for (let k = 0; k < 2; k++) {
    const f = fails();
    let pool = f.length ? f : h.filter((c) => trumpPower(c) <= 3); // low diamonds as last resort
    if (!pool.length) pool = [...h].sort((a, b) => power(a) - power(b)).slice(0, 1);
    // prefer high points; avoid destroying the only callable suit
    const scored = pool
      .map((c) => {
        const rest = h.filter((x) => x !== c);
        const keepsCall = callable(rest, [...buried, c]).length > 0 || callable(h, buried).length === 0;
        const m = suitsHeld(fails());
        const shortBonus = !isTrump(c) && m[c.suit].length === 1 && !m[c.suit].some((x) => x.rank === "A") ? -3 : 0;
        return { c, score: cardPts(c) * 2 + (keepsCall ? 4 : -8) + shortBonus + (c.rank === "A" && !isTrump(c) ? 3 : 0) };
      })
      .sort((a, b) => b.score - a.score);
    const pick = scored[0].c;
    buried.push(pick);
    h = h.filter((c) => c !== pick);
  }
  const opts = callable(h, buried);
  let call = null;
  if (opts.length) {
    const m = suitsHeld(h.filter((c) => !isTrump(c)));
    opts.sort((a, b) => m[a].length - m[b].length);
    call = opts[0];
  }
  return { buried, call, hand: h };
}

function knowsTeammate(g, viewer, target) {
  if (viewer === target) return true;
  const onPickerTeam = (i) => i === g.picker || i === g.partner;
  const viewerOnPicker = onPickerTeam(viewer);
  // viewer knows picker; partner knows self; everyone knows partner after reveal
  const targetKnownPicker = target === g.picker || (g.partnerRevealed && target === g.partner);
  if (viewerOnPicker) {
    if (viewer === g.partner || viewer === g.picker) {
      if (target === g.picker) return true;
      if (viewer === g.partner && target === g.picker) return true;
      if (g.partnerRevealed && target === g.partner) return true;
      if (viewer === g.picker && !g.partnerRevealed) return false; // picker unsure of partner
      return targetKnownPicker;
    }
  }
  // defender: teammates are all non-picker-team players (as far as known)
  if (!viewerOnPicker) return !targetKnownPicker && target !== g.picker;
  return false;
}

function aiChooseCard(g, idx) {
  const legal = legalPlays(g, idx);
  if (legal.length === 1) return legal[0];
  const onPickerTeam = idx === g.picker || idx === g.partner;

  if (g.trick.length === 0) {
    // Leading
    const trumps = legal.filter(isTrump).sort((a, b) => trumpPower(b) - trumpPower(a));
    const fails = legal.filter((c) => !isTrump(c));
    if (onPickerTeam) {
      if (trumps.length && (trumps[0].rank === "Q" || trumps.length >= 3)) return trumps[0];
      if (idx === g.picker && g.calledSuit && !g.calledAcePlayed) {
        const cs = fails.filter((c) => c.suit === g.calledSuit);
        if (cs.length && g.tricksDone >= 2) return cs.sort((a, b) => failPower(a) - failPower(b))[0]; // call for the ace
      }
      if (fails.length) return fails.sort((a, b) => cardPts(a) - cardPts(b) || failPower(a) - failPower(b))[0];
      return trumps[trumps.length - 1];
    } else {
      const aces = fails.filter((c) => c.rank === "A" && c.suit !== g.calledSuit);
      if (aces.length) return aces[0];
      const nonCalled = fails.filter((c) => c.suit !== g.calledSuit);
      if (nonCalled.length) return nonCalled.sort((a, b) => cardPts(a) - cardPts(b))[0];
      if (fails.length) return fails.sort((a, b) => cardPts(a) - cardPts(b))[0];
      return trumps.length ? trumps[trumps.length - 1] : legal[0];
    }
  }

  // Following
  const winnerSoFar = trickWinner(g.trick);
  const winningCard = g.trick.find((t) => t.player === winnerSoFar).card;
  const mateWinning = knowsTeammate(g, idx, winnerSoFar);
  const beats = (c) => {
    const hypo = [...g.trick, { player: idx, card: c }];
    return trickWinner(hypo) === idx;
  };
  const winners = legal.filter(beats);
  const trickPts = g.trick.reduce((s, t) => s + cardPts(t.card), 0);
  const lastToPlay = g.trick.length === 4;

  if (mateWinning && (lastToPlay || power(winningCard) >= 110)) {
    // schmear: give points to a winning teammate
    return [...legal].sort((a, b) => cardPts(b) - cardPts(a) || power(a) - power(b))[0];
  }
  if (winners.length) {
    if (lastToPlay) {
      // cheapest winner, but prefer pointy winner if it's ours anyway
      return winners.sort((a, b) => power(a) - power(b))[0];
    }
    if (trickPts >= 10 || g.tricksDone >= 3) {
      // try to secure with strength
      return winners.sort((a, b) => power(b) - power(a))[0];
    }
    return winners.sort((a, b) => power(a) - power(b))[0];
  }
  // can't win: dump lowest points, lowest power
  return [...legal].sort((a, b) => cardPts(a) - cardPts(b) || power(a) - power(b))[0];
}

/* ------------------------------ Game setup ------------------------------ */
function freshHand(dealer, scores, handNum) {
  const deck = makeDeck();
  const hands = [[], [], [], [], []];
  let di = 0;
  for (let p = 0; p < 5; p++) for (let k = 0; k < 6; k++) hands[p].push(deck[di++]);
  const blind = [deck[di++], deck[di++]];
  return {
    phase: "picking",
    handNum,
    dealer,
    hands: hands.map(sortHand),
    blind,
    buried: [],
    picker: null,
    partner: null,
    partnerRevealed: false,
    calledSuit: null,
    calledAcePlayed: false,
    calledSuitLed: false,
    alone: false,
    pickTurn: (dealer + 1) % 5,
    passes: 0,
    trick: [],
    leader: (dealer + 1) % 5,
    turn: (dealer + 1) % 5,
    tricksDone: 0,
    trickCounts: [0, 0, 0, 0, 0],
    ptsTaken: [0, 0, 0, 0, 0],
    lastTrick: null,
    selected: [],
    scores,
    message: null,
    result: null,
  };
}

function assignPartner(g) {
  if (!g.calledSuit) return { ...g, partner: null, alone: true };
  let partner = null;
  for (let p = 0; p < 5; p++) {
    if (p === g.picker) continue;
    if (g.hands[p].some((c) => c.suit === g.calledSuit && c.rank === "A" && !isTrump(c))) partner = p;
  }
  return { ...g, partner, alone: partner === null };
}

function applyPlay(g, idx, card) {
  const hands = g.hands.map((h, i) => (i === idx ? h.filter((c) => cid(c) !== cid(card)) : h));
  const trick = [...g.trick, { player: idx, card }];
  let { partnerRevealed, calledAcePlayed, calledSuitLed } = g;
  if (g.calledSuit && !isTrump(card) && card.suit === g.calledSuit) {
    if (trick.length === 1) calledSuitLed = true;
    if (effSuit(trick[0].card) === g.calledSuit) calledSuitLed = true;
    if (card.rank === "A") {
      calledAcePlayed = true;
      if (idx === g.partner) partnerRevealed = true;
    }
  }
  const next = { ...g, hands, trick, partnerRevealed, calledAcePlayed, calledSuitLed };
  if (trick.length < 5) next.turn = (idx + 1) % 5;
  else next.turn = -1; // wait for trick resolution
  return next;
}

function resolveTrick(g) {
  const w = trickWinner(g.trick);
  const pts = g.trick.reduce((s, t) => s + cardPts(t.card), 0);
  const ptsTaken = [...g.ptsTaken];
  ptsTaken[w] += pts;
  const trickCounts = [...g.trickCounts];
  trickCounts[w] += 1;
  const tricksDone = g.tricksDone + 1;
  const base = {
    ...g,
    ptsTaken,
    trickCounts,
    tricksDone,
    lastTrick: { trick: g.trick, winner: w },
    trick: [],
    leader: w,
    turn: w,
  };
  if (tricksDone === 6) return scoreHand(base);
  return base;
}

function scoreHand(g) {
  const buriedPts = g.buried.reduce((s, c) => s + cardPts(c), 0);
  const pickerTeam = [g.picker, ...(g.partner !== null ? [g.partner] : [])];
  const teamPts = pickerTeam.reduce((s, p) => s + g.ptsTaken[p], 0) + buriedPts;
  const defPts = 120 - teamPts;
  const teamTricks = pickerTeam.reduce((s, p) => s + g.trickCounts[p], 0);
  const pickerWins = teamPts >= 61;
  let mult = 1;
  let label = "";
  if (pickerWins) {
    if (teamTricks === 6) { mult = 3; label = "No-tricker!"; }
    else if (defPts <= 30) { mult = 2; label = "Schneider!"; }
  } else {
    if (teamTricks === 0) { mult = 3; label = "No-tricker!"; }
    else if (teamPts <= 30) { mult = 2; label = "Schneider!"; }
  }
  const scores = [...g.scores];
  const sign = pickerWins ? 1 : -1;
  if (g.alone || g.partner === null) {
    scores[g.picker] += sign * 4 * mult;
    for (let p = 0; p < 5; p++) if (p !== g.picker) scores[p] -= sign * mult;
  } else {
    scores[g.picker] += sign * 2 * mult;
    scores[g.partner] += sign * 1 * mult;
    for (let p = 0; p < 5; p++) if (!pickerTeam.includes(p)) scores[p] -= sign * mult;
  }
  return {
    ...g,
    phase: "handEnd",
    scores,
    result: { teamPts, defPts, pickerWins, mult, label, buriedPts, pickerTeam },
  };
}

/* ================================ UI ================================ */
const felt = {
  bg: "#123B2D",
  bgDeep: "#0C2B20",
  rail: "#4A2E18",
  cream: "#F6EFDD",
  creamDim: "#E7DCC2",
  brass: "#D2A93C",
  brassDim: "#9A7C2C",
  red: "#B3392F",
  black: "#28241E",
  chip: "#1B4D3B",
};

function Card({ card, small, onClick, dim, selected, faceDown }) {
  const w = small ? 42 : 56;
  const h = small ? 60 : 80;
  if (faceDown) {
    return (
      <div style={{
        width: w, height: h, borderRadius: 7, flexShrink: 0,
        background: `repeating-linear-gradient(45deg, #6E1F1B, #6E1F1B 4px, #591714 4px, #591714 8px)`,
        border: `2px solid ${felt.cream}`, boxShadow: "0 2px 4px rgba(0,0,0,.4)",
      }} />
    );
  }
  const red = card.suit === "H" || card.suit === "D";
  const trump = isTrump(card);
  return (
    <div onClick={onClick} style={{
      width: w, height: h, borderRadius: 7, flexShrink: 0, position: "relative",
      background: dim ? "#CFC7B2" : felt.cream,
      border: selected ? `2.5px solid ${felt.brass}` : "1.5px solid #B8AD92",
      boxShadow: selected ? `0 0 0 2px ${felt.brass}55, 0 -6px 10px rgba(0,0,0,.35)` : "0 2px 4px rgba(0,0,0,.35)",
      transform: selected ? "translateY(-10px)" : "none",
      transition: "transform .15s, box-shadow .15s",
      cursor: onClick ? "pointer" : "default",
      opacity: dim ? 0.55 : 1,
      display: "flex", flexDirection: "column", justifyContent: "space-between",
      padding: small ? "3px 4px" : "4px 6px",
      userSelect: "none", WebkitTapHighlightColor: "transparent",
    }}>
      <div style={{ fontSize: small ? 13 : 16, fontWeight: 800, lineHeight: 1, color: red ? felt.red : felt.black, fontFamily: "Georgia, serif" }}>
        {card.rank}
        <span style={{ fontSize: small ? 11 : 14 }}>{SUIT_SYM[card.suit]}</span>
      </div>
      <div style={{ alignSelf: "center", fontSize: small ? 18 : 26, color: red ? felt.red : felt.black, lineHeight: 1 }}>
        {SUIT_SYM[card.suit]}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {trump && <div style={{ width: small ? 6 : 8, height: small ? 6 : 8, borderRadius: "50%", background: felt.brass, boxShadow: "0 0 3px " + felt.brass }} />}
      </div>
    </div>
  );
}

function Badge({ children, gold }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase",
      padding: "2px 6px", borderRadius: 4,
      background: gold ? felt.brass : "#ffffff22",
      color: gold ? "#2A2108" : felt.creamDim,
    }}>{children}</span>
  );
}

export default function Sheepshead() {
  const [g, setG] = useState(() => freshHand(Math.floor(Math.random() * 5), [0, 0, 0, 0, 0], 1));
  const [showScores, setShowScores] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  /* ---------- engine loop ---------- */
  useEffect(() => {
    let t;
    if (g.phase === "picking") {
      if (g.passes === 5) {
        t = setTimeout(() => setG((s) => ({ ...freshHand((s.dealer + 1) % 5, s.scores, s.handNum + 1), message: null })), 1600);
      } else if (g.pickTurn !== 0) {
        t = setTimeout(() => setG((s) => {
          if (s.phase !== "picking" || s.pickTurn === 0 || s.passes === 5) return s;
          const idx = s.pickTurn;
          const wants = handStrength(s.hands[idx]) >= 10 || (s.passes === 4 && handStrength(s.hands[idx]) >= 8);
          if (!wants) {
            const passes = s.passes + 1;
            return { ...s, passes, pickTurn: (idx + 1) % 5, message: passes === 5 ? "Everyone passed — throwing it in." : null };
          }
          // AI picks: take blind, bury, call
          const eight = [...s.hands[idx], ...s.blind];
          const { buried, call, hand } = aiBuryAndCall(eight);
          const hands = s.hands.map((h, i) => (i === idx ? sortHand(hand) : h));
          let ns = { ...s, picker: idx, hands, buried, calledSuit: call, phase: "playing", trick: [], turn: s.leader, message: null };
          ns = assignPartner(ns);
          return ns;
        }), 750);
      }
    }
    if (g.phase === "playing") {
      if (g.trick.length === 5) {
        t = setTimeout(() => setG((s) => (s.trick.length === 5 ? resolveTrick(s) : s)), 1500);
      } else if (g.turn !== 0 && g.turn !== -1) {
        t = setTimeout(() => setG((s) => {
          if (s.phase !== "playing" || s.turn === 0 || s.turn === -1 || s.trick.length >= 5) return s;
          const card = aiChooseCard(s, s.turn);
          return applyPlay(s, s.turn, card);
        }), 800);
      }
    }
    return () => clearTimeout(t);
  }, [g.phase, g.pickTurn, g.passes, g.turn, g.trick.length, g.tricksDone]);

  /* ---------- human actions ---------- */
  const humanPick = (pick) => {
    setG((s) => {
      if (pick) {
        const hands = s.hands.map((h, i) => (i === 0 ? sortHand([...h, ...s.blind]) : h));
        return { ...s, picker: 0, hands, phase: "bury", selected: [], message: "Select two cards to bury." };
      }
      const passes = s.passes + 1;
      return { ...s, passes, pickTurn: (s.pickTurn + 1) % 5, message: passes === 5 ? "Everyone passed — throwing it in." : null };
    });
  };

  const toggleBury = (card) => {
    setG((s) => {
      const sel = s.selected.some((c) => cid(c) === cid(card))
        ? s.selected.filter((c) => cid(c) !== cid(card))
        : s.selected.length < 2 ? [...s.selected, card] : s.selected;
      return { ...s, selected: sel };
    });
  };

  const confirmBury = () => {
    setG((s) => {
      if (s.selected.length !== 2) return s;
      const hand = s.hands[0].filter((c) => !s.selected.some((x) => cid(x) === cid(c)));
      const hands = s.hands.map((h, i) => (i === 0 ? hand : h));
      const failsBy = { C: [], S: [], H: [] };
      hand.filter((c) => !isTrump(c)).forEach((c) => failsBy[c.suit].push(c));
      const opts = ["C", "S", "H"].filter(
        (su) =>
          failsBy[su].length > 0 &&
          !failsBy[su].some((c) => c.rank === "A") &&
          !s.selected.some((c) => c.suit === su && c.rank === "A")
      );
      return { ...s, hands, buried: s.selected, selected: [], phase: "call", callOptions: opts, message: opts.length ? "Call an ace — your partner holds it." : "No callable suit. You're going alone." };
    });
  };

  const callAce = (suit) => {
    setG((s) => {
      let ns = { ...s, calledSuit: suit, phase: "playing", trick: [], turn: s.leader, message: null };
      ns = assignPartner(ns);
      return ns;
    });
  };

  const humanPlay = (card) => {
    setG((s) => {
      if (s.phase !== "playing" || s.turn !== 0 || s.trick.length >= 5) return s;
      const legal = legalPlays(s, 0);
      if (!legal.some((c) => cid(c) === cid(card))) return s;
      return applyPlay(s, 0, card);
    });
  };

  const nextHand = () => setG((s) => freshHand((s.dealer + 1) % 5, s.scores, s.handNum + 1));

  /* ---------- derived ---------- */
  const legalNow = useMemo(() => (g.phase === "playing" && g.turn === 0 ? legalPlays(g, 0).map(cid) : []), [g]);
  const seatPos = [null,
    { left: "2%", top: "46%" },
    { left: "20%", top: "4%" },
    { right: "20%", top: "4%" },
    { right: "2%", top: "46%" },
  ];
  const trickPos = {
    0: { left: "50%", top: "72%", transform: "translate(-50%,-50%)" },
    1: { left: "22%", top: "50%", transform: "translate(-50%,-50%)" },
    2: { left: "38%", top: "26%", transform: "translate(-50%,-50%)" },
    3: { left: "62%", top: "26%", transform: "translate(-50%,-50%)" },
    4: { left: "78%", top: "50%", transform: "translate(-50%,-50%)" },
  };
  const roleTag = (i) => {
    if (g.picker === i) return <Badge gold>Picker{g.alone ? " · Alone" : ""}</Badge>;
    if (g.partnerRevealed && g.partner === i) return <Badge gold>Partner</Badge>;
    return null;
  };

  const statusLine = () => {
    if (g.phase === "picking") {
      if (g.passes === 5) return "Everyone passed — redealing…";
      return g.pickTurn === 0 ? "Blind's yours if you want it." : `${NAMES[g.pickTurn]} is thinking…`;
    }
    if (g.phase === "bury") return `Bury two cards (${g.selected.length}/2)`;
    if (g.phase === "call") return g.message;
    if (g.phase === "playing") {
      if (g.trick.length === 5) return `${NAMES[trickWinner(g.trick)]} takes the trick`;
      return g.turn === 0 ? "Your play." : `${NAMES[g.turn]}'s play…`;
    }
    return "";
  };

  return (
    <div style={{
      minHeight: "100vh", background: `radial-gradient(ellipse at 50% 30%, ${felt.bg}, ${felt.bgDeep} 80%)`,
      color: felt.cream, fontFamily: "'Avenir Next', 'Segoe UI', system-ui, sans-serif",
      display: "flex", flexDirection: "column", maxWidth: 480, margin: "0 auto",
      borderLeft: `6px solid ${felt.rail}`, borderRight: `6px solid ${felt.rail}`,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: `2px solid ${felt.rail}` }}>
        <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 900, letterSpacing: ".14em", fontSize: 16, color: felt.brass }}>
          SHEEPSHEAD
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setShowHelp(true)} style={btnGhost}>Trump</button>
          <button onClick={() => setShowScores(true)} style={btnGhost}>Scores</button>
        </div>
      </div>

      {/* Contract strip */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 12px", fontSize: 12, color: felt.creamDim, minHeight: 28 }}>
        <span>Hand {g.handNum}</span>
        <span>· Dealer: {NAMES[g.dealer]}</span>
        {g.picker !== null && <span>· {NAMES[g.picker]} picked</span>}
        {g.calledSuit && (
          <span style={{ color: felt.brass, fontWeight: 700 }}>
            · Called: A{SUIT_SYM[g.calledSuit]}
          </span>
        )}
        {g.picker !== null && g.alone && <span style={{ color: felt.brass }}>· Alone</span>}
      </div>

      {/* Table */}
      <div style={{ position: "relative", flex: 1, minHeight: 340 }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ position: "absolute", ...seatPos[i], display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 84 }}>
            <div style={{
              width: 44, height: 44, borderRadius: "50%", background: felt.chip,
              border: `2px solid ${g.phase === "playing" && g.turn === i ? felt.brass : (g.phase === "picking" && g.pickTurn === i ? felt.brass : "#ffffff2e")}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "Georgia, serif", fontWeight: 800, fontSize: 16,
              boxShadow: (g.turn === i || g.pickTurn === i) ? `0 0 10px ${felt.brass}66` : "none",
              transition: "border .2s, box-shadow .2s",
            }}>
              {NAMES[i][0]}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700 }}>{NAMES[i]}</div>
            <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: felt.creamDim }}>{g.hands[i].length}🂠 · {g.trickCounts[i]} tricks</span>
            </div>
            {roleTag(i)}
          </div>
        ))}

        {/* trick cards */}
        {g.trick.map((t) => (
          <div key={cid(t.card)} style={{ position: "absolute", ...trickPos[t.player], zIndex: 2 }}>
            <Card card={t.card} small />
          </div>
        ))}
        {g.trick.length === 5 && (
          <div style={{
            position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
            background: "#000000aa", padding: "4px 12px", borderRadius: 6, fontSize: 13, fontWeight: 700, color: felt.brass, zIndex: 3,
          }}>
            {NAMES[trickWinner(g.trick)]} +{g.trick.reduce((s, t) => s + cardPts(t.card), 0)}
          </div>
        )}

        {/* blind marker during picking */}
        {g.phase === "picking" && g.passes < 5 && (
          <div style={{ position: "absolute", left: "50%", top: "44%", transform: "translate(-50%,-50%)", display: "flex", gap: 6 }}>
            <Card faceDown small /><Card faceDown small />
          </div>
        )}
      </div>

      {/* Status + actions */}
      <div style={{ padding: "8px 12px", textAlign: "center", minHeight: 84 }}>
        <div style={{ fontSize: 13, marginBottom: 8, color: felt.creamDim, fontStyle: "italic" }}>{statusLine()}</div>

        {g.phase === "picking" && g.pickTurn === 0 && g.passes < 5 && (
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button style={btnGold} onClick={() => humanPick(true)}>Pick it up</button>
            <button style={btnPlain} onClick={() => humanPick(false)}>Pass</button>
          </div>
        )}

        {g.phase === "bury" && (
          <button style={{ ...btnGold, opacity: g.selected.length === 2 ? 1 : 0.45 }} onClick={confirmBury} disabled={g.selected.length !== 2}>
            Bury {g.selected.length}/2
          </button>
        )}

        {g.phase === "call" && (
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            {(g.callOptions || []).map((su) => (
              <button key={su} style={btnGold} onClick={() => callAce(su)}>
                Call A<span style={{ color: su === "H" ? "#7A1E14" : "#1c1a14" }}>{SUIT_SYM[su]}</span>
              </button>
            ))}
            {(!g.callOptions || g.callOptions.length === 0) && (
              <button style={btnGold} onClick={() => callAce(null)}>Go alone</button>
            )}
          </div>
        )}

        {g.tricksDone > 0 && g.phase === "playing" && (
          <div style={{ fontSize: 11, color: felt.creamDim, marginTop: 4 }}>
            Trick {g.tricksDone + 1} of 6 · You've taken {g.ptsTaken[0]} pts
          </div>
        )}
      </div>

      {/* Your hand */}
      <div style={{ padding: "0 10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".06em" }}>YOUR HAND</div>
          {roleTag(0)}
          <div style={{ marginLeft: "auto", fontSize: 11, color: felt.creamDim }}>{g.trickCounts[0]} tricks · score {g.scores[0]}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "center", paddingTop: 10 }}>
          {g.hands[0].map((c, i) => {
            const inBury = g.phase === "bury";
            const playable = g.phase === "playing" && g.turn === 0 && legalNow.includes(cid(c));
            const selected = g.selected.some((x) => cid(x) === cid(c));
            return (
              <div key={cid(c)} style={{ marginLeft: i === 0 ? 0 : -14, zIndex: i }}>
                <Card
                  card={c}
                  selected={selected}
                  dim={g.phase === "playing" && g.turn === 0 && !playable}
                  onClick={
                    inBury ? () => toggleBury(c)
                    : playable ? () => humanPlay(c)
                    : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Hand end modal */}
      {g.phase === "handEnd" && g.result && (
        <Modal>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 20, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
            {g.result.pickerWins ? "Picker team wins" : "Defenders win"} {g.result.label && `— ${g.result.label}`}
          </div>
          <div style={{ fontSize: 13, marginBottom: 10, color: felt.creamDim }}>
            {g.result.pickerTeam.map((p) => NAMES[p]).join(" & ")} took {g.result.teamPts} points
            {g.result.buriedPts > 0 && ` (${g.result.buriedPts} buried)`} · defenders {g.result.defPts}
          </div>
          <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginBottom: 14 }}>
            <tbody>
              {NAMES.map((n, i) => (
                <tr key={n} style={{ borderBottom: "1px solid #ffffff18" }}>
                  <td style={{ padding: "5px 0", fontWeight: i === 0 ? 800 : 500 }}>
                    {n}{" "}
                    {i === g.picker && <Badge gold>Picker</Badge>}{" "}
                    {i === g.partner && <Badge gold>Partner</Badge>}
                  </td>
                  <td style={{ textAlign: "right" }}>{g.ptsTaken[i]} pts</td>
                  <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700, width: 60 }}>
                    {g.scores[i] >= 0 ? "+" : ""}{g.scores[i]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button style={btnGold} onClick={nextHand}>Deal next hand</button>
        </Modal>
      )}

      {/* Scores modal */}
      {showScores && (
        <Modal onClose={() => setShowScores(false)}>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 18, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>Score</div>
          {NAMES.map((n, i) => (
            <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #ffffff18", fontSize: 14 }}>
              <span style={{ fontWeight: i === 0 ? 800 : 500 }}>{n}</span>
              <span style={{ color: felt.brass, fontWeight: 700 }}>{g.scores[i] >= 0 ? "+" : ""}{g.scores[i]}</span>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <button style={btnPlain} onClick={() => setShowScores(false)}>Close</button>
          </div>
        </Modal>
      )}

      {/* Trump help modal */}
      {showHelp && (
        <Modal onClose={() => setShowHelp(false)}>
          <div style={{ fontFamily: "Georgia, serif", fontSize: 18, fontWeight: 900, color: felt.brass, marginBottom: 8 }}>Trump order</div>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: felt.creamDim }}>
            <div style={{ color: felt.cream, fontWeight: 700 }}>Q♣ Q♠ Q♥ Q♦ · J♣ J♠ J♥ J♦ · A♦ 10♦ K♦ 9♦ 8♦ 7♦</div>
            <div style={{ marginTop: 8 }}>All queens, jacks, and diamonds are trump (marked with a gold dot). Fail suits rank A, 10, K, 9, 8, 7.</div>
            <div style={{ marginTop: 8 }}>Points: A=11, 10=10, K=4, Q=3, J=2. Picker's team needs 61 of 120.</div>
            <div style={{ marginTop: 8 }}>The player holding the called ace is the picker's secret partner and must play it when the suit is led.</div>
          </div>
          <div style={{ marginTop: 12 }}>
            <button style={btnPlain} onClick={() => setShowHelp(false)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000a8", zIndex: 20,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: felt.bgDeep, border: `2px solid ${felt.rail}`, borderRadius: 12,
        padding: 18, width: "100%", maxWidth: 380, color: felt.cream,
        boxShadow: "0 10px 40px rgba(0,0,0,.6)",
      }}>
        {children}
      </div>
    </div>
  );
}

const btnGold = {
  background: felt.brass, color: "#241C06", border: "none", borderRadius: 8,
  padding: "10px 18px", fontSize: 14, fontWeight: 800, letterSpacing: ".03em",
  cursor: "pointer", boxShadow: "0 2px 0 #7d6420",
};
const btnPlain = {
  background: "#ffffff14", color: felt.cream, border: "1px solid #ffffff30", borderRadius: 8,
  padding: "10px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer",
};
const btnGhost = {
  background: "transparent", color: felt.creamDim, border: `1px solid ${felt.brassDim}`,
  borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer",
  letterSpacing: ".05em",
};
