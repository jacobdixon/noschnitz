/* ============================================================================
   The live multiplayer table — MP-1, MP-2, MP-3.

   Renders entirely from the server's redacted view. There is no local game
   state here and there must not be: `table.g` arrived as viewFor(g, mySeat),
   so other players' hands are literally absent rather than hidden by CSS. Any
   attempt to compute something from a hand that isn't yours will find `null`,
   which is the intended failure.

   Deliberately NOT sharing state with Sheepshead.jsx. That file is the solo
   game, still live on noschnitz.com and driving its own engine loop locally.
   Solo eventually becomes the 1-human + 4-AI case of this screen (MP-2.4), but
   converging them now would put a network round trip behind every card in a
   game that currently works offline — and destabilise the thing that's
   shipped while this half is still being built.

   Seat geometry: the server's seat indices are absolute (seat 0 is whoever
   created the table). Players expect to sit at the bottom of their own screen,
   so every seat is rotated by `mySeat` for display — see `rotate()`.
   ========================================================================= */
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { SUIT_SYM, SUIT_NAME, cid, cardPts, legalPlays, makeDeck, isTrump, trumpPower, trickWinner } from "./engine.js";
import { felt, Card, Badge, Modal, btnGold, btnPlain, btnGhost } from "./ui.jsx";
import { useTableStream } from "./useTableStream.js";
import { usePacedTrick } from "./usePacedTrick.js";
import { fanOverlap } from "./fan.js";
import { idleMs, isBootable, AWAY_AFTER_MS } from "./table.js";
import * as api from "./api.js";

const SEATS = 5;

// Derived, never hand-written: a hardcoded list is a second source of truth for
// the rules and would quietly go stale if trump ever changed.
const TRUMP_ORDER = makeDeck().filter(isTrump).sort((a, b) => trumpPower(b) - trumpPower(a));

// Reserved height for the status + action block. Without it the felt reflows
// every time a button appears or disappears, and the whole play area jumps as
// the last card of a trick lands (#33). Solo has always reserved this space.
const ACTION_MIN_HEIGHT = 84;

// Show an idle hint well before the seat becomes bootable, so the table sees
// somebody drifting rather than being surprised by a Boot button.
const IDLE_HINT_MS = 45_000;

