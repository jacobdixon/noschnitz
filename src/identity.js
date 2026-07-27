/* ============================================================================
   Guest identity — MP-3.1 and MP-3.2.

   No accounts, no passwords, no signup: type a name and sit down. Identity is
   a random token in localStorage, which is what makes "a returning guest on
   the same device keeps their seat" work without anyone logging in.

   That token IS the authorization to act as your seat — the server resolves
   every request through seatOf(playerId) and there is no second factor. Two
   consequences worth being clear-eyed about:

   - Anyone who obtains your playerId can play your cards. The server never
     echoes anyone else's token back (see api/_lib/redact.js), so the exposure
     is your own device, which is the same trust level as the table link
     itself.
   - Clearing site data loses your seat. You'd rejoin as a new guest and take
     an AI seat, which for a card game among friends is a fine failure mode.

   Good enough for a friend group playing on a whim; explicitly not good
   enough for ranked or public tables, which is a `Later` problem.
   ========================================================================= */

const ID_KEY = "noschnitz.playerId";
const NAME_KEY = "noschnitz.playerName";

// Private-mode Safari and locked-down browsers throw on localStorage access
// rather than returning null, and a thrown error here would blank the whole
// app. Fall back to an in-memory identity: the player can still play, they
// just won't be remembered after a refresh.
let memoryFallback = { id: null, name: null };

function safeGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
}

function newToken() {
  // crypto.randomUUID isn't available on older mobile Safari, which is exactly
  // the audience here (friends on whatever phone they have).
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getPlayerId() {
  const existing = safeGet(ID_KEY);
  if (existing) return existing;
  if (memoryFallback.id) return memoryFallback.id;

  const token = newToken();
  if (!safeSet(ID_KEY, token)) memoryFallback.id = token;
  return token;
}

// MP-3.2: remembered so a returning guest doesn't retype their name.
export function getPlayerName() {
  return safeGet(NAME_KEY) || memoryFallback.name || "";
}

export function setPlayerName(name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (!safeSet(NAME_KEY, clean)) memoryFallback.name = clean;
  return clean;
}
