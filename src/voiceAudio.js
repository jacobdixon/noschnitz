/* ============================================================================
   Playing what everyone else says.

   This module exists because of a gap that is easy to miss and produces the
   most confusing possible symptom. daily-js has two modes:

     createFrame()       Daily renders its own UI in an iframe, and that iframe
                         plays remote audio for you.
     createCallObject()  You get tracks. Nothing is rendered, nothing is played.

   We use the call object — the felt is a locked, no-scroll viewport and there
   is no room for a second UI on top of it (see useVoice.js). The cost of that
   choice is this file: in call-object mode **daily-js never plays a remote
   audio track**. It hands you a MediaStreamTrack on `track-started` and the
   application is responsible for attaching it to an element. Daily's own React
   library ships a whole <DailyAudio> component to do this; there is nothing
   automatic underneath it.

   The symptom when it is missing is the reason this is worth a file of its
   own rather than four lines inline. Both ends join successfully. The mic
   chip goes to "connected". The participant count reads 2. Microphones are
   captured, permission is granted, audio is uploaded to Daily and forwarded to
   the other participant — and neither side plays a single sample of what it
   receives. Every indicator the app has is green and the room is silent. There
   is nothing to see in the flight recorder, no error, no failed request. It
   looks exactly like a working call that nobody else has joined, which is the
   same trap ensureRoom's comment in api/_lib/voice.js warns about one layer up.

   Kept separate from useVoice.js for two reasons: it is the only part of the
   audio path that is testable without an SDK or a network (scripts/
   voiceaudiotest.mjs drives it with a fake document and fake tracks), and
   keeping it out of the hook means the hook's own body stays about lifecycle.

   `doc` and `MediaStreamCtor` are injected rather than read from globals at
   call time so that test can exist at all — jsdom has no MediaStream.
   ========================================================================= */

/**
 * A set of <audio> elements, one per remote participant, kept in step with
 * their tracks.
 *
 * Everything is keyed by session id rather than seat: seats are ours and
 * sessions are Daily's, and a participant can be present without ever having
 * been mapped to a seat (a watcher, or someone mid-join). Mapping the two is
 * deliberately not done here — see the note in useVoice.js about why lighting
 * up the wrong player is worse than lighting up nobody.
 */
export function createAudioSink({
  doc = globalThis.document,
  MediaStreamCtor = globalThis.MediaStream,
  onFailure = () => {},
} = {}) {
  // sessionId -> { el, trackId }
  const entries = new Map();

  function attach(sessionId, track) {
    if (!sessionId || !track) return;

    // Idempotent on the same track, and that matters rather than being tidy.
    // Daily replays `track-started` for participants who were already in the
    // room when we joined, and useVoice ALSO sweeps call.participants() after
    // join to cover the case where it doesn't. Both paths reach here for the
    // same track; tearing the element down and rebuilding it would interrupt
    // audio that is already playing perfectly well.
    const existing = entries.get(sessionId);
    if (existing && existing.trackId === track.id) return;

    detach(sessionId);

    const el = doc.createElement("audio");
    el.autoplay = true;
    // iOS Safari will otherwise treat a media element as something it may take
    // over the screen for. Harmless on an audio element in every browser that
    // doesn't need it, and load-bearing on the one that does — which is half
    // the devices this feature exists for.
    el.playsInline = true;
    el.srcObject = new MediaStreamCtor([track]);
    doc.body.appendChild(el);
    entries.set(sessionId, { el, trackId: track.id });

    // autoplay alone is not a guarantee. play() returns a promise that REJECTS
    // under a browser's autoplay policy, and an unhandled rejection here would
    // be the only trace of a silent call. Joining is always behind a user
    // gesture (useVoice, property 3) so this should not fire — but "should not"
    // is exactly the class of thing worth recording when it does.
    const p = el.play?.();
    if (p && typeof p.catch === "function") p.catch((err) => onFailure(sessionId, err));
  }

  function detach(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entries.delete(sessionId);
    const { el } = entry;
    try { el.pause?.(); } catch { /* never played */ }
    // Dropping the reference to the stream as well as the element. An element
    // removed from the document but still holding a live srcObject keeps the
    // track alive, which is the audio equivalent of the stale-microphone bug
    // useVoice's generation counter exists to prevent.
    el.srcObject = null;
    el.remove?.();
  }

  function destroy() {
    for (const sessionId of [...entries.keys()]) detach(sessionId);
  }

  return {
    attach,
    detach,
    destroy,
    // Test surface, and a cheap thing for a future presence indicator to read.
    get size() { return entries.size; },
  };
}

/**
 * Point a Daily call object at a sink.
 *
 * This lives here rather than inline in useVoice.js for one reason: the bug
 * in 0.58.0 was not a broken sink, it was the ABSENCE of these three lines.
 * A sink tested in isolation would have passed perfectly while the room stayed
 * silent, so the wiring has to be reachable by a test too — scripts/
 * voiceaudiotest.mjs drives a fake call object through these very events, and
 * removing any handler below fails it.
 *
 * Must be called BEFORE call.join(), so a track that starts during the
 * handshake is not missed.
 */
export function bindCallAudio(call, sink) {
  call
    .on("track-started", (ev) => {
      // Audio only — there is no video path — and never our own track: playing
      // your own microphone back is a feedback loop, not a bug you debug
      // calmly on a games night.
      if (ev?.track?.kind !== "audio" || ev?.participant?.local) return;
      sink.attach(ev.participant?.session_id, ev.track);
    })
    .on("track-stopped", (ev) => {
      if (ev?.track?.kind !== "audio") return;
      // `participant` is absent when the track stopped because the participant
      // is already gone; the handler below covers that case.
      sink.detach(ev?.participant?.session_id);
    })
    .on("participant-left", (ev) => sink.detach(ev?.participant?.session_id));
  return call;
}

/**
 * Everyone who was already talking before we arrived.
 *
 * Daily does replay `track-started` for participants already in the room, so
 * this is usually a no-op — but "usually" is the wrong strength for the
 * difference between hearing the table and sitting in silence, and attach() is
 * idempotent on the same track, so running both paths costs nothing.
 */
export function sweepExistingAudio(call, sink) {
  for (const p of Object.values(call.participants() || {})) {
    if (!p || p.local) continue;
    const track = p.tracks?.audio?.persistentTrack || p.tracks?.audio?.track;
    if (track) sink.attach(p.session_id, track);
  }
}
