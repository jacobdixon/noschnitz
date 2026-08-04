#!/usr/bin/env node
/* ============================================================================
   Does anyone actually hear anything?

   The bug this suite exists for shipped in 0.58.0 and survived a 55-check
   server suite, a bidirectional build test and a real phone-to-laptop trial:
   the client joined the Daily room correctly and never played a single remote
   track. In call-object mode daily-js does not play audio for you (see
   src/voiceAudio.js), and NOTHING the app could observe about itself was
   wrong — status connected, participant count 2, microphone captured, no
   errors anywhere. The only symptom was silence, which no assertion in the
   repo was in a position to notice.

   So the thing being pinned here is narrow and specific: for every remote
   audio track, an element exists, it has that track on it, and it was asked to
   play. Everything else in this file is about not breaking that later.

   The document is faked rather than jsdom'd, deliberately. jsdom has no
   MediaStream and its HTMLMediaElement.play() is unimplemented, so a realistic
   DOM would need both stubbed anyway — at which point the realism is gone and
   only the startup cost is left. A fake also lets the test assert the element
   was asked to play, which is the one property that actually matters and the
   one a real DOM would silently swallow.

   Usage: node scripts/voiceaudiotest.mjs
   ========================================================================= */
import { createAudioSink, bindCallAudio, sweepExistingAudio } from "../src/voiceAudio.js";

let passed = 0;
const failures = [];
const check = (label, cond, detail = "") => {
  if (cond) { passed++; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/* ------------------------------- the fakes -------------------------------- */

function fakeDoc() {
  const body = {
    children: [],
    appendChild(el) { body.children.push(el); el._attached = true; return el; },
  };
  return {
    body,
    created: [],
    createElement(tag) {
      const el = {
        tag,
        _attached: false,
        playCalls: 0,
        paused: false,
        srcObject: null,
        play() { el.playCalls++; return this._playResult ?? Promise.resolve(); },
        pause() { el.paused = true; },
        remove() {
          el._attached = false;
          const i = body.children.indexOf(el);
          if (i >= 0) body.children.splice(i, 1);
        },
      };
      this.created.push(el);
      return el;
    },
  };
}

class FakeMediaStream {
  constructor(tracks) { this.tracks = tracks; }
}

let nextTrack = 0;
const track = (kind = "audio") => ({ id: `t${++nextTrack}`, kind });

const live = (doc) => doc.body.children;

/* ------------------------- the property that matters ---------------------- */
{
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  const t = track();
  sink.attach("sess-a", t);

  const els = live(doc);
  check("a remote track produces exactly one element", els.length === 1, `got ${els.length}`);
  check("...which is an <audio>", els[0]?.tag === "audio", els[0]?.tag);
  check("...carrying that very track",
    els[0]?.srcObject instanceof FakeMediaStream && els[0].srcObject.tracks[0] === t);
  check("...and was asked to play", els[0]?.playCalls === 1, `${els[0]?.playCalls} calls`);
  check("...attached to the document", els[0]?._attached === true);
  check("autoplay is set", els[0]?.autoplay === true);
  // The iOS property. Cheap to assert, and the device it matters on is half
  // the devices this feature exists for.
  check("playsInline is set", els[0]?.playsInline === true);
}

/* ------------------------------ idempotence ------------------------------- */
{
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  const t = track();

  // Both paths in useVoice reach attach() for the same track: the replayed
  // `track-started` and the post-join sweep of call.participants().
  sink.attach("sess-a", t);
  const first = live(doc)[0];
  sink.attach("sess-a", t);

  check("the same track twice does not build a second element", live(doc).length === 1);
  check("...and does not interrupt the one already playing",
    live(doc)[0] === first && first.playCalls === 1, `${first.playCalls} play calls`);
}

/* --------------------------- a track that changes ------------------------- */
{
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  sink.attach("sess-a", track());
  const old = live(doc)[0];
  const t2 = track();
  sink.attach("sess-a", t2);

  check("a NEW track for the same session replaces the element", live(doc).length === 1);
  check("...with the new track on it", live(doc)[0].srcObject.tracks[0] === t2);
  check("...and the old element was stopped and dropped",
    old.paused === true && old.srcObject === null && old._attached === false);
}

/* ------------------------------ many people ------------------------------- */
{
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  for (const id of ["a", "b", "c", "d"]) sink.attach(id, track());
  check("four remote participants, four elements", live(doc).length === 4);
  check("...and the sink knows it", sink.size === 4, String(sink.size));

  sink.detach("b");
  check("one leaving removes exactly one", live(doc).length === 3);
  check("...and the others keep playing",
    live(doc).every((el) => el.paused === false && el.srcObject !== null));
}

/* ------------------------------- the cleanup ------------------------------ */
{
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  for (const id of ["a", "b"]) sink.attach(id, track());
  const all = [...live(doc)];
  sink.destroy();

  check("destroy() removes every element", live(doc).length === 0);
  check("...and releases every stream", all.every((el) => el.srcObject === null),
    "an element still holding a live track keeps it alive");
  check("...and the sink is empty", sink.size === 0);
  // Leaving twice is a real path: the unmount effect and an explicit leave()
  // can both land.
  sink.destroy();
  check("destroy() twice is harmless", sink.size === 0 && live(doc).length === 0);
  sink.detach("nobody");
  check("detaching an unknown session is harmless", live(doc).length === 0);
}

/* ----------------------------- blocked autoplay --------------------------- */
{
  const doc = fakeDoc();
  const seen = [];
  const sink = createAudioSink({
    doc,
    MediaStreamCtor: FakeMediaStream,
    onFailure: (id, err) => seen.push([id, err?.name]),
  });
  // A browser refusing to play is the one failure that is otherwise invisible:
  // the element exists, the track is on it, and the room is still silent.
  const el = doc.createElement("audio");
  el._playResult = Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }));
  doc.createElement = () => el;

  sink.attach("sess-a", track());
  await Promise.resolve();
  await Promise.resolve();

  check("a rejected play() is reported rather than swallowed",
    seen.length === 1 && seen[0][0] === "sess-a" && seen[0][1] === "NotAllowedError",
    JSON.stringify(seen));
}

