// test/witness.test.mjs — witness.mjs regression pins.
// Canonical invocation: node --test   (bare; a directory argument fails
// spuriously on Node 22 — fleet-documented gotcha.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerLanePredicates, buildWitness, checkWitness,
  catchUpWitness, payloadForLine, PREDICATE_NAME } from '../witness.mjs';

function fixture(dir, rows) {
  const ledger = join(dir, 'ledger.jsonl');
  writeFileSync(ledger, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return ledger;
}

const ROWS = [
  { ts: 1, patch: 'p0', verdict: '✔ STITCH' },
  { ts: 2, patch: 'p1', verdict: '✘ REFUSE: broken link' },
  { ts: 3, patch: 'p2', verdict: '<think>never finished' },
  { ts: 4, patch: 'p3', verdict: '' },
  { ts: 5, patch: 'p4', verdict: '✔ STITCH' },
];

test('gate-at-write: only final ✔ STITCH rows are stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS);
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  const { layer, results } = buildWitness({ ledgerFile: ledger,
    witnessFile: witness, predicates });
  assert.equal(results.length, 5);
  assert.deepEqual(results.map(r => r.stored),
    [true, false, false, false, true]);
  // The refusal carries the auditor's reason; unfinalized says why.
  assert.match(results[1].detail, /refused: broken link/);
  assert.match(results[2].detail, /unfinalized/);
  assert.match(results[3].detail, /unfinalized/);
  // Chain is contiguous and verifies; refusals are rows, not absences.
  assert.equal(layer.wal.rows.length, 5);
  assert.ok(layer.wal.verify().ok);
  // Judgment identity is hash-committed in every row.
  const p = predicates.get(PREDICATE_NAME);
  assert.ok(layer.wal.rows.every(r =>
    r.predicate === `${PREDICATE_NAME}#${p.hash}`));
  // Stored payloads replay through recall(); refused ones are absent.
  assert.equal(layer.recall('profile-lane/ledger').length, 2);
});

test('boot: --check re-verifies the chain and re-judges payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS);
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  buildWitness({ ledgerFile: ledger, witnessFile: witness, predicates });
  const r = checkWitness({ witnessFile: witness, predicates });
  assert.equal(r.ok, true);
  assert.equal(r.rows, 5);
  assert.equal(r.live, 2);
});

test('at-rest tamper: a rewritten verdict is refused at boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS);
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  buildWitness({ ledgerFile: ledger, witnessFile: witness, predicates });
  // The attack: flip a refused row's verdict to ✔ STITCH in the store.
  const lines = readFileSync(witness, 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l));
  const payload = lines.find(l =>
    l.kind === 'payload' && l.entry?.receipt_seq === 4);
  assert.ok(payload, 'expected the seq-4 STITCH payload line');
  payload.entry.payload = payload.entry.payload.replace('✔ STITCH', '');
  writeFileSync(witness, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.throws(() => checkWitness({ witnessFile: witness, predicates }),
    /payload at receipt 4 fails re-derivation/);
});

test('chain tamper: a deleted refusal row breaks the link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS);
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  buildWitness({ ledgerFile: ledger, witnessFile: witness, predicates });
  const lines = readFileSync(witness, 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l));
  // Delete the seq-1 REFUSAL row (keep payloads) — amputating the chain.
  const kept = lines.filter(l =>
    !(l.kind === 'row' && l.row.seq === 1));
  writeFileSync(witness, kept.map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.throws(() => checkWitness({ witnessFile: witness, predicates }),
    /chain broken/);
});

test('predicates are immutable: a swapped rule cannot wear the same name', () => {
  const predicates = registerLanePredicates();
  assert.throws(() => predicates.register(PREDICATE_NAME, () => true),
    /already registered with a different body/);
  // Same body re-registers fine (idempotent — identity is not costume).
  assert.doesNotThrow(() => registerLanePredicates(predicates));
});

// --- catch-up: the tick hook -------------------------------------------------

