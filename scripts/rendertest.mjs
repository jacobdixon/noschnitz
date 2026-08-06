#!/usr/bin/env node
/* ============================================================================
   Does the UI actually render?

   Nothing in this repo has ever answered that. 23 of the 26 suites import
   engine.js; not one imported a component, and a coverage run puts every .jsx
   file at 0% — including TableScreen.jsx at 1331 lines. The only thing standing
   behind the UI was `npm run build`, and a build resolves modules; it has no
   opinion about whether a component throws when React calls it.

   THE BUG CLASS THIS IS FOR IS NOT HYPOTHETICAL. eslint.config.js exists
   because it has already reached production-adjacent code twice — ScoresModal
   reading four variables that belonged to PlayerModal's scope, and TRUMP_ORDER
   calling imports that had been removed. Both built cleanly and blanked the
   app. `no-undef` catches those two, and that is why it is on.

   But `no-undef` only sees free identifiers. It cannot see `g.trickHistory.map`
   when trickHistory is undefined, a hook called conditionally, a `.length` on a
   seat that is not there yet, or any of the ways a component throws while the
   bundler and the linter are both perfectly happy. That is what this covers:
   render the real components, with real engine states, and require that none of
   them throw.

   HOW IT LOADS JSX. Node cannot import .jsx, so the modules come through Vite's
   own SSR module runner (`ssrLoadModule`) — the same transform the app is built
   with, from the same config, with no second toolchain to drift. That is worth
   more than it sounds: a separate transform could disagree with the real build
   about JSX or about import.meta.env, and then this suite would be testing
   something nobody ships.

   WHAT A PASS DOES NOT MEAN. This asserts that components mount without
   throwing and produce markup. It says nothing about whether they look right,
   and it is not a substitute for the layout assertions in fantest.mjs or for a
   person on a phone. It is the floor, not the ceiling.

   Usage: node scripts/rendertest.mjs
   ========================================================================= */
import { installDom, installEventSource } from "./lib/domharness.mjs";

/* --------------------- the browser bits jsdom lacks ---------------------- */
const dom = installDom();
installEventSource();
const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });

// felt.jsx measures the table with one of these; jsdom has no layout, so it
// never fires. Never firing is correct here — the components must render
// before any measurement arrives, which is exactly the first-paint case.
define("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
define("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
// useHandGrade spawns a module worker for the rollout solve. The grade is
// asynchronous and optional by design — the recap renders with `pending` until
// it lands — so a worker that never answers is a state the UI must survive.
define("Worker", class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} });
// No network in a smoke test. Anything that fires on mount gets a shape it can
// destructure rather than a rejection, so a component fails on its own merits.
define("fetch", async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }));
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

// Multiplayer on, so TableScreen is reachable. With the flag off Vite strips
// the whole branch and this suite would silently cover less than it looks.
process.env.VITE_MULTIPLAYER = "1";

const { createServer } = await import("vite");
const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const engine = await import("../src/engine.js");

/* The Vite server is used for exactly one thing — transforming modules on
   demand — so everything a dev server normally does is switched off:

     watch: null        no file watcher. With one, startup crawls the project
                        root, and `coverage/` (135 files after a coverage run)
                        took this suite from 8s to 21s. A watcher is useless
                        here anyway: nothing edits files mid-run.
     noDiscovery        no dependency pre-bundling scan. That scan exists to
                        make a browser's first load fast; SSR resolves from
                        node_modules directly and never asks for the result.

   Config file still honoured, deliberately: the transform has to be the one the
   app is actually built with, or this suite tests something nobody ships. */
const server = await createServer({
  server: { middlewareMode: true, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: "custom",
  logLevel: "error",
});

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* ---------------------------------------------------------------------------
   React reports a throw from render through an error boundary and a throw from
   an effect by rethrowing out of act(). Both have to be caught, or a component
   that blows up in useEffect — which is where ResizeObserver, Worker and
   EventSource all live — would pass.
   ------------------------------------------------------------------------ */
class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { this.props.onError?.(err); }
  render() { return this.state.err ? null : this.props.children; }
}