// Re-renders once a second so idle counters advance. Only mounted while a table
// is on screen.
function useTick(ms = 1000) {
  const [, bump] = useState(0);
  useEffect(() => {
    const t = setInterval(() => bump((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

// `lastSeen` is stamped with the SERVER's clock. Comparing it against the
// browser's Date.now() shows nonsense the moment the two disagree — and phones
// with a slow clock disagree by minutes, which would either hide idle players
// or offer to boot people who just sat down. `updatedAt` gives us a reading of
// the server clock on every update, so the difference is the skew, and idle
// times are computed in the server's frame.
function useServerNow(table) {
  const [skew, setSkew] = useState(0);
  const stamp = table?.updatedAt;
  useEffect(() => {
    if (stamp) setSkew(Date.now() - stamp);
  }, [stamp]);
  return () => Date.now() - skew;
}

function formatIdle(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

// Absolute seat -> screen position, with the viewer always at the bottom.
const rotate = (seat, mySeat) => (mySeat < 0 ? seat : (seat - mySeat + SEATS) % SEATS);

// Horizontal padding on the hand row, subtracted from the viewport to get the
// width the fan actually has to fit inside.
const HAND_PADDING = 12;

// Tracks viewport width so the fan re-tightens on rotation and resize. The
// table is position:fixed inset:0, so the viewport IS the container.
function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 375 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return w;
}

// Both tables below are lifted verbatim from the solo game, by screen position
// rather than absolute seat. They are already tuned so avatars and played
// cards don't collide at phone sizes — an earlier attempt here invented its
// own percentages and put the trick pile straight on top of the side seats.
//
// The important one is TRICK_POS: a played card lands pulled inward from its
// own player's seat, so you can see at a glance who played what. Rendering the
// trick as a neutral centred row loses that, and with it most of the
// readability of the game.
const SEAT_POS = {
  1: { left: "2%", top: "46%" },
  2: { left: "20%", top: "4%" },
  3: { right: "20%", top: "4%" },
  4: { right: "2%", top: "46%" },
};
const TRICK_POS = {
  0: { left: "50%", top: "72%", transform: "translate(-50%,-50%)" },
  1: { left: "22%", top: "50%", transform: "translate(-50%,-50%)" },
  2: { left: "38%", top: "26%", transform: "translate(-50%,-50%)" },
  3: { left: "62%", top: "26%", transform: "translate(-50%,-50%)" },
  4: { left: "78%", top: "50%", transform: "translate(-50%,-50%)" },
};

function Avatar({ seat, table, isTurn, serverNow, onClick }) {
  const s = table.seats[seat];
  const idle = serverNow ? idleMs(table, seat, serverNow()) : 0;
  const showIdle = idle > IDLE_HINT_MS && s.kind !== "ai";
  const g = table.g;
  const initial = (s.name || "?").trim()[0]?.toUpperCase() || "?";
  const isPicker = g && g.picker === seat;
  const isPartner = g && g.partner === seat;

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
        cursor: onClick ? "pointer" : "default",
        WebkitTapHighlightColor: "transparent", touchAction: "manipulation",
      }}
    >
      <div style={{
        width: 46, height: 46, borderRadius: "50%", background: felt.chip,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "Georgia, serif", fontSize: 20, fontWeight: 800, color: felt.cream,
        border: `2px solid ${isTurn ? felt.brass : "#ffffff22"}`,
        boxShadow: isTurn ? `0 0 12px ${felt.brass}` : "none",
      }}>{initial}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: felt.cream, whiteSpace: "nowrap" }}>
        {s.name}
      </div>
      <div style={{ fontSize: 10, color: felt.creamDim, whiteSpace: "nowrap" }}>
        {/* MP-2.2 which seats are people vs house AI, and COM-3.3 the third
            case: a real player's seat the AI is covering while they're away.
            Worth distinguishing — "Dave is being covered" and "Dave was never
            here" are different social facts at a card table. */}
        {s.kind === "ai" ? "AI" : s.kind === "away" ? "away · AI" : "•"}{" "}
        {g ? `${g.handCounts?.[seat] ?? 0}🂠` : ""}
      </div>
      {showIdle && (
        <div style={{ fontSize: 10, color: idle > AWAY_AFTER_MS ? felt.red : felt.creamDim }}>
          idle {formatIdle(idle)}
        </div>
      )}
      {isPicker && <Badge gold compact>Picker</Badge>}
      {isPartner && <Badge gold compact>Partner</Badge>}
    </div>
  );
}

/* ------------------------- Sharing the table link -------------------------- */

// MP-1.2/1.3. navigator.share is preferred on phones because it opens Messages
// directly, which is where this group actually coordinates; clipboard is the
// desktop fallback.
function useShareLink(tableId) {
  const [copied, setCopied] = useState(false);
  const url = api.tableUrl(tableId);
  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "Sheepshead", text: "Join my table", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* user dismissed the share sheet */ }
  };
  return { url, share, copied };
}

function ShareRow({ tableId }) {
  const { url, share, copied } = useShareLink(tableId);
  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "center",
      background: "#00000030", borderRadius: 8, padding: "8px 10px",
    }}>
      <code style={{
        flex: 1, fontSize: 13, color: felt.creamDim,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{url}</code>
      <button style={btnGhost} onClick={share}>{copied ? "Copied" : "Share"}</button>
    </div>
  );
}

/* ------------------------------- The lobby -------------------------------- */

