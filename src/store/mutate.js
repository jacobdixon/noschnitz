/* ============================================================================
   Compare-and-swap mutation loop — store-agnostic.

   Serverless functions are stateless and concurrent: two players can hit two
   different instances in the same millisecond, both holding the same table.
   A naive read-modify-write loses one of those plays silently, which in a card
   game means a card vanishes or a trick resolves twice.

   Every write goes through here instead. Read the table with its version,
   compute the next state purely, and write only if the stored version hasn't
   moved. If it has, someone else got there first — discard our computation and
   retry against their result. The engine and table functions are pure, so
   recomputing is always safe; that's the property this depends on.

   This is the ONLY place a table should be written. An API route that reaches
   past it to store.put() directly reintroduces the race it exists to prevent.
   ========================================================================= */

export const MAX_RETRIES = 8;

// `fn` is a pure function of the current table. It may return either the next
// table, or { table, ...extra } when the caller needs something back besides
// the new state (which seat you landed in, whether the join was queued, ...).
// Returning the table unchanged means "nothing to write" and skips the round
// trip entirely — the common case for a rejected join or a presence ping.
export async function mutate(store, id, fn, { retries = MAX_RETRIES } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const current = await store.get(id);
    if (!current) return { ok: false, error: "no-such-table" };

    const expected = current.version;
    const out = fn(current);
    const next = out && out.table !== undefined ? out.table : out;
    const extra = out && out.table !== undefined ? out : {};

    if (!next || next === current) {
      return { ok: true, table: current, ...extra, wrote: false };
    }

    const res = await store.put(next, expected);
    if (res.ok) return { ok: true, table: res.table, ...extra, wrote: true, attempts: attempt + 1 };
    // Conflict: another writer landed between our read and write. Loop.
  }

  // Eight straight losses means something is wrong — a hot loop of writers, or
  // a client retrying in a tight cycle. Surfacing it beats spinning forever.
  return { ok: false, error: "conflict", attempts: retries + 1 };
}