async function renders(label, element) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  let caught = null;
  const root = createRoot(host, { onRecoverableError: (e) => { caught ??= e; } });
  try {
    await act(async () => {
      root.render(React.createElement(Boundary, { onError: (e) => { caught ??= e; } }, element));
    });
  } catch (e) {
    caught ??= e;
  }
  const html = host.innerHTML;
  try { await act(async () => { root.unmount(); }); } catch (e) { caught ??= e; }
  host.remove();

  check(`${label} renders without throwing`, caught === null,
    caught ? `${caught.message ?? caught}`.split("\n")[0] : "");
  return { html, error: caught };
}

/* ---------------------------------------------------------------------------
   Real states from the real engine, not hand-written fixtures. A fixture drifts
   away from what the engine produces and then the smoke test is rendering a
   shape the app never sees.
   ------------------------------------------------------------------------ */
const NAMES = ["You", "Gus", "Bunny", "Duane", "Patty"];

/* SEEDED, and it has to be. `freshHand` deals off makeDeck's unseeded shuffle,
   so an earlier version of this file rendered a different hand every run — which
   showed up as coverage wobbling between runs (modals.jsx 98.03 one run, 96.45
   the next, as different modal branches were reached).

   Coverage drift is the harmless symptom. The real problem is that a suite which
   renders a different state every run can fail only sometimes, and per CLAUDE.md
   a marginal test here is not a red check — it silently withholds the beta
   deploy. A smoke test must render the same thing every time or it is a
   liability.

   Same fix as the measurement harnesses (see the long note on `dealWith` in
   abtest.mjs): shuffle from ALL_CARDS, a fixed canonical order, rather than
   reshuffling cards that makeDeck already shuffled — the latter composes with
   the unseeded shuffle underneath instead of replacing it. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playToEnd({ stopAfterTricks = null, seed = 20260804 } = {}) {
  let g = engine.freshHand(0, [0, 0, 0, 0, 0], 1);
  const rand = mulberry32(seed);
  const deck = [...engine.ALL_CARDS];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  g = { ...g, hands: [0, 1, 2, 3, 4].map((p) => deck.slice(p * 6, p * 6 + 6)), blind: deck.slice(30, 32) };
  // Deterministic: walk the pick order until somebody has a hand worth picking.
  while (g.phase === "picking" && g.passes < 5) {
    const idx = g.pickTurn;
    if (engine.handStrength(g.hands[idx]) < 10 && g.passes < 4) {
      g = { ...g, passes: g.passes + 1, pickTurn: (idx + 1) % 5 };
      continue;
    }
    const { buried, call, callRank, callKind, underCard, hand } =
      engine.aiBuryAndCall([...g.hands[idx], ...g.blind]);
    g = engine.assignPartner({
      ...g, picker: idx, buried, calledSuit: call,
      calledRank: call === null ? null : callRank,
      calledUnder: callKind === "under", underCard: underCard ?? null,
      hands: g.hands.map((h, i) => (i === idx ? hand : h)),
      phase: "playing", trick: [], turn: g.leader,
    });
  }
  if (g.phase !== "playing") return null;
  let guard = 0;
  while (g.phase === "playing" && guard++ < 60) {
    if (stopAfterTricks !== null && (g.trickHistory?.length ?? 0) >= stopAfterTricks) break;
    const idx = g.turn;
    if (idx < 0) { g = engine.resolveTrick(g); continue; }
    g = engine.applyPlay(g, idx, engine.aiChooseCard(g, idx, {}));
    if (g.trick.length === 5) g = engine.resolveTrick(g);
  }
  return g;
}

const finished = playToEnd();
if (!finished || finished.phase !== "handEnd") {
  console.error("FAIL — could not produce a finished hand to render. This is an engine/harness problem, not a UI one.");
  process.exit(1);
}
const midHand = playToEnd({ stopAfterTricks: 3 });
const grades = engine.gradeHandPlays(finished);

/* ======================================================================
   1. The primitives
   ==================================================================== */
{
  const ui = await server.ssrLoadModule("/src/ui.jsx");
  // A trickHistory entry is { trick: [{ player, card }], winner } — the same
  // shape LastTrickModal destructures below.
  const card = finished.trickHistory[0].trick[0].card;

  await renders("Card (face up)", React.createElement(ui.Card, { card }));
  await renders("Card (face down)", React.createElement(ui.Card, { card, faceDown: true }));
  await renders("Card (small, dim, selected)",
    React.createElement(ui.Card, { card, small: true, dim: true, selected: true }));
  await renders("Badge", React.createElement(ui.Badge, { gold: true }, "PICKER"));
  await renders("Modal", React.createElement(ui.Modal, { onClose() {} }, "body"));
  await renders("ModalActions", React.createElement(ui.ModalActions, null, "ok"));

  const { html } = await renders("Card produces markup", React.createElement(ui.Card, { card }));
  check("Card renders something rather than nothing", html.length > 0, `${html.length} chars`);
}

