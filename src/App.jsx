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
import Sheepshead from "./Sheepshead.jsx";
import TableScreen from "./TableScreen.jsx";
import { felt, btnGold, btnPlain } from "./ui.jsx";
import { getPlayerId, getPlayerName, setPlayerName } from "./identity.js";
import * as api from "./api.js";

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

  if (tableId) return <JoinGate tableId={tableId} onLeave={() => go("/", null)} />;
  return <Home onTable={(id) => go(`/t/${id}`, id)} />;
}

/* ---------------------------------------------------------------------------
   Everything below the link: name, then seated. MP-3.1 (no account, no
   password) and MP-3.2 (a returning guest on the same device is remembered,
   so the prompt is skipped entirely on a second visit).
   ------------------------------------------------------------------------ */
function JoinGate({ tableId, onLeave }) {
  const playerId = getPlayerId();
  const remembered = getPlayerName();
  const [name, setName] = useState(remembered);
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Join is idempotent server-side: a returning player reclaims the seat they
  // already hold rather than consuming a second one, so it's safe to fire on
  // every mount without checking first.
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
      setJoined(true);
    } catch (e) {
      setErr(e.code === "no-such-table"
        ? "That table has expired. Tables only last as long as the session."
        : e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (remembered) join(remembered);
    // Mount only: re-running on every keystroke would spam the join route.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (joined) return <TableScreen tableId={tableId} playerId={playerId} playerName={name} />;

  return (
    <Screen>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 28, fontWeight: 900, color: felt.brass, marginBottom: 6 }}>
        Join the table
      </div>
      <div style={{ color: felt.creamDim, marginBottom: 18, fontSize: 15 }}>
        Pick a name. That's it — no account.
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && join(name)}
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
        <button style={btnGold} disabled={busy || !name.trim()} onClick={() => join(name)}>
          {busy ? "Sitting down…" : "Sit down"}
        </button>
        <button style={btnPlain} onClick={onLeave}>Solo game</button>
      </div>
    </Screen>
  );
}

function Home({ onTable }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // MP-1.1 — one click to a table, no setup, no configuration screen.
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const playerId = getPlayerId();
      const name = getPlayerName() || "Host";
      setPlayerName(name);
      const res = await api.createTable(playerId, name);
      onTable(res.table.id);
    } catch (e) {
      setErr(e.message || "Couldn't create a table.");
      setBusy(false);
    }
  };

  return (
    <>
      <Sheepshead />
      {/* Floated over the solo game rather than pushed into its layout, which
          is a locked no-scroll viewport with no room to spare. */}
      <div style={{ position: "fixed", left: 10, bottom: 10, zIndex: 15 }}>
        <button
          style={{ ...btnPlain, fontSize: 14, padding: "7px 12px", opacity: 0.92 }}
          disabled={busy}
          onClick={create}
        >
          {busy ? "Setting up…" : "Play with friends"}
        </button>
        {err && (
          <div style={{ color: felt.red, fontSize: 12, marginTop: 6, maxWidth: 200 }}>{err}</div>
        )}
      </div>
    </>
  );
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