/* ------------------------------- bad input -------------------------------- */
{
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  sink.attach(null, track());
  sink.attach("sess-a", null);
  sink.attach(undefined, undefined);
  check("a missing session or track builds nothing", live(doc).length === 0 && sink.size === 0);
}

/* =========================== the wiring, end to end =======================
   The section that would actually have caught 0.58.0.

   Everything above tests a sink that did not exist then — and a perfect sink
   nothing is plugged into is exactly what silence sounds like. So this drives
   the real event names a Daily call object emits, through the real binding, to
   a real sink, and asserts somebody can be heard at the end of it.
   ========================================================================= */

function fakeCall(participants = {}) {
  const handlers = new Map();
  return {
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
      return this;
    },
    emit(ev, payload) { for (const fn of handlers.get(ev) || []) fn(payload); },
    participants: () => participants,
    handled: (ev) => (handlers.get(ev) || []).length,
  };
}

{
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  const call = fakeCall();
  bindCallAudio(call, sink);

  // The exact shape daily-js emits.
  const t = track();
  call.emit("track-started", { track: t, participant: { session_id: "them", local: false } });

  check("a remote track-started makes a sound", live(doc).length === 1, `${live(doc).length} elements`);
  check("...playing the track that started", live(doc)[0]?.srcObject.tracks[0] === t);
  check("...and it was asked to play", live(doc)[0]?.playCalls === 1);

  // Our own microphone coming up must NOT be played back.
  call.emit("track-started", { track: track(), participant: { session_id: "me", local: true } });
  check("our own track is never played back", live(doc).length === 1, "feedback loop");

  // Video would be, if there were any.
  call.emit("track-started", { track: track("video"), participant: { session_id: "them2", local: false } });
  check("a video track is ignored", live(doc).length === 1);

  call.emit("track-stopped", { track: t, participant: { session_id: "them" } });
  check("track-stopped removes the element", live(doc).length === 0);
}

{
  // Someone leaving abruptly: Daily can report the track stopped with no
  // participant on the event, so participant-left is the one that has to clean
  // up. Assert that specifically, since it is the handler most likely to be
  // dropped as redundant.
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  const call = fakeCall();
  bindCallAudio(call, sink);

  call.emit("track-started", { track: track(), participant: { session_id: "them", local: false } });
  call.emit("track-stopped", { track: track(), participant: undefined });
  check("a track-stopped with no participant leaves the call alone", live(doc).length === 1);
  call.emit("participant-left", { participant: { session_id: "them" } });
  check("participant-left cleans up what track-stopped could not", live(doc).length === 0);
}

{
  // Joining a room where people are already talking.
  const doc = fakeDoc();
  const sink = createAudioSink({ doc, MediaStreamCtor: FakeMediaStream });
  const t1 = track(), t2 = track();
  const call = fakeCall({
    me: { local: true, session_id: "me", tracks: { audio: { persistentTrack: track() } } },
    a: { local: false, session_id: "a", tracks: { audio: { persistentTrack: t1 } } },
    b: { local: false, session_id: "b", tracks: { audio: { track: t2 } } },
    c: { local: false, session_id: "c", tracks: { audio: {} } },
  });
  bindCallAudio(call, sink);
  sweepExistingAudio(call, sink);

  check("everyone already talking is picked up", sink.size === 2, `${sink.size} of 2`);
  check("...ourselves excluded", live(doc).every((el) => el.srcObject.tracks[0] !== undefined));
  check("...a participant with no track is skipped", live(doc).length === 2);

  // And the replayed track-started for the same people changes nothing.
  const before = [...live(doc)];
  call.emit("track-started", { track: t1, participant: { session_id: "a", local: false } });
  check("the replayed track-started does not disturb the sweep",
    live(doc).length === 2 && live(doc)[0] === before[0] && before[0].playCalls === 1);
}

/* -------------------------------------------------------------------------- */

console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFAIL:");
  failures.forEach((f) => console.error(`  ${f}`));
  process.exit(1);
}
console.log("PASS — remote audio reaches an element that was asked to play it.");
