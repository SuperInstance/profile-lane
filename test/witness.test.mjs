// test/witness.test.mjs — witness.mjs regression pins.
// Canonical invocation: node --test   (bare; a directory argument fails
// spuriously on Node 22 — fleet-documented gotcha.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerLanePredicates, buildWitness, checkWitness,
  PREDICATE_NAME } from '../witness.mjs';

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