/* ======================================================================
   2. The felt — every seat rotation, and both a live and a finished hand

   `rotate` is why every seat is exercised rather than just seat 0: the table
   is drawn from the viewer's chair, so seat 3's view is a different code path
   through the position tables than seat 0's.
   ==================================================================== */
{
  const felt = await server.ssrLoadModule("/src/felt.jsx");

  for (let seat = 0; seat < 5; seat++) {
    await renders(`Felt from seat ${seat} (mid-hand)`,
      React.createElement(felt.Felt, { g: midHand, names: NAMES, mySeat: seat }));
  }
  await renders("Felt (finished hand)",
    React.createElement(felt.Felt, { g: finished, names: NAMES, mySeat: 0 }));
  await renders("DealerButton", React.createElement(felt.DealerButton));
  await renders("RoleBadges (picker)",
    React.createElement(felt.RoleBadges, { g: finished, seat: finished.picker }));
  await renders("HandLabel",
    React.createElement(felt.HandLabel, { g: midHand, seat: 0, name: "You" }));
  await renders("HandFan (6 cards)",
    React.createElement(felt.HandFan, { cards: midHand.hands[0], isSelected: () => false, isDim: () => false }));
  await renders("HandFan (empty hand)",
    React.createElement(felt.HandFan, { cards: [], isSelected: () => false, isDim: () => false }));
}

/* ======================================================================
   3. The modals — including the two that have actually broken

   ScoresModal is the one that shipped to beta reading PlayerModal's
   variables. It gets rendered both ways it is used: bare, and with the
   `children`/`actions` slots a table fills in.
   ==================================================================== */
{
  const m = await server.ssrLoadModule("/src/modals.jsx");

  await renders("TrumpModal", React.createElement(m.TrumpModal, { onClose() {} }));
  await renders("ShareHandsModal",
    React.createElement(m.ShareHandsModal, { sharing: true, onToggle() {}, onClose() {} }));

  await renders("ScoresModal",
    React.createElement(m.ScoresModal, { names: NAMES, scores: [3, -1, 0, 2, -4], handNum: 7, mySeat: 0, onClose() {} }));
  await renders("ScoresModal (with children and actions slots)",
    React.createElement(m.ScoresModal,
      { names: NAMES, scores: [0, 0, 0, 0, 0], handNum: 1, mySeat: 2, onClose() {},
        children: React.createElement("div", null, "seat list"),
        actions: React.createElement("button", null, "Leave") }));

  await renders("LastTrickModal",
    React.createElement(m.LastTrickModal,
      { lastTrick: finished.trickHistory[finished.trickHistory.length - 1], names: NAMES, mySeat: 0, onClose() {} }));
  // A hand where nothing has been played yet still opens the menu item.
  await renders("LastTrickModal (no trick yet)",
    React.createElement(m.LastTrickModal, { lastTrick: null, names: NAMES, mySeat: 0, onClose() {} }));

  await renders("HandEndModal",
    React.createElement(m.HandEndModal, { g: finished, names: NAMES, mySeat: 0, onNext() {}, onRecap() {} }));

  const recap = await renders("RecapModal (graded)",
    React.createElement(m.RecapModal, { g: finished, names: NAMES, mySeat: 0, grades, onBack() {}, onNext() {} }));

  /* The blind marks get a real assertion rather than a smoke pass, because
     "renders without throwing" is exactly what a mark on the WRONG cards also
     does. Both blind cards always surface — the picker's eight are six played
     plus two buried — so the count is knowable, and each is checked against
     the glyph that should sit immediately after it. Marking every card, or
     the picker's whole hand, fails on the count; marking the wrong two fails
     on the adjacency. */
  const marks = recap.html.match(/title="picked up in the blind"/g) ?? [];
  check("RecapModal marks exactly the two blind cards", marks.length === 2,
    `found ${marks.length}`);
  for (const c of finished.blind) {
    const face = `${c.rank}${engine.SUIT_SYM[c.suit]}`;
    check(`RecapModal marks ${face} as from the blind`,
      recap.html.includes(`${face}<span title="picked up in the blind"`));
  }
  check("RecapModal explains the blind mark in its key",
    recap.html.includes("= picked up in the blind"));

  // Nobody picked means nobody took the blind, and `g.blind` is still sitting
  // there populated — the state the guard in RecapModal exists for.
  const unpicked = await renders("RecapModal (nobody picked up the blind)",
    React.createElement(m.RecapModal,
      { g: { ...finished, picker: null, partner: null }, names: NAMES, mySeat: 0, grades: null, onBack() {}, onNext() {} }));
  check("RecapModal marks nothing when the blind was never taken",
    !unpicked.html.includes("picked up in the blind"));
  // The grade arrives from a worker, so the recap's first paint is always
  // ungraded. A crash here would only ever be seen by someone with a slow
  // phone, which is the worst possible way to find it.
  await renders("RecapModal (grade still pending)",
    React.createElement(m.RecapModal, { g: finished, names: NAMES, mySeat: 0, grades: { pending: true }, onBack() {}, onNext() {} }));
  await renders("RecapModal (no grades at all)",
    React.createElement(m.RecapModal, { g: finished, names: NAMES, mySeat: 0, grades: null, onBack() {}, onNext() {} }));
}

