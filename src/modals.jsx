/* ============================================================================
   The modals — the third piece of shared chrome, after felt.jsx and header.jsx.

   Same contract as the felt: these take `names` and `mySeat` and know nothing
   about where either came from. Solo passes its fixed cast and seat 0; a table
   passes real names and whichever seat you got. That one convention is what
   lets the hand-end summary and the recap — which the table simply never had —
   work at a table without being written a second time.

   The table CAN show them because viewFor() opens up at handEnd: hands, buried
   and partner are all disclosed once the hand is over, and trickHistory was
   never secret (played cards are public by definition). So the recap needs
   nothing the server wasn't already sending.

   Two of these already existed on both sides and had drifted, which is the
   whole reason for this file. Where they differed, the better of the two won
   rather than solo automatically:

     Trump      the table's, because it is generated from the engine's own
                trump ordering. Solo's was a hand-typed string, which is a
                second source of truth for the one fact the game is built on.
     Last trick solo's, because laying the cards out by seat matches the felt
                you just watched. The table's flex row lost that. Generalised
                with rotate() so it works from any seat.
   ========================================================================= */
import React from "react";
import { SUIT_SYM, cid, cardPts, makeDeck, isTrump, trumpPower } from "./engine.js";
import { felt, Card, Badge, Modal, ModalActions, btnGold, btnPlain, btnGhost } from "./ui.jsx";
import { SEAT_POS, rotate } from "./felt.jsx";

// Derived from the engine rather than typed out, so it cannot disagree with
// how the game actually ranks cards.
const TRUMP_ORDER = makeDeck().filter(isTrump).sort((a, b) => trumpPower(b) - trumpPower(a));

const isRed = (c) => c.suit === "H" || c.suit === "D";

// Recap-only card colour: trump (every Queen, every Jack, every diamond)
// reads as one gold group regardless of suit, since that's the fact that
// actually decided the hand. Suit colour is reserved for fail cards, where it
// still tells clubs from spades at a glance — hearts is the only suit that's
// never trump, so it needs no isTrump check to stay red.
const recapCardColor = (c) =>
  isTrump(c) ? felt.brass : c.suit === "H" ? felt.red : c.suit === "C" ? felt.blue : felt.cream;
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

// "You" wherever it's your own seat. Solo has always called seat 0 "You" via
// NAMES; a table has to derive it, and getting this wrong reads as a stranger
// sitting in your chair.
const nameOf = (names, mySeat, seat) => (seat === mySeat ? "You" : names[seat] ?? "");

/* -------------------------------------------------------------------------- */

export function TrumpModal({ onClose }) {
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
            color: isRed(c) ? felt.red : felt.cream,
          }}>{c.rank}{SUIT_SYM[c.suit]}</span>
        ))}
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 14 }}>
        Card points: A 11 · 10 10 · K 4 · Q 3 · J 2 · 9/8/7 nothing. 120 in the
        deck; the picker's team needs 61.
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 14 }}>
        The player holding the called ace is the picker's secret partner, and
        must play it when that suit is led.
      </div>
      <ModalActions>
        <button style={btnPlain} onClick={onClose}>Close</button>
      </ModalActions>
    </Modal>
  );
}

/**
 * Running totals. `children` is where a table hangs the things solo has no
 * concept of — renaming yourself, stepping away — so this file never learns
 * what a seat kind is.
 */
/**
 * What is being collected and how to stop it.
 *
 * Solo hands are uploaded so the AI can be compared against how people
 * actually play — `scripts/minehands.mjs` reads them. This site is public, so
 * that includes hands played by people who never asked to help, which is why
 * this screen exists rather than a line in a README: if you are going to
 * collect from everyone, everyone has to be able to see it and switch it off.
 *
 * The list below is exhaustive, and short on purpose.
 */
