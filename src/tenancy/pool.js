/**
 * The pool of open tenant databases.
 *
 * In SaaS mode there is one SQLite file per practice and one process serving all of them, so the
 * question "which handles are open right now?" needs one answer the whole process shares. This is
 * that answer: a map from practice id to an open database, created on first touch and closed
 * least-recently-used when the limit is reached.
 *
 * It calls `openDatabase` and nothing else. It cannot read a row and has no opinion on routing —
 * those are the reasons `src/db.js` remains untouched by tenancy. (docs/saas.md §2.3.)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabase } from '../db.js';

/** Enough for a thousand practices' working sets; the LRU keeps the ceiling real. */
export const DEFAULT_MAX_OPEN = 64;

export function createPool({ root, maxOpen = DEFAULT_MAX_OPEN }) {
  if (!root) throw new TypeError('a tenant root directory is required');
  mkdirSync(root, { recursive: true });

  const open = new Map(); // practiceId -> { db }
  let closedByLimit = 0;

  return {
    root,

    /** The practice's database, opened on first touch. Never null; the directory is made if missing. */
    get(practiceId) {
      const held = open.get(practiceId);
      if (held) {
        // Refresh the insertion order, which is what Map iterates in: the entry must look
        // recently used, or the LRU below would close the wrong file.
        open.delete(practiceId);
        open.set(practiceId, held);
        return held.db;
      }

      while (open.size >= maxOpen) {
        // Map keys iterate in insertion order, and the refresh above keeps that order honest —
        // so the first key is the least recently used.
        const evicted = open.keys().next().value;
        const victim = open.get(evicted);
        open.delete(evicted);
        try {
          victim.db.close();
        } catch {
          // A database already closed by something else is not an error the caller can act on.
        }
        closedByLimit += 1;
      }

      const db = openDatabase(join(root, practiceId, 'tickmark.db'));
      open.set(practiceId, { db });
      return db;
    },

    /** Drop one practice's handle, if it is held. Provisioning and tests use this. */
    drop(practiceId) {
      const held = open.get(practiceId);
      if (!held) return false;
      open.delete(practiceId);
      try {
        held.db.close();
      } catch {
        // As above.
      }
      return true;
    },

    /** How many handles are open, and how many the limit closed rather than a caller. */
    stats() {
      return { open: open.size, closedByLimit };
    },

    /** Close everything the pool is holding. The process exit path uses this. */
    closeAll() {
      for (const held of open.values()) {
        try {
          held.db.close();
        } catch {
          // As above.
        }
      }
      open.clear();
    },
  };
}
