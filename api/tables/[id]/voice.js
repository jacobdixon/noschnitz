/* ============================================================================
   POST /api/tables/[id]/voice — get this table's audio room (COM-1.1).

   Body: { playerId }
   200:  { voice: { url, expiresAt } }
   403:  you aren't at this table
   404:  no such table (or it expired)
   502:  the provider refused
   503:  voice isn't enabled here, or has no provider configured

   POST rather than GET because it is a provisioning call: the first person to
   ask causes a room to be created at Daily and written to the table. It is
   idempotent — everyone after the first gets the cached room back — but it is
   not a read, and calling it should look like doing something.

   The room URL is public in the sense that matters: anyone holding it can join
   the call without a token (see api/_lib/voice.js for why that is the right
   trade and not a shortcut). What gates it is the same thing that gates every
   other table action — you have to be AT the table. That check is the reason
   this route exists at all rather than the client deriving the room name for
   itself.
   ========================================================================= */
import { seatOf, setVoiceRoom, voiceRoomIsFresh } from "../../../src/table.js";
import { mutate } from "../../../src/store/mutate.js";
import { getStore } from "../../_lib/store.js";
import { readJson, sendJson, fail, methodGuard } from "../../_lib/http.js";
import { requireVoice } from "../../_lib/flags.js";
import { ensureRoom } from "../../_lib/voice.js";

// Seated, or queued and watching. Both are "at the table" — a watcher arrived
// from the link, gave a name, and is announced to the room (see watcherNotice),
// so keeping them out of the conversation while they wait for a seat would be
// exactly backwards: they are the person with the least to do and the most
// reason to want to talk to somebody.
//
// Anyone else is refused. Not because the URL is a secret worth much on its own
// — it isn't, and the table code that leads here is the real credential — but
// because provisioning costs a call to a third party and a slot of their quota,
// and an unauthenticated endpoint that spends money is a bad idea however
// cheap each call is.
function atTable(table, playerId) {
  if (seatOf(table, playerId) >= 0) return true;
  return (table.pendingJoins || []).some((p) => p.playerId === playerId);
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;
  if (!requireVoice(res)) return;

  const { id } = req.query || {};
  if (!id) return fail(res, 400, "bad-request", "Missing table id.");

  const body = (await readJson(req)) || {};
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  if (!playerId) return fail(res, 400, "bad-request", "playerId is required.");

  const store = getStore();
  const now = Date.now();

  // Read first, and take the cached room if it is still good. The overwhelming
  // majority of calls end here: four other people tapping "Join audio" after
  // the first one did.
  const existing = await store.get(id);
  if (!existing) return fail(res, 404, "no-such-table", "That table doesn't exist.");
  if (!atTable(existing, playerId)) {
    return fail(res, 403, "not-at-table", "You aren't at this table.");
  }
  if (voiceRoomIsFresh(existing.voice, now)) {
    return sendJson(res, 200, { voice: existing.voice });
  }

  // Provision. Deliberately OUTSIDE mutate(): the mutation function there must
  // stay pure and synchronous, because the CAS loop can call it several times
  // against different states and a network call inside it would be repeated
  // per attempt. So the slow, impure part happens once, and only its RESULT
  // goes through the loop.
  let voice;
  try {
    voice = await ensureRoom(id, { now });
  } catch (e) {
    // 502, not 500: nothing here is broken, the upstream said no. The code is
    // stable so the client can say "audio isn't available right now" rather
    // than showing a raw failure over a card table.
    return fail(res, 502, e.code || "voice-provider-error", "Couldn't set up the audio room.");
  }

  const out = await mutate(store, id, (table) => setVoiceRoom(table, { voice, now }));

  if (!out.ok) {
    if (out.error === "no-such-table") return fail(res, 404, "no-such-table", "That table doesn't exist.");
    return fail(res, 409, "conflict", "The table changed while starting audio. Try again.");
  }

  // Read the room off the WRITTEN table rather than echoing what we just
  // provisioned. If another request won the race and cached a different room
  // first, setVoiceRoom kept theirs — and sending ours instead would put this
  // one player in a room of their own while everyone else talks in the other.
  return sendJson(res, 200, { voice: out.table.voice });
}
