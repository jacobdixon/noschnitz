/* ============================================================================
   Table audio — the client half of COM-1.

   Audio only. No camera is ever requested: `videoSource: false` at join, and
   the room itself is created with start_video_off (api/_lib/voice.js). Both,
   because they fail differently — the room property is what a second client
   would honour, and the join option is what stops THIS browser lighting up a
   camera indicator even for an instant.

   Three properties this file exists to hold:

   1. **It is inert unless VOICE_ENABLED.** Every entry point returns the idle
      shape when the flag is off, so the `import()` below is unreachable and
      Rollup drops both the call and the chunk. That is what keeps the Daily
      client off www.noschnitz.com — not a hidden button, an absent bundle.
      Asserted by building both ways and grepping; see scripts/voicebuildtest.

   2. **The SDK is loaded on demand, never at startup.** `@daily-co/daily-js`
      is a dynamic import inside join(), so even on beta nobody pays for it
      until they tap the button. It is worth knowing what that import does at
      runtime: daily-js is a thin orchestration layer that then fetches the
      real call machinery from Daily's CDN. So joining touches the network
      twice, and a strict CSP would need to allow it (there is none today).

   3. **Joining is a user gesture, always.** Never on mount, never on a table
      event. Mobile Safari only grants a microphone from a gesture, and the
      social reason points the same way: a link somebody texted you should not
      demand your microphone before you have decided to be in the conversation.
      That is COM-1.2's "listen only or step away" taken one step earlier.

   Deliberately NOT here: any mapping from Daily participants to seats. It is
   tempting — a speaking ring on the felt would be lovely — but it needs an
   identity join between two systems, and getting it wrong lights up the wrong
   player. `userName` is set to the seat index so that work has something to
   build on later (COM-2.1), and nothing reads it yet.
   ========================================================================= */
import { useState, useRef, useEffect, useCallback } from "react";
import { VOICE_ENABLED } from "./flags.js";
import * as api from "./api.js";
import { logStream } from "./streamLog.js";

// What the UI switches on. "connecting" is its own state rather than a boolean
// because it spans two slow things — provisioning the room server-side and the
// SDK's own connect — and a button that looks idle during either invites a
// second tap, which on iOS means a second microphone prompt.
export const VOICE_IDLE = "idle";
export const VOICE_CONNECTING = "connecting";
export const VOICE_CONNECTED = "connected";
export const VOICE_ERROR = "error";

// The inert shape, and deliberately the SMALLEST one that works rather than a
// full no-op mirror of the real return.
//
// Every caller reads this object from inside a `VOICE_ENABLED &&` branch, so in
// a flag-off build nothing touches `.join` or `.toggleMute` — those branches are
// eliminated with the flag. Spelling them out here as no-ops would therefore
// buy nothing except the one thing this file is trying to avoid: the words
// themselves, surviving into the production bundle as dead property names on an
// object nobody calls. scripts/voicebuildtest.mjs greps for exactly that, and
// asserts ZERO rather than a ceiling, because "a small amount of audio code on
// www" is not a state anyone can eyeball later and judge safe.
const IDLE = { status: VOICE_IDLE };

