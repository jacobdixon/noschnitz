/* ============================================================================
   Voice rooms — the Daily adapter (COM-1).

   Audio only. There is no video path here and there should not be one: the
   felt is a locked, no-scroll viewport with the seat ring absolutely
   positioned (see felt.jsx), so video tiles would mean redesigning the table.
   Hearing each other is what the interview said was doing the emotional work
   anyway — "the game is an excuse to fill the quiet spaces."

   SERVER ONLY. This module reads DAILY_API_KEY out of the environment and must
   never be imported from anything under src/ that the browser loads. The key
   is an account-wide bearer credential — it can create, list and delete every
   room we own — so it is deliberately NOT a VITE_ variable and never crosses
   the wire. The client is given a room URL and nothing else.

   Why Daily, and why there is no token endpoint here:

     Daily rooms can be PUBLIC, which means a participant joins with the room
     URL alone. That is the whole reason this file is 150 lines instead of a
     JWT-signing service with an RSA key to manage — the path we would have
     been on with Jitsi-as-a-Service or LiveKit. It also happens to match the
     trust model this project already has: the table link IS the credential
     (see src/table.js), so "anyone holding the URL may join" is not a
     weakening, it is the same rule one layer down.

   Room naming is the one part worth reading carefully. See roomNameFor.
   ========================================================================= */
import { createHmac } from "node:crypto";
import { DEFAULT_TTL_MS } from "../../src/store/memory.js";

const DAILY_API = "https://api.daily.co/v1";

// The only name we accept, and the diagnostic vocabulary around it. Same shape
// as STORE_ENV_KEYS in store.js, and for the same reason: the 503 that says a
// credential is missing has to be able to say WHICH one, or every way of
// getting it wrong produces an identical response and costs a deploy cycle per
// guess. That lesson was paid for during the production promotion; see
// CLAUDE.md.
export const VOICE_ENV_KEYS = Object.freeze(["DAILY_API_KEY"]);

const VOICEISH = /(DAILY|VOICE|AUDIO)/i;
const MAX_REPORTED = 12;

export function hasVoiceProvider(env = process.env) {
  return Boolean(env.DAILY_API_KEY);
}

/**
 * What the running deployment can see, for the 503 that says it can't see it.
 *
 * NAMES ONLY, NEVER VALUES — the same absolute rule as storeEnvReport, and for
 * a sharper reason here: DAILY_API_KEY is an account-wide credential, and this
 * body is returned to any client that triggers the failure. scripts/voicetest
 * asserts the no-value rule directly rather than trusting this comment.
 */
export function voiceEnvReport(env = process.env) {
  const accepted = {};
  for (const key of VOICE_ENV_KEYS) accepted[key] = Boolean(env[key]);

  const otherNamesPresent = Object.keys(env)
    .filter((k) => VOICEISH.test(k) && !VOICE_ENV_KEYS.includes(k))
    .sort()
    .slice(0, MAX_REPORTED);

  return { accepted, otherNamesPresent };
}

/* ------------------------------ Room naming ------------------------------- */

// The room name is an HMAC of the table code, NOT the table code itself.
//
// Using the code directly would be the obvious thing and it is wrong: the code
// is a bearer credential — anyone holding it can sit down at the table — and a
// room name is a string we hand to a third party, put in a URL, and let their
// logs and dashboard keep. src/App.jsx already redacts table codes out of
// analytics for exactly this reason; sending the same code to Daily instead
// would undo that one file over.
//
// Keyed with DAILY_API_KEY rather than a bare hash. A plain SHA-256 of an
// 8-character code from a 31-character alphabet is only ~8.5e11 preimages,
// which is brute-forceable by anyone who ever obtained a list of our room
// names. Keying it means that list is worth nothing without the key, and the
// key is already required for any of this to work — so it costs no new
// configuration, which is the only reason it is safe to depend on.
//
// Rotating the key changes what future rooms are called. That is harmless:
// live tables carry their room URL in `table.voice` (see setVoiceRoom in
// src/table.js), so a rotation is invisible to anyone already playing and only
// affects rooms minted afterwards.
export function roomNameFor(tableId, env = process.env) {
  const key = env.DAILY_API_KEY || "";
  const mac = createHmac("sha256", key).update(`noschnitz:voice:${tableId}`).digest("hex");
  return `ns-${mac.slice(0, 24)}`;
}