function Lobby({ table, mySeat, onStart, busy, err }) {
  const humans = table.seats.filter((s) => s.kind === "human").length;

  return (
    <div style={{ padding: 20, color: felt.cream, maxWidth: 460, margin: "0 auto" }}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 26, fontWeight: 900, color: felt.brass }}>
        Your table
      </div>
      <div style={{ fontSize: 14, color: felt.creamDim, marginBottom: 14 }}>
        Send the link. Empty seats are played by the AI, so you can start whenever
        you like — nobody has to wait for a fifth.
      </div>

      <ShareRow tableId={table.id} />

      <div style={{ marginTop: 18, marginBottom: 8, fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: felt.creamDim }}>
        At the table — {humans} {humans === 1 ? "person" : "people"}
      </div>
      {table.seats.map((s, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 0",
          borderBottom: "1px solid #ffffff18",
        }}>
          <span style={{ fontWeight: i === mySeat ? 800 : 500 }}>{s.name}</span>
          {i === mySeat && <Badge>You</Badge>}
          {s.kind === "ai" && <Badge>AI</Badge>}
          {i === table.hostSeat && <Badge gold>Host</Badge>}
        </div>
      ))}

      {/* MP-2.3 — queued players are visible so the table knows they're there. */}
      {table.pendingJoins?.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: felt.creamDim }}>
          {table.pendingJoins.map((p) => p.name).join(", ")} joining next hand
        </div>
      )}

      {err && <div style={{ color: felt.red, marginTop: 12, fontSize: 14 }}>{err}</div>}

      {table.youAreHost ? (
        <button style={{ ...btnGold, marginTop: 18, width: "100%" }} disabled={busy} onClick={onStart}>
          {busy ? "Dealing…" : "Deal the first hand"}
        </button>
      ) : (
        <div style={{ marginTop: 18, fontSize: 14, color: felt.creamDim }}>
          Waiting for {table.seats[table.hostSeat]?.name || "the host"} to deal…
        </div>
      )}
    </div>
  );
}


/* --------------------------------- Modals --------------------------------- */

// #34 — the table had no way to check what beats what. Derived from the engine,
// so it can't drift from the rules it documents.
function TrumpModal({ onClose }) {
  return (
    <Modal maxWidth={420} onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
        Trump, high to low
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 12 }}>
        Every Queen, then every Jack, then the diamonds. Everything else is a
        fail suit.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 14 }}>
        {TRUMP_ORDER.map((c) => (
          <span key={cid(c)} style={{
            fontSize: 14, fontWeight: 700, padding: "3px 6px", borderRadius: 4,
            background: "#00000035",
            color: c.suit === "H" || c.suit === "D" ? felt.red : felt.cream,
          }}>{c.rank}{SUIT_SYM[c.suit]}</span>
        ))}
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 14 }}>
        Card points: A 11 · 10 10 · K 4 · Q 3 · J 2 · 9/8/7 nothing. 120 in the
        deck; the picker's team needs 61.
      </div>
      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

// #34 — running scores, which previously existed nowhere on the table screen.
function ScoresModal({ table, onClose, onRename, busy }) {
  const mySeat = table.you;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mySeat >= 0 ? table.seats[mySeat]?.name || "" : "");

  return (
    <Modal onClose={onClose}>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 2 }}>
        {table.handNum > 0 ? `After hand ${table.handNum}` : "Not started"}
      </div>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>
        Scores
      </div>
      <table style={{ width: "100%", fontSize: 16, borderCollapse: "collapse", marginBottom: 14 }}>
        <tbody>
          {table.seats.map((s, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #ffffff18" }}>
              <td style={{ padding: "6px 0", fontWeight: s.isYou ? 800 : 500 }}>
                {s.name} {s.isYou && <Badge compact>You</Badge>}
              </td>
              <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700 }}>
                {table.scores[i] >= 0 ? "+" : ""}{table.scores[i]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Changing your name lives here because this is the one screen that
          already lists everybody by name — it's where you notice yours is
          wrong. Server-side it goes through the same collision rule as
          joining. */}
      {mySeat >= 0 && (editing ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && draft.trim() && onRename(draft)}
            maxLength={24}
            autoFocus
            style={{
              flex: 1, minWidth: 0, padding: "8px 10px", fontSize: 16, borderRadius: 8,
              border: `1px solid ${felt.brassDim}`, background: "#00000030", color: felt.cream,
            }}
          />
          <button style={btnGold} disabled={busy || !draft.trim()} onClick={() => onRename(draft)}>
            Save
          </button>
        </div>
      ) : (
        <button style={{ ...btnGhost, marginBottom: 14 }} onClick={() => setEditing(true)}>
          Change my name
        </button>
      ))}

      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

