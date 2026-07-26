/* ============================================================================
   In-memory table store.

   Implements the same contract the Upstash/Redis adapter will, so the whole
   table lifecycle is testable — including the concurrency behavior — without
   a network, a store, or environment variables. This is the reference
   implementation of the contract; the Redis one has to match it.

   Contract:
     create(table)            -> { ok, table } | { ok: false, error: "exists" }
     get(id)                  -> table | null          (null when absent/expired)
     put(table, expectedVer)  -> { ok, table } | { ok: false, conflict: true, table }
     touch(id, now)           -> refreshes TTL, no version change
     del(id)                  -> void

   TTL is modeled here rather than left to the real store so tests can prove
   expiry behavior. Tables are ephemeral by design (ROADMAP: Now-phase links
   are tied to a live session), so expiry IS the cleanup story — no reaper.
   ========================================================================= */

export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export function createMemoryStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  // id -> { table, expiresAt }
  const rows = new Map();

  const live = (id, at) => {
    const row = rows.get(id);
    if (!row) return null;
    if (row.expiresAt <= at) {
      rows.delete(id);
      return null;
    }
    return row;
  };

  return {
    async create(table) {
      const at = now();
      if (live(table.id, at)) return { ok: false, error: "exists" };
      rows.set(table.id, { table, expiresAt: at + ttlMs });
      return { ok: true, table };
    },

    async get(id) {
      const row = live(id, now());
      return row ? row.table : null;
    },

    async put(table, expectedVersion) {
      const at = now();
      const row = live(table.id, at);
      if (!row) return { ok: false, error: "no-such-table" };
      if (row.table.version !== expectedVersion) {
        // Somebody else wrote between the caller's read and this write. Hand
        // back what's actually stored so the retry recomputes against it.
        return { ok: false, conflict: true, table: row.table };
      }
      rows.set(table.id, { table, expiresAt: at + ttlMs });
      return { ok: true, table };
    },

    async touch(id) {
      const at = now();
      const row = live(id, at);
      if (!row) return { ok: false, error: "no-such-table" };
      row.expiresAt = at + ttlMs;
      return { ok: true };
    },

    async del(id) {
      rows.delete(id);
    },

    // Test-only: lets a test interleave a competing write between another
    // caller's read and write to exercise the CAS path deterministically.
    _rows: rows,
  };
}