/* ------------------------------ Room lifetime ----------------------------- */

// Rooms expire on Daily's side rather than being cleaned up by us. A serverless
// app has no reaper process, and a room that outlives its table is quota we
// pay for and an audio room somebody could still be sitting in after the game
// is over.
//
// Matched to the table TTL because the two describe the same thing. A table
// that stays busy refreshes its TTL and can outlive this, so the room is
// re-minted when it expires — see roomIsFresh, and the re-mint path in
// api/tables/[id]/voice.js. Without that a marathon session would silently
// lose audio at the twelve-hour mark with no error anywhere.
export const ROOM_TTL_MS = DEFAULT_TTL_MS;

// The freshness rule itself lives in src/table.js (voiceRoomIsFresh), because
// setVoiceRoom needs it to decide a race and that module has to stay
// browser-safe — this one imports node:crypto. Re-exported here so the two
// halves of "when is a room past it" are reachable from one place.
export { voiceRoomIsFresh, VOICE_RENEW_MARGIN_MS } from "../../src/table.js";

/* ------------------------------- Provisioning ----------------------------- */

// Seats plus the watcher queue, which is the most people who can be at one
// table at once (SEATS + MAX_WATCHERS in src/table.js). Set explicitly so a
// stranger who obtained a room URL cannot fill it with connections we pay for.
export const MAX_ROOM_PARTICIPANTS = 13;

function roomProperties(now) {
  return {
    // Unix SECONDS, not milliseconds — Daily's field, Daily's units.
    exp: Math.floor((now + ROOM_TTL_MS) / 1000),
    max_participants: MAX_ROOM_PARTICIPANTS,
    // Audio only. start_video_off is the one that matters for what people
    // experience; the others switch off surface we have no room to render and
    // no intention of supporting.
    start_video_off: true,
    enable_screenshare: false,
    enable_chat: false,
    // We render our own join control and our own mute button in the table
    // header, so Daily's pre-join screen would be a second, conflicting UI in
    // front of a game that is already running.
    enable_prejoin_ui: false,
  };
}

/**
 * Get (or create) the Daily room for a table.
 *
 * Deterministic in the table id, so two clients racing to provision the same
 * table converge on one room rather than two. The "already exists" branch is
 * the normal outcome of that race, not an error — Daily answers 400 with a
 * name-taken message, and the fix is to read the room we just lost the race to
 * create.
 *
 * `fetchImpl` is injectable so scripts/voicetest.mjs can drive every branch —
 * including the race and the failure modes — without a network or an account.
 */
export async function ensureRoom(tableId, { now, env = process.env, fetchImpl = fetch } = {}) {
  const name = roomNameFor(tableId, env);
  const key = env.DAILY_API_KEY;
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const res = await fetchImpl(`${DAILY_API}/rooms`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, privacy: "public", properties: roomProperties(now) }),
  });

  if (res.ok) {
    const room = await res.json();
    return { url: room.url, name: room.name || name, expiresAt: now + ROOM_TTL_MS };
  }

  // Lost the race, or a room from an earlier session is still alive under the
  // same deterministic name. Either way the room we want exists; read it.
  if (res.status === 400 || res.status === 409) {
    const existing = await fetchImpl(`${DAILY_API}/rooms/${name}`, { headers });
    if (existing.ok) {
      const room = await existing.json();
      // Trust Daily's own expiry over our arithmetic: an existing room was
      // minted at some earlier `now` and expires on ITS schedule, not ours.
      // Assuming otherwise would keep a stale URL cached past the point the
      // room stops existing, which is the one failure this cache must not have.
      const exp = typeof room.config?.exp === "number" ? room.config.exp * 1000 : now + ROOM_TTL_MS;
      return { url: room.url, name: room.name || name, expiresAt: exp };
    }
  }

  // Deliberately not swallowed. A voice room that silently fails to provision
  // looks to a player exactly like one that is working but that nobody else
  // has joined — they sit in a room alone, on a games night, wondering why
  // nobody is talking. Better a visible error on the button.
  const detail = await res.text().catch(() => "");
  const err = new Error(`Daily refused to create the room (HTTP ${res.status})`);
  err.code = "voice-provider-error";
  err.status = res.status;
  err.detail = detail.slice(0, 200);
  throw err;
}