// #30 — with tricks now sweeping off the felt correctly, the last trick is gone
// the moment it ends. Solo has always let you look back at it; this restores
// that for the table, laid out by seat position the way the felt is.
function LastTrickModal({ table, mySeat, onClose }) {
  const lt = table.g?.lastTrick;
  if (!lt) return null;
  const winner = lt.winner;
  const leader = lt.trick[0]?.player;
  const pts = lt.trick.reduce((n, t) => n + cardPts(t.card), 0);

  return (
    <Modal maxWidth={420} onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>
        Last trick
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center", marginBottom: 12 }}>
        {lt.trick.map((t) => (
          <div key={cid(t.card)} style={{ textAlign: "center", minWidth: 60 }}>
            <Card card={t.card} small />
            <div style={{
              fontSize: 12, marginTop: 4, whiteSpace: "nowrap",
              fontWeight: t.player === winner ? 800 : 500,
              color: t.player === winner ? felt.brass : felt.creamDim,
              borderBottom: t.player === leader ? `2px solid ${felt.brass}` : "2px solid transparent",
            }}>
              {t.player === mySeat ? "You" : table.seats[t.player]?.name}
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 14 }}>
        <span style={{ color: felt.brass, fontWeight: 700 }}>
          {winner === mySeat ? "You" : table.seats[winner]?.name}
        </span>{" "}
        took it for {pts} {pts === 1 ? "point" : "points"} · underline = led
      </div>
      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

// #31 — the link was only reachable from the lobby, so once a hand was dealt
// there was no way to invite anyone, despite MP-2.3 supporting joining mid-hand.
function InviteModal({ table, onClose }) {
  return (
    <Modal maxWidth={420} onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
        Invite
      </div>
      <div style={{ fontSize: 14, color: felt.creamDim, marginBottom: 12 }}>
        Anyone who joins now takes an AI seat at the start of the next hand — the
        hand in progress isn't disturbed.
      </div>
      <div style={{ marginBottom: 14 }}><ShareRow tableId={table.id} /></div>
      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

// Tapping a seat. Today it holds presence and the boot control; it's also the
// natural home for a profile link and lifetime stats once players are more than
// a localStorage token.
function PlayerModal({ table, seat, serverNow, onBoot, onClose, busy, err }) {
  const s = table.seats[seat];
  if (!s) return null;
  const idle = idleMs(table, seat, serverNow());
  const bootable = isBootable(table, seat, serverNow());
  const isMe = seat === table.you;

  const kindLabel =
    s.kind === "ai" ? "Played by the house AI"
      : s.kind === "away" ? "Stepped away — the AI is covering this seat"
        : "Playing";

  return (
    <Modal onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 900, color: felt.brass, marginBottom: 2 }}>
        {s.name}
      </div>
      <div style={{ fontSize: 14, color: felt.creamDim, marginBottom: 10 }}>
        {kindLabel}{isMe ? " · this is you" : ""}
      </div>

      {s.kind !== "ai" && (
        <div style={{ fontSize: 14, color: idle > AWAY_AFTER_MS ? felt.red : felt.creamDim, marginBottom: 14 }}>
          {idle > IDLE_HINT_MS ? `Last seen ${formatIdle(idle)} ago` : "Here now"}
        </div>
      )}

      {/* The error has to live in here. It used to render in a bar between the
          felt and the actions — underneath this modal's overlay — so a refused
          boot ("they just checked back in") looked like a button that did
          nothing at all. */}
      {err && (
        <div style={{
          background: "#00000040", color: felt.red, fontSize: 13,
          padding: "8px 10px", borderRadius: 8, marginBottom: 12,
        }}>{err}</div>
      )}

      {!isMe && s.kind !== "ai" && (
        bootable ? (
          <>
            <button style={{ ...btnGold, marginBottom: 8 }} disabled={busy} onClick={() => onBoot(seat)}>
              {busy ? "Removing…" : `Remove ${s.name}`}
            </button>
            <div style={{ fontSize: 12, color: felt.creamDim, marginBottom: 14 }}>
              Frees the seat for someone else. Not a ban — they can rejoin with
              the table link and take any open seat.
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: felt.creamDim, marginBottom: 14 }}>
            You can free this seat once they've been away for a while.
          </div>
        )
      )}

      <button style={btnPlain} onClick={onClose}>Close</button>
    </Modal>
  );
}

/* --------------------------------- Table ---------------------------------- */

export default function TableScreen({ tableId, playerId, onRejoin }) {
  const { table, connected, error } = useTableStream(tableId, playerId);
  // Called before any early return — hooks can't be conditional, and the
  // paced cursor has to keep running while the rest of the screen decides
  // what to render.
  const frame = usePacedTrick(table?.g);
  const caughtUp = frame.caughtUp;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState([]);

  // Your own card, drawn on the felt the instant you tap it rather than after
  // the round trip. Playing a card was POST -> server -> stream -> render
  // before anything moved, so the card sat in your hand for the length of a
  // network hop and the tap felt broken. The server is still the authority —
  // this is only a stand-in until the real card comes back down the stream,
  // and an illegal play is rejected and the stand-in withdrawn.
  const [optimistic, setOptimistic] = useState(null);
  const viewportWidth = useViewportWidth();
  const [modal, setModal] = useState(null); // "trump" | "scores" | "lastTrick" | "invite"
  const [seatModal, setSeatModal] = useState(null);
  const serverNow = useServerNow(table);
  useTick(1000);

  // Retire the stand-in once the genuine card has been REVEALED (not merely
  // received): dropping it as soon as the server confirms would blink the card
  // out and back in while the paced cursor caught up to it.
  useEffect(() => {
    if (optimistic && frame.revealedIds?.has(cid(optimistic.card))) setOptimistic(null);
  }, [optimistic, frame.revealedIds]);

  // A new hand invalidates any stand-in still hanging around.
  useEffect(() => {
    setOptimistic(null);
  }, [table?.g?.handNum]);

  // Any action can lose a compare-and-swap. When it does, the winning state is
  // already on its way down the stream, so surfacing the conflict as an error
  // would flash a scary message at something that self-heals.
  const act = useCallback(async (fn) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      if (e.code !== "conflict") setErr(e.message || "That didn't work.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (error) {
    return <Centered>{error}</Centered>;
  }
  if (!table) {
    return <Centered>{connected ? "Loading the table…" : "Connecting…"}</Centered>;
  }

  const mySeat = table.you;
  const g = table.g;

  // No seat. Two very different situations that used to render the same
  // message: someone waiting for the next hand, and someone whose seat was
  // reclaimed. Telling a removed player "you'll be seated at the start of the
  // next hand" is simply false — they aren't in the queue, so nothing will
  // ever seat them, and the screen offered no way back.
  if (mySeat < 0) {
    const queued = (table.pendingJoins || []).some((p) => p.isYou);
    const seatsFree = table.seats.some((s) => s.kind === "ai");
    return (
      <Centered>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 900, color: felt.brass, marginBottom: 8 }}>
          {queued ? "You're in the queue" : "You're not at the table"}
        </div>
        <div style={{ fontSize: 14, color: felt.creamDim, marginBottom: 18, maxWidth: 320 }}>
          {queued
            ? "You'll be seated at the start of the next hand."
            : seatsFree
              ? "Your seat was given up or reclaimed. There's room — you can sit back down."
              : "Your seat was given up or reclaimed, and the table is full right now."}
        </div>
        {!queued && (
          <div style={{ display: "flex", gap: 10 }}>
            {onRejoin && (
              <button style={btnGold} onClick={onRejoin}>
                {seatsFree ? "Sit back down" : "Join when a seat opens"}
              </button>
            )}
          </div>
        )}
        {queued && table.g && (
          <div style={{ fontSize: 13, color: felt.creamDim }}>Hand {table.g.handNum} in progress…</div>
        )}
      </Centered>
    );
  }

  if (!g) {
    return (
      <Lobby
        table={table}
        mySeat={mySeat}
        busy={busy}
        err={err}
        onStart={() => act(() => api.startHand(tableId, playerId))}
      />
    );
  }

  // The optimistic card leaves your hand immediately; once the server confirms,
  // its own copy of your hand no longer contains it and this filter is a no-op.
  const myHand = (g.hands[mySeat] || []).filter(
    (c) => !(optimistic && cid(c) === cid(optimistic.card))
  );
  // Tightens for the picker's 8-card bury view and loosens again once two are
  // buried. A fixed overlap fits six and clips eight — see src/fan.js.
  const handOverlap = fanOverlap(myHand.length, viewportWidth - HAND_PADDING);
  // `caughtUp` gates every affordance: until the table has finished showing
  // what everyone else played, your cards aren't live. Otherwise you can play
  // into a trick that visually has two cards in it and watch your own card
  // appear before theirs.
  const isMyTurn = g.phase === "playing" && g.turn === mySeat && caughtUp;
  const legal = isMyTurn ? legalPlays(g, mySeat).map(cid) : [];

  const onCardClick = (card) => {
    if (g.phase === "bury") {
      // Two to bury, then the call.
      setSelected((cur) =>
        cur.some((c) => cid(c) === cid(card))
          ? cur.filter((c) => cid(c) !== cid(card))
          : cur.length < 2 ? [...cur, card] : cur
      );
      return;
    }
    if (!isMyTurn || !legal.includes(cid(card))) return;
    setOptimistic({ card, player: mySeat });
    act(async () => {
      try {
        await api.playCard(tableId, playerId, card);
      } catch (e) {
        // Rejected or unreachable — take the stand-in back off the table so the
        // card returns to your hand rather than being stranded on the felt.
        setOptimistic(null);
        throw e;
      }
    });
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: felt.bg, color: felt.cream,
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Header (#34). Deliberately terse labels: the solo header already holds
          429px of content in 363px at phone width, and this row carries three
          buttons plus the table code. Measured after building, not assumed. */}
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "center", gap: 6,
        padding: "8px 10px", borderBottom: `2px solid ${felt.rail}`,
      }}>
        <div style={{
          display: "flex", alignItems: "baseline", gap: 5,
          minWidth: 0, flex: 1, overflow: "hidden",
        }}>
          <span style={{
            fontFamily: "Georgia, serif", fontWeight: 900, letterSpacing: ".06em",
            fontSize: 14, color: felt.brass, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis", minWidth: 0,
          }}>{table.id}</span>
          {/* Same treatment as the solo header: small and dim enough to ignore
              while playing, legible enough to read off a screenshot when
              someone reports a bug against a particular build. flexShrink 0 so
              the table code truncates before the version does — the version is
              the part that has to stay readable. */}
          <span style={{
            fontSize: 9, opacity: 0.4, letterSpacing: ".02em",
            userSelect: "none", whiteSpace: "nowrap", flexShrink: 0,
          }}>v{__APP_VERSION__}</span>
        </div>
        <button style={btnGhost} onClick={() => setModal("invite")}>Invite</button>
        <button style={btnGhost} onClick={() => setModal("trump")}>Trump</button>
        <button style={btnGhost} onClick={() => setModal("scores")}>Scores</button>
      </div>

      {/* Contract strip */}
      <div style={{
        flexShrink: 0, padding: "6px 12px", fontSize: 13, color: felt.creamDim,
        borderBottom: `1px solid ${felt.rail}`, display: "flex", gap: 10, alignItems: "center",
      }}>
        <span style={{ fontWeight: 700 }}>Hand {g.handNum}</span>
        {g.picker !== null && <span>{table.seats[g.picker].name} picked</span>}
        {g.calledSuit && (
          <span style={{ color: felt.brass, fontWeight: 700 }}>
            {SUIT_SYM[g.calledSuit]} {SUIT_NAME[g.calledSuit]}
          </span>
        )}
        {g.alone && <Badge compact>Alone</Badge>}
        <span style={{ marginLeft: "auto", opacity: connected ? 0 : 1, transition: "opacity .3s" }}>
          reconnecting…
        </span>
      </div>

      {/* Felt — absolute positions matching the solo game, rotated so you are
          always at the bottom. */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {table.seats.map((_, seat) => {
          const pos = SEAT_POS[rotate(seat, mySeat)];
          if (!pos) return null; // position 0 is you — rendered as your hand
          return (
            <div key={seat} style={{
              position: "absolute", ...pos, width: 84,
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
            }}>
              <Avatar
                seat={seat}
                table={table}
                isTurn={g.turn === seat && caughtUp}
                serverNow={serverNow}
                onClick={() => setSeatModal(seat)}
              />
            </div>
          );
        })}

        {/* Each card sits by the player who played it, revealed one at a time.
            The optimistic stand-in joins them until the real card is revealed
            — suppressed once the trick has been swept, so a card you played
            can't reappear on an empty felt. */}
        {[
          ...frame.cards,
          ...(optimistic && !frame.cleared && !frame.cards.some((p) => cid(p.card) === cid(optimistic.card))
            ? [optimistic]
            : []),
        ].map((p) => (
          <div key={cid(p.card)} style={{
            position: "absolute", ...TRICK_POS[rotate(p.player, mySeat)], zIndex: 2,
          }}>
            <Card card={p.card} small />
          </div>
        ))}

        {frame.complete && (
          <div style={{
            position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
            background: "#000000aa", padding: "4px 12px", borderRadius: 6,
            fontSize: 16, fontWeight: 700, color: felt.brass, zIndex: 3,
          }}>
            {table.seats[frame.winner]?.name} +{frame.cards.reduce((s, p) => s + cardPts(p.card), 0)}
          </div>
        )}

        {/* Blind marker while nobody has picked yet, as in the solo game. */}
        {g.phase === "picking" && (
          <div style={{
            position: "absolute", left: "50%", top: "44%", transform: "translate(-50%,-50%)",
            display: "flex", gap: 6,
          }}>
            <Card faceDown small /><Card faceDown small />
          </div>
        )}

        <div style={{
          position: "absolute", bottom: 6, left: 0, right: 0, textAlign: "center",
          fontStyle: "italic", color: felt.creamDim, fontSize: 15,
        }}>
          {caughtUp ? statusLine(g, table, mySeat, isMyTurn) : " "}
        </div>
      </div>

      {err && (
        <div style={{ background: "#00000040", color: felt.red, padding: "6px 12px", fontSize: 13 }}>
          {err}
        </div>
      )}

      {/* Decisions. The reserved height is the fix for #33: these rows appear
          and disappear as a hand progresses, and without a floor the felt above
          resized every time — most visibly as the last card of a trick landed
          and the deal button arrived. */}
      <div style={{ flexShrink: 0, minHeight: ACTION_MIN_HEIGHT }}>
      {g.phase === "picking" && g.pickTurn === mySeat && (
        <Actions>
          <button style={btnGold} disabled={busy} onClick={() => act(() => api.pick(tableId, playerId, "pick"))}>
            Pick
          </button>
          <button style={btnPlain} disabled={busy} onClick={() => act(() => api.pick(tableId, playerId, "pass"))}>
            Pass
          </button>
        </Actions>
      )}

      {g.phase === "bury" && g.picker === mySeat && (
        <BuryBar
          g={g}
          mySeat={mySeat}
          selected={selected}
          busy={busy}
          onConfirm={(calledSuit) =>
            act(async () => {
              await api.bury(tableId, playerId, selected, calledSuit);
              setSelected([]);
            })
          }
        />
      )}

      {/* Held back until the final trick has finished playing out — otherwise
          the deal button appears while the last card is still landing. */}
      {g.phase === "handEnd" && caughtUp && table.youAreHost && (
        <Actions>
          <button style={btnGold} disabled={busy} onClick={() => act(() => api.startHand(tableId, playerId))}>
            Deal next hand
          </button>
        </Actions>
      )}

      </div>

      {/* #30 — tricks now sweep off the felt correctly, so the previous trick is
          gone the instant it ends. Solo has always offered a look back. */}
      {/* Fixed height for the same reason as the action block: the Last Trick
          button only exists once a trick has finished, and without a floor the
          felt above shrank by 11px the first time it appeared (measured). */}
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "center", gap: 8,
        padding: "0 10px 4px", minHeight: 30,
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: ".06em", color: felt.creamDim }}>
          YOUR HAND
        </div>
        {g.lastTrick && (
          <button style={{ ...btnGhost, marginLeft: "auto" }} onClick={() => setModal("lastTrick")}>
            Last Trick
          </button>
        )}
      </div>

      {/* Your hand */}
      <div style={{ borderTop: `2px solid ${felt.rail}`, padding: "8px 6px 12px" }}>
        {/* overflowX is a safety net, not the mechanism: the fan is sized to
            fit, and a scrollbar appearing here means the geometry is wrong. */}
        <div style={{ display: "flex", justifyContent: "center", flexWrap: "nowrap", overflowX: "auto" }}>
          {myHand.map((c, i) => (
            <div key={cid(c)} style={{ marginLeft: i === 0 ? 0 : -handOverlap }}>
              <Card
                card={c}
                onClick={() => onCardClick(c)}
                selected={selected.some((s) => cid(s) === cid(c))}
                dim={g.phase === "playing" && isMyTurn && !legal.includes(cid(c))}
              />
            </div>
          ))}
        </div>
      </div>

      {modal === "trump" && <TrumpModal onClose={() => setModal(null)} />}
      {modal === "scores" && (
        <ScoresModal
          table={table}
          busy={busy}
          onClose={() => setModal(null)}
          onRename={(n) => act(async () => {
            await api.setName(tableId, playerId, n);
            setModal(null);
          })}
        />
      )}
      {modal === "invite" && <InviteModal table={table} onClose={() => setModal(null)} />}
      {modal === "lastTrick" && (
        <LastTrickModal table={table} mySeat={mySeat} onClose={() => setModal(null)} />
      )}
      {seatModal !== null && (
        <PlayerModal
          table={table}
          seat={seatModal}
          serverNow={serverNow}
          busy={busy}
          err={err}
          onClose={() => setSeatModal(null)}
          onBoot={(seat) => act(async () => {
            await api.bootPlayer(tableId, playerId, seat);
            setSeatModal(null);
          })}
        />
      )}
    </div>
  );
}

