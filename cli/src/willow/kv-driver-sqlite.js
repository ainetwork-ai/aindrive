/**
 * KvDriverSqlite — implements the @earthstar/willow KvDriver interface on top
 * of a better-sqlite3 database, using the FDB-tuple key codec (pack/unpack)
 * from the willow package to serialize ordered KvKey arrays into BLOB keys.
 *
 * Table schema (created automatically):
 *   willow_kv(k BLOB PRIMARY KEY, v BLOB NOT NULL)
 *
 * Keys are packed with the tuple encoder so that lexicographic BLOB ordering
 * matches the semantic ordering the Willow entry driver relies on.
 */

// Use absolute paths since @earthstar/willow does not export these sub-paths.
import { pack, unpack } from "/mnt/newdata/git/aindrive/cli/node_modules/@earthstar/willow/src/store/storage/kv/key_codec/kv_key_codec.js";
import { compareKeys, isFirstKeyPrefixOfSecondKey } from "/mnt/newdata/git/aindrive/cli/node_modules/@earthstar/willow/src/store/storage/kv/types.js";

// Re-export key helpers so callers can import from one place.
export { compareKeys, isFirstKeyPrefixOfSecondKey };

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS willow_kv (
    k BLOB NOT NULL PRIMARY KEY,
    v BLOB NOT NULL
  ) WITHOUT ROWID;
