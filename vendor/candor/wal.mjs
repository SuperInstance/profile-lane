// wal.mjs — namespaced hash-chained memory-write receipts for candor.
//
// Positioning (docs/RECEIPTS.md): the unclaimed defense candidate against
// persistent-memory attacks (arXiv 2605.08442) is not input filtering or
// retrieval screening — it is the WRITE PATH. Every memory write is booked
// as a receipt row: {seq, prev_hash, namespace, predicate, payload_hash,
// authority}. The chain is FNV-1a-64 (same family as the fleet bookkeeper);
// a row's hash commits to its payload_hash AND the previous row's hash, so
// reordering, deletion, or payload swap is detectable on verify().
//
// REVOKE is authority-without-erasure (substrate-revoke canon): a REVOKE row
// voids the AUTHORITY of prior rows in a namespace without deleting them.
// No-delete is the defense: the poisoned write stays in the chain, visible,
// marked inert. A revoked row verifies structurally but reports
// authority:'revoked'.
//
// Honest gaps: in-process only (no cross-node non-repudiation — that is the
// receipts-v2 signature envelope, deferred until a real two-node dispute);
// predicates are caller-named strings, not evaluated here.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64(bytes) {
  let h = FNV_OFFSET;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

export function canonical(row) {
  // Deterministic serialization: field order fixed, JSON-with-no-spaces.
  return JSON.stringify([
    row.seq, row.prev_hash, row.namespace, row.predicate,
    row.payload_hash, row.authority, row.note ?? null, row.detail ?? null,
  ]);
}

export class CandorWAL {
  constructor({ authority = 'candor' } = {}) {
    this.authority = authority;
    this.rows = [];
    this.tip = '0'.repeat(16); // genesis prev_hash, 64-bit zero
    this.revokedSeqs = new Set(); // instance-side mirror for live targeting
  }

  #append(partial) {
    const row = { seq: this.rows.length, prev_hash: this.tip, ...partial };
    row.hash = fnv1a64(new TextEncoder().encode(canonical(row)))
      .toString(16).padStart(16, '0');
    this.rows.push(row);
    this.tip = row.hash;
    return row;
  }

  // Book a memory write. payload is hashed, not retained — the WAL commits
  // to the write, the memory layer keeps the payload (separation of
  // authority and storage).
  write(namespace, predicate, payload, note) {
    if (!namespace || !predicate) {
      throw new TypeError('namespace and predicate are required');
    }
    const payloadHash = typeof payload === 'string' && payload.length === 16
      && /^[0-9a-f]{16}$/.test(payload)
      ? payload // already a hash — callers may pre-hash large payloads
      : fnv1a64(new TextEncoder().encode(String(payload)))
          .toString(16).padStart(16, '0');
    return this.#append({
      namespace: String(namespace),
      predicate: String(predicate),
      payload_hash: payloadHash,
      authority: this.authority,
      ...(note !== undefined ? { note: String(note) } : {}),
    });
  }

  // Authority-without-erasure: voids authority for rows matching
  // (namespace, predicate). Rows stay in the chain. note explains why.
  revoke(namespace, predicate, note) {
    const target = this.rows.filter(
      r => r.namespace === namespace && r.predicate === predicate
        && r.authority !== null && r.note !== 'REVOKE'
        && !this.revokedSeqs.has(r.seq));
    if (target.length === 0) {
      // Honest refusal: revoking nothing is booked as a refusal row, never
      // silently succeeds — an attacker who can call revoke must leave
      // evidence even when the call is a no-op.
      return this.#append({
        namespace: String(namespace), predicate: String(predicate),
        payload_hash: '0'.repeat(16), authority: null,
        note: 'REVOKE-REFUSAL', detail: 'no live rows matched',
      });
    }
    for (const r of target) this.revokedSeqs.add(r.seq);
    return this.#append({
      namespace: String(namespace), predicate: String(predicate),
      payload_hash: fnv1a64(new TextEncoder().encode(
        target.map(r => r.hash).sort().join(',')))
        .toString(16).padStart(16, '0'),
      authority: null, // the REVOKE row itself carries no authority
      note: 'REVOKE',
      ...(note !== undefined ? { detail: String(note) } : {}),
    });
  }

  // Structural verification: re-derive every hash and every link.
  // Returns {ok, rows:[{seq, namespace, predicate, authority}]} where
  // authority is 'live' | 'revoked' | null (rows born without authority).
  verify() {
    let prev = '0'.repeat(16);
    const revoked = new Set();
    const checked = [];
    for (const row of this.rows) {
      const expect = fnv1a64(new TextEncoder().encode(canonical(row)))
        .toString(16).padStart(16, '0');
      if (row.seq !== checked.length || row.prev_hash !== prev || row.hash !== expect) {
        return { ok: false, broken_at: row.seq };
      }
      prev = row.hash;
      checked.push(row);
    }
    // Resolve authority in a second pass: a REVOKE covers rows that were
    // live when it was booked (seq < revoke seq, not already revoked).
    for (const row of checked) {
      if (row.note !== 'REVOKE') continue;
      for (const r of checked) {
        if (r.seq < row.seq && r.namespace === row.namespace
            && r.predicate === row.predicate && r.note !== 'REVOKE'
            && r.note !== 'REVOKE-REFUSAL' && !revoked.has(r.seq)
            && r.authority !== null) {
          revoked.add(r.seq);
        }
      }
    }
    return { ok: true, rows: checked.map(row => ({
      seq: row.seq, namespace: row.namespace, predicate: row.predicate,
      authority: row.authority === null ? null
        : revoked.has(row.seq) ? 'revoked' : 'live',
    })) };
  }
}
