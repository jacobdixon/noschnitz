/* ============================================================================
   Client wrapper around the table API.

   Thin on purpose. The only real jobs are attaching the playerId to every
   request and turning the server's { error: { code, message } } envelope into
   a thrown ApiError carrying `code`, so callers branch on a stable code rather
   than matching prose.

   The one code every caller must handle is "conflict": the server rejects a
   write whose compare-and-swap lost a race, and the right response is almost
   always to let the stream deliver the winning state rather than blindly
   retrying — a retried play could land after the game has moved on.
   ========================================================================= */

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Offline, DNS, connection reset — distinct from a server-side refusal,
    // and the UI should say "can't reach the table" rather than invent a
    // game-rule reason.
    throw new ApiError("network", "Couldn't reach the table.", 0);
  }

  let payload = null;
  try { payload = await res.json(); } catch { /* empty or non-JSON body */ }

  if (!res.ok) {
    const code = payload?.error?.code || "unknown";
    throw new ApiError(code, payload?.error?.message, res.status);
  }
  return payload;
}

export const createTable = (playerId, hostName) =>
  request("/api/tables", { method: "POST", body: { playerId, hostName } });

export const joinTable = (id, playerId, name) =>
  request(`/api/tables/${encodeURIComponent(id)}/join`, { method: "POST", body: { playerId, name } });

export const getState = (id, playerId) =>
  request(`/api/tables/${encodeURIComponent(id)}/state?playerId=${encodeURIComponent(playerId)}`);

export const startHand = (id, playerId) =>
  request(`/api/tables/${encodeURIComponent(id)}/start`, { method: "POST", body: { playerId } });

export const pick = (id, playerId, action) =>
  request(`/api/tables/${encodeURIComponent(id)}/pick`, { method: "POST", body: { playerId, action } });

export const bury = (id, playerId, cards, calledSuit, calledRank = "A") =>
  request(`/api/tables/${encodeURIComponent(id)}/bury`, {
    method: "POST",
    body: { playerId, cards, calledSuit, calledRank },
  });

export const playCard = (id, playerId, card) =>
  request(`/api/tables/${encodeURIComponent(id)}/play`, { method: "POST", body: { playerId, card } });

// Every action that changes who holds a seat goes through one endpoint. They
// were five routes until Vercel's Hobby plan cap of twelve Serverless
// Functions per deployment bit — see api/tables/[id]/seat.js.
const seatAction = (id, playerId, action, extra = {}) =>
  request(`/api/tables/${encodeURIComponent(id)}/seat`, {
    method: "POST", body: { playerId, action, ...extra },
  });

// COM-3.1 — hand your seat to the AI but keep it reserved.
export const stepAway = (id, playerId) => seatAction(id, playerId, "away");

// COM-3.2 — take it back. Explicit, not automatic: a tab waking in a pocket
// is weak evidence a human is at the table.
export const takeSeatBack = (id, playerId) => seatAction(id, playerId, "back");

// The table reclaiming an abandoned seat. Not a ban.
export const bootPlayer = (id, playerId, seat) => seatAction(id, playerId, "boot", { seat });

// Give up your seat entirely, or withdraw a queued join.
export const leaveTable = (id, playerId) => seatAction(id, playerId, "leave");

// Deduped server-side exactly like joining.
export const setName = (id, playerId, name) => seatAction(id, playerId, "rename", { name });

// MP-1.2: the link that gets texted to the group.
export const tableUrl = (id) => `${window.location.origin}/t/${id}`;
