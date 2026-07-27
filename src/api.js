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

export const bury = (id, playerId, cards, calledSuit) =>
  request(`/api/tables/${encodeURIComponent(id)}/bury`, { method: "POST", body: { playerId, cards, calledSuit } });

export const playCard = (id, playerId, card) =>
  request(`/api/tables/${encodeURIComponent(id)}/play`, { method: "POST", body: { playerId, card } });

// Change your display name at any point. Deduped server-side exactly like
// joining, so it can't sidestep the collision rule.
export const setName = (id, playerId, name) =>
  request(`/api/tables/${encodeURIComponent(id)}/name`, { method: "POST", body: { playerId, name } });

// The table reclaiming a seat from someone who has gone. Not a ban — see
// api/tables/[id]/boot.js.
export const bootPlayer = (id, playerId, seat) =>
  request(`/api/tables/${encodeURIComponent(id)}/boot`, { method: "POST", body: { playerId, seat } });

// COM-3.2 — take your seat back from the AI. Explicit, not automatic: see
// api/tables/[id]/back.js.
export const takeSeatBack = (id, playerId) =>
  request(`/api/tables/${encodeURIComponent(id)}/back`, { method: "POST", body: { playerId } });

// COM-3.1 — keeps the seat, hands play to the AI. Reclaiming needs no call:
// rejoining the table takes the seat back (see joinTable's reclaim path).
export const stepAway = (id, playerId) =>
  request(`/api/tables/${encodeURIComponent(id)}/away`, { method: "POST", body: { playerId } });

export const leaveTable = (id, playerId) =>
  request(`/api/tables/${encodeURIComponent(id)}/leave`, { method: "POST", body: { playerId } });

// MP-1.2: the link that gets texted to the group.
export const tableUrl = (id) => `${window.location.origin}/t/${id}`;
