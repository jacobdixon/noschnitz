/* ============================================================================
   Routing.

   Two screens and no router library — this project has no dependencies beyond
   React, and adding one to switch on a single path segment isn't a trade worth
   making.

     /            the solo game, exactly as it has always been
     /t/<code>    a live table

   The rewrite in vercel.json sends every non-/api path to index.html so a
   texted /t/<code> link deep-links straight in (MP-1.3: "as easy as a Zoom
   link" — no app, no signup, works in a mobile browser).
   ========================================================================= */
import React, { useState, useEffect } from "react";
import { Analytics } from "@vercel/analytics/react";
import Sheepshead from "./Sheepshead.jsx";
import TableScreen from "./TableScreen.jsx";
import { felt, btnGold, btnPlain } from "./ui.jsx";
import { getPlayerId, getPlayerName, setPlayerName } from "./identity.js";
import * as api from "./api.js";
import { MULTIPLAYER_ENABLED } from "./flags.js";

const tableIdFromPath = () => {
  const m = window.location.pathname.match(/^\/t\/([A-Za-z0-9-]+)\/?$/);
  return m ? m[1] : null;
};

export default function App() {
  const [tableId, setTableId] = useState(tableIdFromPath);

  // Back/forward between the solo game and a table.
  useEffect(() => {
    const onPop = () => setTableId(tableIdFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (path, id) => {
    window.history.pushState({}, "", path);
    setTableId(id);
  };

  // Both entry points are gated, not just the menu. A table link that's
  // already been shared would otherwise still open on production, where there
  // is no store behind the API — which fails worse than not existing, because
  // it looks like the table was lost rather than never built.
  //
  // With the flag off at build time this whole branch is dead code and Vite
  // strips it, so the multiplayer client isn't in the production bundle at all.
  const screen =
    MULTIPLAYER_ENABLED && tableId
      ? <JoinGate tableId={tableId} onLeave={() => go("/", null)} />
      : <Home onTable={(id) => go(`/t/${id}`, id)} />;

  return (
    <>
      {screen}
      {/* Renders nothing. It sits at the root rather than inside either screen
          so a page view is counted once wherever someone lands — the solo game
          and a /t/<code> link are the same visit, and this component doesn't
          remount when navigating between them.

          Routing here is history.pushState with no router library, so the
          automatic route detection has nothing to hook into; the path is
          reported as-is. That is the behaviour we want anyway. A table code is
          a bearer credential — anyone holding the link can sit down — so
          collapsing /t/<code> to a single label is a feature, not a
          limitation. See the note in vercel.json's rewrite. */}
      <Analytics beforeSend={redactTableCode} />
    </>
  );
}

// Table codes never leave the browser. The link IS the credential, so a code in
// an analytics URL is a credential in a third party's logs — and the codes are
// short-lived and per-session, so the individual values are worth nothing to us
// anyway. What we actually want to know is "how many people opened a table
// link", which the collapsed form answers exactly.
function redactTableCode(event) {
  return { ...event, url: event.url.replace(/\/t\/[A-Za-z0-9-]+/, "/t/[code]") };
}

/* ---------------------------------------------------------------------------
   Everything below the link: name, then seated. MP-3.1 (no account, no
   password) and MP-3.2 (a returning guest on the same device is remembered,
   so the prompt is skipped entirely on a second visit).
   ------------------------------------------------------------------------ */
// One screen, used before creating a table and before sitting down at a new
// one. Prefilled from localStorage so a returning player doesn't retype
// anything — which is what MP-3.2 actually asked for. It was previously
// implemented as "never ask again", so the host was silently named "Host" and
// nobody could ever change what they were called.
function NameStep({ title, blurb, cta, initial, busy, err, onSubmit, onCancel }) {
  const [name, setName] = useState(initial || "");
  const ready = name.trim().length > 0;
  return (
    <Screen>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 28, fontWeight: 900, color: felt.brass, marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ color: felt.creamDim, marginBottom: 18, fontSize: 15, maxWidth: 320 }}>{blurb}</div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && ready && onSubmit(name)}
        placeholder="Your name"
        maxLength={24}
        autoFocus
        style={{
          width: "100%", maxWidth: 260, padding: "10px 12px", fontSize: 17,
          borderRadius: 8, border: `1px solid ${felt.brassDim}`,
          background: "#00000030", color: felt.cream, marginBottom: 14,
        }}
      />
      {err && <div style={{ color: felt.red, marginBottom: 12, maxWidth: 300 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10 }}>
        <button style={btnGold} disabled={busy || !ready} onClick={() => onSubmit(name)}>
          {busy ? "One moment…" : cta}
        </button>
        {onCancel && <button style={btnPlain} onClick={onCancel}>Back</button>}
      </div>
    </Screen>
  );
}

function JoinGate({ tableId, onLeave }) {
  const playerId = getPlayerId();
  const [phase, setPhase] = useState("checking"); // checking | naming | joined | error
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // The distinction that was missing before. RETURNING to a seat you already
  // hold — a refresh, a reconnect, coming back after stepping away — must be
  // seamless and silent. ARRIVING somewhere you have no seat is the moment to
  // ask who you are, every time, because it's the only moment the answer can
  // still be changed without it feeling like a settings screen.
  //
  // Previously any player with a remembered name was auto-joined at both, so
  // there was no point at which a name could be chosen or corrected.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getState(tableId, playerId);
        if (cancelled) return;
        if (res?.table?.you >= 0) {
          setPhase("joined"); // already ours — straight in
          return;
        }
        setPhase("naming");
      } catch (e) {
        if (cancelled) return;
        if (e.code === "no-such-table") {
          setErr("That table has expired. Tables only last as long as the session.");
          setPhase("error");
          return;
        }
        // Anything else (offline, a blip): let them try to sit down anyway
        // rather than blocking on a check that is only an optimisation.
        setPhase("naming");
      }
    })();
    return () => { cancelled = true; };
  }, [tableId, playerId]);

  const join = async (displayName) => {
    setBusy(true);
    setErr(null);
    try {
      const clean = setPlayerName(displayName);
      const res = await api.joinTable(tableId, playerId, clean);
      if (res.status === "full") {
        setErr("That table is full — five people are already playing.");
        return;
      }
      setPhase("joined");
    } catch (e) {
      setErr(e.code === "no-such-table"
        ? "That table has expired. Tables only last as long as the session."
        : e.message);
    } finally {
      setBusy(false);
    }
  };

  // Rejoining after being removed goes back through the name step rather than
  // silently re-seating: they may want a different name, and the table may be
  // full, which the join route reports properly.
  if (phase === "joined") {
    return (
      <TableScreen
        tableId={tableId}
        playerId={playerId}
        onRejoin={() => { setErr(null); setPhase("naming"); }}
      />
    );
  }

  if (phase === "checking") {
    return <Screen><div style={{ color: felt.creamDim }}>Finding the table…</div></Screen>;
  }

  if (phase === "error") {
    return (
      <Screen>
        <div style={{ color: felt.red, marginBottom: 16, maxWidth: 320 }}>{err}</div>
        <button style={btnPlain} onClick={onLeave}>Solo game</button>
      </Screen>
    );
  }

  return (
    <NameStep
      title="Join the table"
      blurb="Pick a name. That's it — no account, no password."
      cta={busy ? "Sitting down…" : "Sit down"}
      initial={getPlayerName()}
      busy={busy}
      err={err}
      onSubmit={join}
      onCancel={onLeave}
    />
  );
}

