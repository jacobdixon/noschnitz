/* ============================================================================
   A browser, a clock, and an EventSource — enough of each to test the parts of
   this app that only exist inside one.

   Shared by scripts/tablestreamtest.mjs and scripts/rendertest.mjs. Everything
   in src/ that was at 0% coverage was there for the same reason: it needs a
   `document`, a `setTimeout` you can move, or an `EventSource` that answers.
   None of that is hard to provide; it just had to be provided once.

   THREE PIECES, and the second is the one with a sharp edge.

   installDom()      jsdom globals, hoisted to globalThis so `react-dom/client`
                     finds them. Note `navigator` is a getter-only global in
                     Node 22 — assigning it throws, so everything goes through
                     defineProperty.

   installClock()    setTimeout/clearTimeout you can advance by hand. The
                     reconnect logic in useTableStream is all timers — a 15s
                     backoff cap and a 75s silence watchdog — and a test that
                     waited them out in real time would take minutes and be
                     flaky at the end of it.

                     WHY THIS IS SAFE, since replacing setTimeout under React
                     usually is not: React 18's scheduler prefers MessageChannel
                     when there is a DOM, and jsdom provides one (verified — the
                     harness asserts it below rather than trusting it). So React
                     never reaches for the fake timers, and the fake timers only
                     ever hold the code under test. If a future React drops that
                     preference, the assertion in installClock is what will tell
                     you, instead of a mystery hang.

   installEventSource()
                     jsdom has no EventSource at all, which is convenient: there
                     is no real implementation to fight. Records every instance
                     so a test can assert on the URL a reconnect used — which is
                     the whole `since=` contract — and drive frames by hand.
   ========================================================================= */
import { JSDOM } from "jsdom";

const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });

export function installDom({ url = "https://noschnitz.test/" } = {}) {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url,
    pretendToBeVisual: true,
  });
  define("window", dom.window);
  // Hoisted individually rather than by copying the whole window: react-dom
  // looks these up on the global, and a blanket copy drags in getters that
  // throw when redefined.
  for (const k of [
    "document", "navigator", "HTMLElement", "Element", "Node", "Event", "CustomEvent",
    "MessageChannel", "MessagePort", "localStorage", "sessionStorage", "getComputedStyle",
    "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "DOMParser", "SVGElement",
  ]) {
    if (dom.window[k] !== undefined) define(k, dom.window[k]);
  }
  // React refuses to run `act` without this, and warns loudly without it.
  define("IS_REACT_ACT_ENVIRONMENT", true);
  return dom;
}

/* --------------------------------- clock --------------------------------- */
export function installClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };

  // If React ever starts scheduling on setTimeout, the fake clock would hold
  // React's own work and `act` would hang waiting for it. Better to say so.
  if (typeof globalThis.MessageChannel !== "function") {
    throw new Error(
      "installClock: no MessageChannel on the global, so React's scheduler will fall back to " +
      "setTimeout and the fake clock will swallow React's own work. Call installDom() first."
    );
  }

  let now = 0;
  let seq = 0;
  const timers = new Map();

  define("setTimeout", (fn, ms = 0, ...args) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, ms), fn, args, seq: id });
    return id;
  });
  define("clearTimeout", (id) => { timers.delete(id); });

  return {
    get now() { return now; },
    get pending() { return timers.size; },
    /* Advance `ms`, firing every timer that comes due, in time order. A timer
       that schedules another timer inside the window fires too — that is the
       reconnect loop's whole shape, and stopping at a snapshot would test
       something the browser never does. */
    async advance(ms, wrap = async (f) => f()) {
      const target = now + ms;
      await wrap(async () => {
        for (;;) {
          const due = [...timers.values()]
            .filter((t) => t.at <= target)
            .sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
          if (!due.length) break;
          const t = due[0];
          timers.delete(t.seq);
          now = Math.max(now, t.at);
          t.fn(...t.args);
          // Let promise callbacks (React state flushes) settle between timers.
          await Promise.resolve();
        }
        now = target;
      });
    },
    uninstall() { define("setTimeout", real.setTimeout); define("clearTimeout", real.clearTimeout); },
  };
}

/* ------------------------------ EventSource ------------------------------ */
export function installEventSource() {
  const instances = [];

  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.onopen = null;
      this.onerror = null;
      this._listeners = new Map();
      instances.push(this);
    }

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }

    close() { this.closed = true; this.readyState = 2; }

    /* ---- drive it from a test ---- */

    // The server's first act on a healthy connection.
    fireOpen() { this.readyState = 1; this.onopen?.(); }

    // `data` is serialised exactly as the wire would, because the hook parses
    // it — passing an object straight through would skip the JSON.parse the
    // code actually runs, including its try/catch.
    emit(type, data) {
      const ev = { data: typeof data === "string" ? data : JSON.stringify(data) };
      for (const fn of this._listeners.get(type) ?? []) fn(ev);
    }

    // readyState 2 (CLOSED) is the failure that will not recover on its own;
    // 0 (CONNECTING) is the browser already retrying. The hook logs which.
    fireError({ readyState = 2 } = {}) { this.readyState = readyState; this.onerror?.(); }

    get params() { return new URL(this.url, "https://noschnitz.test").searchParams; }
    get since() { const s = this.params.get("since"); return s === null ? null : Number(s); }
  }

  define("EventSource", FakeEventSource);
  return {
    instances,
    get last() { return instances[instances.length - 1]; },
    get count() { return instances.length; },
    reset() { instances.length = 0; },
  };
}

/* ------------------------------ visibility ------------------------------- */
// jsdom's visibilityState is read-only and driven by nothing, so the tab-away
// case — the one this hook exists for — has to be simulated directly.
export function setVisibility(dom, state) {
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: state, writable: true, configurable: true,
  });
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
}