/* ======================================================================
   4. Header and decisions
   ==================================================================== */
{
  const h = await server.ssrLoadModule("/src/header.jsx");
  await renders("TableHeader (bare)", React.createElement(h.TableHeader, {}));
  await renders("TableHeader (rules, doubler, menu)",
    React.createElement(h.TableHeader, {
      rules: ["Call an ace", "Blitz"], doubler: 4,
      menuItems: [{ label: "Trump order", onClick() {} }, { label: "Last trick", onClick() {} }],
      status: "Gus is picking",
    }));

  const d = await server.ssrLoadModule("/src/decisions.jsx");
  await renders("CallButtons (no options)",
    React.createElement(d.CallButtons, { options: [], hand: midHand.hands[0], onCall() {} }));
  await renders("CallButtons (with options)",
    React.createElement(d.CallButtons, {
      options: [{ suit: "H", kind: "ace" }, { suit: "S", kind: "ace" }],
      hand: midHand.hands[0], onCall() {},
    }));
}

/* ======================================================================
   5. The screens

   The whole app, mounted the way a browser mounts it. App picks its screen
   off the URL, so both are reached by driving history rather than by calling
   an internal.
   ==================================================================== */
{
  const { default: App } = await server.ssrLoadModule("/src/App.jsx");

  dom.window.history.pushState({}, "", "/");
  const solo = await renders("App at / (solo game)", React.createElement(App));
  check("the solo screen produces markup", solo.html.length > 200, `${solo.html.length} chars`);

  dom.window.history.pushState({}, "", "/t/abcd1234");
  const table = await renders("App at /t/<code> (table)", React.createElement(App));
  check("the table screen produces markup", table.html.length > 100, `${table.html.length} chars`);
  dom.window.history.pushState({}, "", "/");
}
{
  const { default: Sheepshead } = await server.ssrLoadModule("/src/Sheepshead.jsx");
  const solo = await renders("Sheepshead (solo screen, direct)", React.createElement(Sheepshead));
  check("the solo screen renders a hand", solo.html.length > 200, `${solo.html.length} chars`);
}
{
  const { default: TableScreen } = await server.ssrLoadModule("/src/TableScreen.jsx");
  // Mounted with no live table: the arrival path, before any frame has come
  // back. This is the 0.45.0 rewrite CLAUDE.md flags as newest and least
  // exercised, and the state every joiner passes through.
  await renders("TableScreen (awaiting first frame)",
    React.createElement(TableScreen, { tableId: "abcd1234", onLeave() {} }));
}

/* -------------------------------- report -------------------------------- */
await server.close();

if (failures.length) {
  console.error(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAIL: ${f}`);
  console.error("FAIL — the UI throws where a build and a linter both see nothing wrong.");
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
console.log("PASS — every screen, modal and felt view mounts without throwing.");