function Home({ onTable }) {
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // MP-1.1 is still one tap to a table — the name step is prefilled, so for a
  // returning host it's tap, tap. What it is NOT any more is silent: the host
  // used to be named the literal string "Host" because this flow never asked,
  // and that is the first thing everyone else sees on the roster.
  const create = async (displayName) => {
    setBusy(true);
    setErr(null);
    try {
      const playerId = getPlayerId();
      const clean = setPlayerName(displayName);
      const res = await api.createTable(playerId, clean);
      onTable(res.table.id);
    } catch (e) {
      setErr(e.message || "Couldn't create a table.");
      setBusy(false);
    }
  };

  if (naming) {
    return (
      <NameStep
        title="Play with friends"
        blurb="What should everyone call you? Empty seats are played by the AI, so you can start whenever you like."
        cta="Create the table"
        initial={getPlayerName()}
        busy={busy}
        err={err}
        onSubmit={create}
        onCancel={() => { setNaming(false); setErr(null); }}
      />
    );
  }

  // The entry point lives in the solo game's own header, next to Trump and
  // Scores. It was first floated over the bottom-left corner, which put a
  // translucent button directly on top of the player's own cards — visually
  // illegible against the cream card faces, and covering a card besides.
  return <Sheepshead onPlayWithFriends={MULTIPLAYER_ENABLED ? () => setNaming(true) : undefined} />;
}

function Screen({ children }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: felt.bg, color: felt.cream,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: 24, textAlign: "center",
    }}>
      {children}
    </div>
  );
}