test('catch-up: appends only new rows, chain links hold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS.slice(0, 3));
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  buildWitness({ ledgerFile: ledger, witnessFile: witness, predicates });
  const before = readFileSync(witness, 'utf8');

  // Two more ticks land.
  writeFileSync(ledger, ROWS.map(r => JSON.stringify(r)).join('\n') + '\n');
  const r = catchUpWitness({ ledgerFile: ledger, witnessFile: witness,
    predicates });
  assert.equal(r.rebuilt, false);
  assert.equal(r.added, 2);
  assert.deepEqual(r.results.map(x => x.stored), [false, true]); // p3 refuse, p4 stitch
  assert.match(r.results[0].detail, /unfinalized/);

  // Chain is contiguous: the appended rows link onto the old tip.
  assert.equal(r.layer.wal.rows.length, 5);
  for (let i = 1; i < 5; i++) {
    assert.equal(r.layer.wal.rows[i].prev_hash, r.layer.wal.rows[i - 1].hash);
  }
  assert.ok(r.layer.wal.verify().ok);
  // The 3-row prefix is untouched; only 2 rows were appended.
  const after = readFileSync(witness, 'utf8');
  assert.ok(after.startsWith(before.trimEnd()),
    'catch-up must append, never rewrite');
  // Boot still re-judges the full chain.
  const c = checkWitness({ witnessFile: witness, predicates });
  assert.equal(c.ok, true);
  assert.equal(c.rows, 5);
  assert.equal(c.live, 2);
});

test('catch-up: no-op when the ledger is unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS);
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  buildWitness({ ledgerFile: ledger, witnessFile: witness, predicates });
  const before = readFileSync(witness, 'utf8');
  const r = catchUpWitness({ ledgerFile: ledger, witnessFile: witness,
    predicates });
  assert.equal(r.rebuilt, false);
  assert.equal(r.added, 0);
  assert.deepEqual(r.results, []);
  assert.equal(readFileSync(witness, 'utf8'), before,
    'a no-op catch-up leaves the store byte-identical');
});

test('catch-up: no witness file rebuilds from scratch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS.slice(0, 2));
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  const r = catchUpWitness({ ledgerFile: ledger, witnessFile: witness,
    predicates });
  assert.equal(r.rebuilt, true);
  assert.equal(r.added, 2);
  assert.equal(r.layer.wal.rows.length, 2);
  assert.ok(r.layer.wal.verify().ok);
});

test('catch-up: a shrunk ledger is refused (no-delete applies to the ledger too)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS);
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  buildWitness({ ledgerFile: ledger, witnessFile: witness, predicates });
  // The ledger loses its last two rows — deletion, not relocation.
  writeFileSync(ledger, ROWS.slice(0, 3).map(r => JSON.stringify(r))
    .join('\n') + '\n');
  assert.throws(() => catchUpWitness({ ledgerFile: ledger,
    witnessFile: witness, predicates }), /ledger shrank/);
});

test('catch-up: a verdict rewritten under the chain is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const ledger = fixture(dir, ROWS);
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  buildWitness({ ledgerFile: ledger, witnessFile: witness, predicates });
  // The attack from the other side: launder a refusal in the MUTABLE
  // ledger, then catch up. The witnessed prefix no longer re-derives.
  const tampered = ROWS.map(r => ({ ...r }));
  tampered[1].verdict = '✔ STITCH';
  writeFileSync(ledger, tampered.map(r => JSON.stringify(r))
    .join('\n') + '\n');
  assert.throws(() => catchUpWitness({ ledgerFile: ledger,
    witnessFile: witness, predicates }), /rewritten under the chain/);
  // And the witness file itself is untouched — refusal stores nothing.
  const c = checkWitness({ witnessFile: witness, predicates });
  assert.equal(c.ok, true);
  assert.equal(c.rows, 5);
});

test('payloadForLine: canonical re-serialization matches the committed hash', () => {
  // The chain commits fnv1a64(JSON.stringify(JSON.parse(line))) — the
  // catch-up referee must re-derive exactly that, or honest rows get
  // refused and rewritten ones get served.
  const dir = mkdtempSync(join(tmpdir(), 'witness-'));
  const rows = [{ ts: 9, patch: 'x', verdict: '✔ STITCH' }];
  const ledger = fixture(dir, rows);
  const witness = join(dir, 'memory.jsonl');
  const predicates = registerLanePredicates();
  const { layer } = buildWitness({ ledgerFile: ledger,
    witnessFile: witness, predicates });
  const line = readFileSync(ledger, 'utf8').split('\n')[0];
  assert.equal(layer.wal.rows[0].payload_hash,
    payloadHashOf(payloadForLine(line)));
});

function payloadHashOf(s) {
  // Local re-derivation of the wal's hashing (fnv1a64 over UTF-8 bytes).
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(String(s))) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