export function useVoice({ tableId, playerId, seat } = {}) {
  // Before the hooks, not after, and that is the whole trick.
  //
  // With the flag off, Vite inlines `false` and Rollup drops everything below —
  // the callbacks, the event wiring, the dynamic import, the strings. Returning
  // late instead (the obvious shape) leaves all of it in the bundle, inert but
  // present, which is how `toggleMute` shipped to production in the first draft
  // of this file. The build test caught it; nothing on screen would have.
  //
  // This reads like a rules-of-hooks violation and is not one. The rule is that
  // hook order must be consistent across RENDERS, and `VOICE_ENABLED` is a
  // compile-time constant — so within any given build this function either
  // always runs its hooks or never does. There is no render where it differs.
  if (!VOICE_ENABLED) return IDLE;

  const [status, setStatus] = useState(VOICE_IDLE);
  const [muted, setMuted] = useState(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState(null);

  // The call object is a singleton per page — daily-js throws if a second one
  // is constructed — so it lives in a ref rather than state, and every path
  // that creates one checks here first.
  const callRef = useRef(null);
  // Guards the window between tapping join and the SDK arriving. Without it a
  // double tap starts two joins, and the second one wins a race against the
  // first one's cleanup.
  const busyRef = useRef(false);
  // Cancellation. join() awaits twice — the server, then the SDK — and either
  // gap is long enough for the component to unmount or for leave() to be
  // called. A stale continuation past that point constructs a call object into
  // a dead component, which leaves a LIVE MICROPHONE with nothing on screen to
  // stop it. Every teardown invalidates whatever join is in flight.
  const genRef = useRef(0);

  const teardown = useCallback(async () => {
    genRef.current++;
    const call = callRef.current;
    callRef.current = null;
    if (!call) return;
    try {
      await call.leave();
    } catch { /* already gone */ }
    try {
      call.destroy();
    } catch { /* already destroyed */ }
  }, []);

  // Leaving the table screen must drop the call. Without this a player who
  // navigates back to the solo game is still in the room, audible to everyone
  // and with no control on screen to stop it.
  useEffect(() => () => { teardown(); }, [teardown]);

  const leave = useCallback(async () => {
    await teardown();
    setStatus(VOICE_IDLE);
    setCount(0);
    setMuted(false);
  }, [teardown]);

  const join = useCallback(async () => {
    if (!VOICE_ENABLED || !tableId || !playerId) return;
    if (busyRef.current || callRef.current) return;
    busyRef.current = true;
    const gen = ++genRef.current;
    setError(null);
    setStatus(VOICE_CONNECTING);

    try {
      // Server first: it decides whether we are allowed audio at all, and
      // provisions the room. Doing this before loading the SDK means a table
      // that cannot have audio never pays for the download.
      const { voice } = await api.getVoiceRoom(tableId, playerId);
      if (!voice?.url) throw new Error("no room");

      const Daily = (await import("@daily-co/daily-js")).default;

      // Both awaits are behind us; if anything tore down while we were gone,
      // stop here rather than constructing a call object nobody can reach.
      if (genRef.current !== gen) return;

      const call = Daily.createCallObject({
        audioSource: true,
        // Audio only, at the strongest layer available to us.
        videoSource: false,
      });
      callRef.current = call;

      call
        .on("participant-joined", () => setCount(call.participantCounts().present))
        .on("participant-left", () => setCount(call.participantCounts().present))
        .on("left-meeting", () => { setStatus(VOICE_IDLE); setCount(0); })
        .on("error", (e) => {
          logStream("voice-error", { msg: e?.errorMsg || "?" });
          setError("Audio dropped.");
          setStatus(VOICE_ERROR);
        });

      await call.join({
        url: voice.url,
        // Seat index rather than a name, and never the playerId — that is a
        // bearer token (see identity.js) and this string is visible to every
        // other participant. Nothing reads it yet; it is here so a future
        // speaking indicator has a seat to point at.
        userName: Number.isInteger(seat) && seat >= 0 ? `seat-${seat}` : "watcher",
        startVideoOff: true,
      });

      setCount(call.participantCounts().present);
      setMuted(!call.localAudio());
      setStatus(VOICE_CONNECTED);
    } catch (e) {
      logStream("voice-join-failed", { err: e?.code || e?.message || "?" });
      await teardown();
      // The two failures worth telling apart. A refused microphone is the
      // player's own browser and they can fix it; everything else is ours.
      setError(
        e?.name === "NotAllowedError"
          ? "Your browser blocked the microphone."
          : "Couldn't start audio."
      );
      setStatus(VOICE_ERROR);
    } finally {
      busyRef.current = false;
    }
  }, [tableId, playerId, seat, teardown]);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !muted;
    call.setLocalAudio(!next);
    setMuted(next);
  }, [muted]);

  return { status, muted, count, error, join, leave, toggleMute };
}