function statusLine(g, table, mySeat, isMyTurn) {
  if (g.phase === "handEnd") {
    return g.result ? `${g.result.pickerWins ? "Pickers win" : "Defenders win"}${g.result.label ? ` — ${g.result.label}` : ""}` : "Hand over.";
  }
  if (g.phase === "picking") {
    return g.pickTurn === mySeat ? "Pick or pass?" : `${table.seats[g.pickTurn].name} is deciding…`;
  }
  if (g.phase === "bury") {
    return g.picker === mySeat ? "Bury two, then call an ace." : `${table.seats[g.picker].name} is burying…`;
  }
  if (isMyTurn) return "Your play.";
  return `${table.seats[g.turn]?.name || "Someone"}'s play…`;
}

function Actions({ children }) {
  return (
    <div style={{ display: "flex", gap: 10, justifyContent: "center", padding: "10px 12px" }}>
      {children}
    </div>
  );
}

function Centered({ children }) {
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

// Bury two, then choose which ace to call. The callable set is recomputed here
// purely to render buttons — api/tables/[id]/bury.js recomputes it server-side
// and is the actual authority, so a tampered client just gets a 400.
function BuryBar({ g, mySeat, selected, busy, onConfirm }) {
  const hand = g.hands[mySeat] || [];
  const remaining = hand.filter((c) => !selected.some((s) => cid(s) === cid(c)));
  const ready = selected.length === 2;

  const opts = ready ? callable(remaining, selected) : [];

  return (
    <div style={{ padding: "10px 12px", textAlign: "center" }}>
      {!ready ? (
        <div style={{ color: felt.creamDim, fontSize: 14 }}>
          Select {2 - selected.length} more card{selected.length === 1 ? "" : "s"} to bury.
        </div>
      ) : opts.length === 0 ? (
        <button style={btnGold} disabled={busy} onClick={() => onConfirm(null)}>
          Go alone
        </button>
      ) : (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          {opts.map((su) => (
            <button key={su} style={btnGold} disabled={busy} onClick={() => onConfirm(su)}>
              Call {SUIT_SYM[su]} {SUIT_NAME[su]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Mirrors api/tables/[id]/bury.js — a fail suit you hold, whose ace you neither
// hold nor just buried.
function callable(hand, buried) {
  const isTrumpCard = (c) => c.rank === "Q" || c.rank === "J" || c.suit === "D";
  const fails = { C: [], S: [], H: [] };
  hand.filter((c) => !isTrumpCard(c)).forEach((c) => fails[c.suit]?.push(c));
  return ["C", "S", "H"].filter(
    (su) =>
      fails[su].length > 0 &&
      !fails[su].some((c) => c.rank === "A") &&
      !buried.some((c) => c.suit === su && c.rank === "A" && !isTrumpCard(c))
  );
}