`;

export class KvDriverSqlite {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this._db = db;
    db.exec(INIT_SQL);

    // Prepared statements (created lazily or eagerly — eagerly is fine here)
    this._get  = db.prepare("SELECT v FROM willow_kv WHERE k = ?");
    this._set  = db.prepare("INSERT OR REPLACE INTO willow_kv (k, v) VALUES (?, ?)");
    this._del  = db.prepare("DELETE FROM willow_kv WHERE k = ?");
    // For range scans we use ad-hoc prepared statements per call; or we prepare templates
    this._listAsc  = db.prepare("SELECT k, v FROM willow_kv WHERE k >= ? AND k < ? ORDER BY k ASC");
    this._listAscFrom = db.prepare("SELECT k, v FROM willow_kv WHERE k >= ? ORDER BY k ASC");
    this._listAscTo   = db.prepare("SELECT k, v FROM willow_kv WHERE k < ? ORDER BY k ASC");
    this._listAll     = db.prepare("SELECT k, v FROM willow_kv ORDER BY k ASC");
    this._listDesc    = db.prepare("SELECT k, v FROM willow_kv WHERE k >= ? AND k < ? ORDER BY k DESC");
    this._listDescFrom= db.prepare("SELECT k, v FROM willow_kv WHERE k >= ? ORDER BY k DESC");
    this._listDescTo  = db.prepare("SELECT k, v FROM willow_kv WHERE k < ? ORDER BY k DESC");
    this._listAllDesc = db.prepare("SELECT k, v FROM willow_kv ORDER BY k DESC");
    this._clearAll    = db.prepare("DELETE FROM willow_kv");
    this._clearRange  = db.prepare("DELETE FROM willow_kv WHERE k >= ? AND k < ?");
    this._clearFrom   = db.prepare("DELETE FROM willow_kv WHERE k >= ?");
    this._clearTo     = db.prepare("DELETE FROM willow_kv WHERE k < ?");
  }

  /** @param {import('@earthstar/willow').KvKey} key */
  get(key) {
    const packed = pack(key);
    const row = this._get.get(packed);
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve(this._deserialize(row.v));
  }

  /** @param {import('@earthstar/willow').KvKey} key */
  set(key, value) {
    const packed = pack(key);
    const serialized = this._serialize(value);
    this._set.run(packed, serialized);
    return Promise.resolve();
  }

  /** @param {import('@earthstar/willow').KvKey} key */
  delete(key) {
    const packed = pack(key);
    const info = this._del.run(packed);
    return Promise.resolve(info.changes > 0);
  }

  /**
   * List entries matching a selector.
   * The selector specifies prefix, start, and end constraints.
   * Entries matching prefix AND (start..end) are returned.
   *
   * NOTE: We implement prefix filtering in JS (post-scan) because SQLite BLOB
   * ordering on packed keys already orders them correctly; we just need to
   * filter by prefix match semantically.
   *
   * @param {{ start?: KvKey, end?: KvKey, prefix?: KvKey }} selector
   * @param {{ reverse?: boolean, limit?: number }} opts
   */
  async *list(selector, opts = {}) {
    const prefix = selector.prefix ?? [];
    const reverse = opts.reverse ?? false;
    const limit = opts.limit;

    // Compute effective byte-range for the SQL query:
    // lower bound: max(selector.start, prefix) — packed
    // upper bound: min(selector.end, successorOfPrefix) — packed
    let loBound = null;
    let hiBound = null;

    if (prefix.length > 0) {
      const packedPrefix = pack(prefix);
      // successor of prefix for upper bound
      const succ = this._successor(packedPrefix);
      hiBound = succ;
      loBound = packedPrefix;
    }

    if (selector.start !== undefined) {
      const packedStart = pack(selector.start);
      if (loBound === null || this._bufCompare(packedStart, loBound) > 0) {
        loBound = packedStart;
      }
    }

    if (selector.end !== undefined) {
      const packedEnd = pack(selector.end);
      if (hiBound === null || this._bufCompare(packedEnd, hiBound) < 0) {
        hiBound = packedEnd;
      }
    }

    // Run the appropriate SQL
    let rows;
    if (loBound !== null && hiBound !== null) {
      rows = reverse
        ? this._listDesc.all(loBound, hiBound)
        : this._listAsc.all(loBound, hiBound);
    } else if (loBound !== null) {
      rows = reverse
        ? this._listDescFrom.all(loBound)
        : this._listAscFrom.all(loBound);
    } else if (hiBound !== null) {
      rows = reverse
        ? this._listDescTo.all(hiBound)
        : this._listAscTo.all(hiBound);
    } else {
      rows = reverse
        ? this._listAllDesc.all()
        : this._listAll.all();
    }

    let count = 0;
    for (const row of rows) {
      if (limit !== undefined && count >= limit) break;

      const key = unpack(new Uint8Array(row.k));
      // Apply prefix filter semantically
      if (prefix.length > 0 && !isFirstKeyPrefixOfSecondKey(prefix, key)) continue;
      // Apply start/end semantic filters (already done in SQL, but recheck for safety)
      if (selector.start !== undefined && compareKeys(key, selector.start) < 0) continue;
      if (selector.end !== undefined && compareKeys(key, selector.end) >= 0) continue;

      yield { key, value: this._deserialize(row.v) };
      count++;
    }
  }

  /**
   * Clear entries matching the selector.
   * @param {{ prefix?: KvKey, start?: KvKey, end?: KvKey }} [opts]
   */
  async clear(opts) {
    if (!opts || (opts.prefix === undefined && opts.start === undefined && opts.end === undefined)) {
      this._clearAll.run();
      return;
    }

    const prefix = opts.prefix ?? [];
    let loBound = null;
    let hiBound = null;

    if (prefix.length > 0) {
      const packedPrefix = pack(prefix);
      const succ = this._successor(packedPrefix);
      loBound = packedPrefix;
      hiBound = succ;
    }
    if (opts.start !== undefined) {
      const ps = pack(opts.start);
      if (loBound === null || this._bufCompare(ps, loBound) > 0) loBound = ps;
    }
    if (opts.end !== undefined) {
      const pe = pack(opts.end);
      if (hiBound === null || this._bufCompare(pe, hiBound) < 0) hiBound = pe;
    }

    if (loBound !== null && hiBound !== null) {
      this._clearRange.run(loBound, hiBound);
    } else if (loBound !== null) {
      this._clearFrom.run(loBound);
    } else if (hiBound !== null) {
      this._clearTo.run(hiBound);
    }
  }

  batch() {
    const ops = [];
    const driver = this;
    return {
      set(key, value) { ops.push({ kind: "set", key, value }); },
      delete(key)     { ops.push({ kind: "delete", key }); },
      commit() {
        const tx = driver._db.transaction(() => {
          for (const op of ops) {
            if (op.kind === "set") {
              driver._set.run(pack(op.key), driver._serialize(op.value));
            } else {
              driver._del.run(pack(op.key));
            }
          }
        });
        tx();
        return Promise.resolve();
      },
    };
  }

  // ─── Internal helpers ───

  /**
   * Compute the next Uint8Array after the given prefix (for use as exclusive upper bound).
   * Increments the last byte; if overflow, walk left.
   */
  _successor(packed) {
    const buf = new Uint8Array(packed);
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] < 255) {
        buf[i]++;
        return buf.slice(0, i + 1);
      }
    }
    // All bytes are 0xFF — no successor exists; return null (unbounded)
    return null;
  }

  _bufCompare(a, b) {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return a.length - b.length;
  }

  /**
   * Serialize a JS value to a Buffer for SQLite BLOB storage.
   * We use JSON with a type-tag wrapper to handle Uint8Array, bigint, etc.
   */
  _serialize(value) {
    return Buffer.from(JSON.stringify(value, (_k, v) => {
      if (v instanceof Uint8Array) return { __t: "u8", d: Buffer.from(v).toString("base64") };
      if (typeof v === "bigint") return { __t: "bi", d: v.toString() };
      return v;
    }));
  }

  _deserialize(buf) {
    const raw = buf instanceof Buffer ? buf : Buffer.from(buf);
    return JSON.parse(raw.toString("utf8"), (_k, v) => {
      if (v && typeof v === "object" && v.__t === "u8") return new Uint8Array(Buffer.from(v.d, "base64"));
      if (v && typeof v === "object" && v.__t === "bi") return BigInt(v.d);
      return v;
    });
  }
}