export function ShareHandsModal({ sharing, onToggle, onClose }) {
  return (
    <Modal maxWidth={430} onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 8 }}>
        Helping the AI improve
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 10 }}>
        When a hand finishes, the cards are sent to us and compared against what
        the computer players would have done. That is how the AI gets better at
        the spots people actually beat it in.
      </div>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 4 }}>What gets sent:</div>
      <ul style={{ fontSize: 13, color: felt.creamDim, margin: "0 0 10px 18px", padding: 0 }}>
        <li>the cards dealt and every card played</li>
        <li>which seat was the human one</li>
        <li>the app version, and a random id for this browser</li>
      </ul>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 14 }}>
        No name, no account, nothing that says who you are — there is no login
        here to attach it to. Turning this off stops it immediately and nothing
        further is sent.
      </div>
      {/* The toggle is what this screen is for, so it takes the primary slot on
          the right. It was a full-width block above Close; full width is the
          one shape that can't sit in a right-aligned row, and it made the
          dismissal look like the equal of the setting. */}
      <ModalActions>
        <button style={btnPlain} onClick={onClose}>Close</button>
        <button style={btnGold} onClick={onToggle}>
          {sharing ? "Stop sending my hands" : "Send my hands to help"}
        </button>
      </ModalActions>
    </Modal>
  );
}

export function ScoresModal({ names, scores, handNum, mySeat, onClose, children, actions }) {
  return (
    <Modal onClose={onClose}>
      {/* "Hand N", not "After hand N" — which is what the table said, and was
          wrong for most of the time anyone reads it. Both halves set handNum
          to the hand being PLAYED (table.js bumps it when the hand starts, not
          when it ends), so mid-hand the table was announcing "After hand 3"
          during hand 3. Zero still means nothing has been dealt. */}
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 2 }}>
        {handNum > 0 ? `Hand ${handNum}` : "Not started"}
      </div>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>
        Scores
      </div>
      <table style={{ width: "100%", fontSize: 16, borderCollapse: "collapse", marginBottom: 14 }}>
        <tbody>
          {names.map((n, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #ffffff18" }}>
              {/* The badge marks your row only when the name doesn't already
                  say so. Solo's cast literally calls seat 0 "You", so badging
                  it unconditionally rendered "You YOU". At a table your row
                  carries your own name and the badge is the thing that makes
                  it findable. */}
              <td style={{ padding: "6px 0", fontWeight: i === mySeat ? 800 : 500 }}>
                {n} {i === mySeat && n !== "You" && <Badge compact>You</Badge>}
              </td>
              <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700 }}>
                {signed(scores[i])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
      {/* `actions` is the WHOLE footer row, Close included — not extra buttons
          bolted on beside a Close this component owns. Only the caller knows
          which of its controls is the primary one, and the primary is the one
          that has to end up on the right. Solo has no controls here, so the
          default is the row it needs: dismissal alone. */}
      <ModalActions>
        {actions ?? <button style={btnPlain} onClick={onClose}>Close</button>}
      </ModalActions>
    </Modal>
  );
}

/**
 * Laid out by seat, the way the felt is — you just watched these cards land in
 * those positions, and a neutral row throws that away. Rotated by mySeat, so
 * your own card is at the bottom wherever you're actually sitting.
 */
export function LastTrickModal({ lastTrick, names, mySeat = 0, onClose }) {
  return (
    <Modal maxWidth={420} onClose={onClose}>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 10 }}>
        Last trick
      </div>
      {lastTrick ? (
        <>
          <div style={{ position: "relative", height: 250, margin: "4px 0 10px" }}>
            {names.map((_, seat) => {
              const played = lastTrick.trick.find((x) => x.player === seat);
              const isLeader = lastTrick.trick[0]?.player === seat;
              const isWinner = seat === lastTrick.winner;
              const at = rotate(seat, mySeat);
              const pos = at === 0
                ? { left: "50%", bottom: 0, transform: "translateX(-50%)" }
                : SEAT_POS[at];
              const label = nameOf(names, mySeat, seat);
              return (
                <div key={seat} style={{
                  position: "absolute", ...pos,
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: 74,
                }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: "50%", background: felt.chip,
                    border: `2px solid ${isLeader ? felt.brass : "#ffffff2e"}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: "Georgia, serif", fontWeight: 800, fontSize: 16,
                    boxShadow: isWinner ? `0 0 10px ${felt.brass}aa` : "none",
                  }}>
                    {label[0]}
                  </div>
                  <div style={{
                    fontSize: 11, fontWeight: isWinner ? 800 : 600,
                    color: isWinner ? felt.brass : felt.cream, textAlign: "center",
                  }}>
                    {label}
                  </div>
                  {/* Under: whoever gathered the trick saw the card, so the
                      server sends them its real face and it shows here. To
                      everyone else `actual` simply is not in the state — the
                      card stays a back until the recap, where the hand is over
                      and everybody sees it labelled. */}
                  <div style={{ minHeight: 46 }}>
                    {played && <Card card={played.actual ?? played.card} small faceDown={played.under && !played.actual} />}
                  </div>
                  {played?.under && (
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: felt.brass, textTransform: "uppercase" }}>
                      Under
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: felt.creamDim, textAlign: "center" }}>
            <span style={{ color: felt.brass, fontWeight: 700 }}>Gold ring</span> = led this trick ·{" "}
            <span style={{ color: felt.brass, fontWeight: 700 }}>glow</span> = won it
          </div>
          <div style={{ fontSize: 13, color: felt.creamDim, marginTop: 6, textAlign: "center" }}>
            {nameOf(names, mySeat, lastTrick.winner)} took{" "}
            {lastTrick.trick.reduce((s, t) => s + cardPts(t.actual ?? t.card), 0)}
            {/* A hidden under card is worth something we are not showing you,
                so the honest total is "at least this". Printing the bare number
                would either be wrong or give the card away. */}
            {lastTrick.trick.some((t) => t.under && !t.actual) ? "+" : ""} pts
          </div>
        </>
      ) : (
        <div style={{ fontSize: 16, color: felt.creamDim }}>No trick played yet this hand.</div>
      )}
      <div style={{ marginTop: 12 }}>
        <ModalActions>
          <button style={btnPlain} onClick={onClose}>Close</button>
        </ModalActions>
      </div>
    </Modal>
  );
}

const outcomeHeadline = (g) => {
  if (!g.result.pickerWins) return "Defenders win";
  return g.alone || g.partner === null ? "Picker wins" : "Pickers win";
};

/** Who won, by how much, and what it did to the running score. */
export function HandEndModal({ g, names, mySeat = 0, onNext, onRecap, nextLabel = "Deal next hand", nextDisabled }) {
  return (
    <Modal>
      <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 2 }}>Hand {g.handNum}</div>
      <div style={{ fontFamily: "Georgia, serif", fontSize: 24, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
        {outcomeHeadline(g)} {g.result.label && `— ${g.result.label}`}
      </div>
      <div style={{ fontSize: 16, marginBottom: 10, color: felt.creamDim }}>
        {g.result.pickerTeam.map((p) => names[p]).join(" & ")} took {g.result.teamPts} points
        {g.result.buriedPts > 0 && ` (${g.result.buriedPts} buried)`} · defenders {g.result.defPts}
      </div>
      <table style={{ width: "100%", fontSize: 16, borderCollapse: "collapse", marginBottom: 14 }}>
        <thead>
          <tr style={{ fontSize: 11, color: felt.creamDim, textTransform: "uppercase", letterSpacing: ".04em" }}>
            <td style={{ padding: "0 0 4px" }}></td>
            <td style={{ textAlign: "right", padding: "0 0 4px" }}>Pts</td>
            <td style={{ textAlign: "right", padding: "0 0 4px" }}>Hand</td>
            <td style={{ textAlign: "right", padding: "0 0 4px" }}>Total</td>
          </tr>
        </thead>
        <tbody>
          {names.map((n, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #ffffff18" }}>
              <td style={{ padding: "5px 0", fontWeight: i === mySeat ? 800 : 500 }}>
                {n}{" "}
                {i === g.picker && <Badge gold>Picker</Badge>}{" "}
                {i === g.partner && <Badge gold>Partner</Badge>}
              </td>
              <td style={{ textAlign: "right" }}>{g.ptsTaken[i]} pts</td>
              <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700, width: 50 }}>
                {signed(g.result.handDelta[i])}
              </td>
              <td style={{ textAlign: "right", color: felt.brass, fontWeight: 700, width: 60 }}>
                {signed(g.scores[i])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Dealing on is the primary and now sits rightmost; Recap flows to its
          left. The pair used to read left-to-right, which put the button you
          press every single hand at the far edge from the thumb. */}
      <ModalActions>
        <button style={btnPlain} onClick={onRecap}>Recap</button>
        {onNext && (
          <button style={btnGold} onClick={onNext} disabled={nextDisabled}>{nextLabel}</button>
        )}
      </ModalActions>
    </Modal>
  );
}

/**
 * The whole hand as one grid, which is the format hands actually get argued
 * about in. `captureRef` marks the region a screenshot should cover; the Share
 * button deliberately sits outside it.
 */
export function RecapModal({
  g, names, mySeat = 0, grades, captureRef, onShare, onBack, onNext, nextLabel = "Deal next hand", nextDisabled,
}) {
  const best = grades?.best;
  const worst = grades?.worst;
  const pending = Boolean(grades?.pending);

  return (
    <Modal maxWidth={480} onClose={onBack}>
      {/* Only Share lives outside the capture. Hand number and build moved
          inside it, because a reported hand is evidence about a specific AI
          build — without the version stamped into the image, "the AI misplayed
          this" can't be matched to what the AI was at the time. */}
      {onShare && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
          <button
            onClick={onShare}
            aria-label="Share this recap"
            title="Share this recap"
            style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 5, padding: "6px 10px" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15V3M12 3l-4 4M12 3l4 4" />
              <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
            </svg>
            Share
          </button>
        </div>
      )}

      <div ref={captureRef} style={{ background: felt.bgDeep }}>
        <div style={{ fontSize: 13, color: felt.creamDim, marginBottom: 2 }}>
          Hand {g.handNum}
          <span style={{ opacity: 0.55 }}> · v{__APP_VERSION__}</span>
        </div>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 900, color: felt.brass, marginBottom: 4 }}>
          {outcomeHeadline(g)} {g.result.label && `— ${g.result.label}`}
        </div>
        <div style={{ fontSize: 15, color: felt.creamDim, marginBottom: 8 }}>
          {g.result.pickerTeam.map((p) => names[p]).join(" & ")} took {g.result.teamPts} points
          {" · "}defenders {g.result.defPts}
        </div>

        {/* The buried pair is the one part of the hand nobody at the table ever
            gets to see, and the recap is the only place it can be shown. Glyphs
            rather than card faces, so it doesn't outweigh the 30 cards played. */}
        {g.buried?.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13 }}>
            <span style={{ fontSize: 11, color: felt.creamDim, letterSpacing: ".04em", textTransform: "uppercase" }}>
              Buried
            </span>
            {g.buried.map((c) => (
              <span key={cid(c)} style={{ color: recapCardColor(c), fontWeight: 700 }}>
                {c.rank}{SUIT_SYM[c.suit]}
              </span>
            ))}
          </div>
        )}

        <div style={{ overflowX: "auto", marginBottom: 14 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: "100%" }}>
            <thead>
              <tr>
                {/* "TRICK" labels the row once, in the otherwise-empty name
                    column, so each heading is just its number. Repeating the
                    word six times cost width where the grid is tightest — at
                    375px every heading wrapped onto two lines. */}
                <td style={{ padding: "0 6px 6px 0", color: felt.creamDim, fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", whiteSpace: "nowrap" }}>
                  Trick
                </td>
                {[1, 2, 3, 4, 5, 6].map((t) => (
                  <td key={t} style={{ textAlign: "center", padding: "0 4px 6px", color: felt.creamDim, fontSize: 12, fontWeight: 700 }}>
                    {t}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Rows are seats in table order, NOT play order. Worth stating
                  because it has been misread before: a card's column is the
                  trick it was played in, and its row is who played it. */}
              {names.map((n, p) => (
                <tr key={p} style={{ borderTop: "1px solid #ffffff18" }}>
                  {/* Badges stack under the name rather than beside it: the
                      grid already scrolls sideways on a phone, and a wider name
                      column eats the tricks you're trying to read. */}
                  <td style={{ padding: "6px 6px 6px 0", fontWeight: p === mySeat ? 800 : 500, whiteSpace: "nowrap" }}>
                    <div>{n}</div>
                    {p === g.picker && <div style={{ marginTop: 3 }}><Badge gold compact>Picker</Badge></div>}
                    {p === g.picker && g.alone && <div style={{ marginTop: 3 }}><Badge compact>Alone</Badge></div>}
                    {p === g.partner && <div style={{ marginTop: 3 }}><Badge gold compact>Partner</Badge></div>}
                  </td>
                  {(g.trickHistory || []).map((th, t) => {
                    const played = th.trick.find((x) => x.player === p);
                    if (!played) return <td key={t} />;
                    // The recap is after the hand, so `actual` is present for
                    // everyone: the under card is shown as what it really was,
                    // marked so the row still reads as the 6 it played as.
                    const card = played.actual ?? played.card;
                    const isLeader = th.trick[0].player === p;
                    const isWinner = th.winner === p;
                    const isBest = best && best.trick === t && best.player === p;
                    const isWorst = worst && worst.trick === t && worst.player === p;
                    return (
                      <td key={t} style={{ textAlign: "center", padding: "6px 4px" }}>
                        <span style={{
                          display: "inline-block",
                          color: recapCardColor(card),
                          fontWeight: isWinner ? 800 : 500,
                          background: isWinner ? "#00000040" : "transparent",
                          borderRadius: 4,
                          padding: "2px 4px",
                          borderBottom: isLeader ? `2px solid ${felt.brass}` : "2px solid transparent",
                        }}>
                          {card.rank}{SUIT_SYM[card.suit]}
                          {played.under && (
                            <span style={{ color: felt.brass, fontWeight: 800, fontSize: 9, marginLeft: 2, letterSpacing: 0.3 }}>
                              U
                            </span>
                          )}
                          {isBest && <span style={{ color: "#4FAE64", fontWeight: 900, marginLeft: 2 }}>!</span>}
                          {isWorst && <span style={{ color: felt.red, fontWeight: 900, marginLeft: 2 }}>?</span>}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ fontSize: 11, color: felt.creamDim, marginBottom: 14 }}>
          <span style={{ borderBottom: `2px solid ${felt.brass}` }}>underline</span> = led the trick · shaded = won the trick
          {(g.trickHistory || []).some((th) => th.trick.some((x) => x.under)) && (
            <> · <span style={{ color: felt.brass, fontWeight: 800 }}>U</span> = played under</>
          )}
          {/* Grading runs in a worker now, so the grid is on screen before the
              verdict is. "Still working" and "nothing worth flagging" look
              identical if both render as blank, so say which one it is. */}
          {pending && (
            <>
              <br />
              <span style={{ opacity: 0.75 }}>grading the hand…</span>
            </>
          )}
          {!pending && (best || worst) && (
            <>
              <br />
              {best && (
                <>
                  <span style={{ color: "#4FAE64", fontWeight: 900 }}>!</span> best play
                </>
              )}
              {best && worst && " · "}
              {worst && (
                <>
                  <span style={{ color: felt.red, fontWeight: 900 }}>?</span> worst play
                </>
              )}
              <br />
              <span style={{ opacity: 0.75 }}>every trick graded</span>
            </>
          )}
        </div>
      </div>

      <ModalActions>
        <button style={btnPlain} onClick={onBack}>Back</button>
        {onNext && (
          <button style={btnGold} onClick={onNext} disabled={nextDisabled}>{nextLabel}</button>
        )}
      </ModalActions>
    </Modal>
  );
}
