// witness.mjs — replay profile-lane's ledger through candor's WAL.
//
// The ledger's honest gap: rows are unchained JSONL. The auditor's verdict
// (`✔ STITCH` / `✘ REFUSE …`) sits in the same mutable file as the patch
// it judged — a rewritten verdict is undetectable, and a refused row leaves
// no evidence it was ever proposed. witness.mjs closes both with candor's
// gate-at-write (vendored, vendor/candor/PROVENANCE.md pins the commit):
//
//   node witness.mjs           build witness/memory.jsonl from ledger.jsonl
//   node witness.mjs --check   boot: re-verify the chain, RE-JUDGE stored
//                              payloads against the hash-committed predicate
//   node witness.mjs --catch-up  witness only the ledger rows not yet in the
//                              chain (the tick hook's mode; refuses a
//                              shrunk or rewritten ledger)
//
// catch-up is the tick hook: lane.py --tick appends one ledger row per
// round, and each row lands in the chain as it lands in the ledger — no
// batch replay step to forget, no window where a verdict sits unwitnessed.
// The referee still stands: catch-up re-derives the hash every already-
// witnessed ledger row committed to (the ledger cannot shrink or be
// rewritten under the chain), then appends the new rows in order.
//
// Semantics: the predicate is lane.py's promote rule, verbatim — a row
// passes iff its verdict starts with "✔ STITCH". A `✘ REFUSE` row books a
// visible PREDICATE-REFUSAL receipt carrying the auditor's reason; an
// unfinalized verdict (think-block, no tag) is a refusal too — a predicate
// that cannot answer is not a pass. Every attempt stays in the chain,
// hash-committed, in row order — reorder, delete, or rewrite a verdict and
// --check refuses loudly at boot.

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { CandorWAL, fnv1a64 } from './vendor/candor/wal.mjs';
import { PredicateRegistry } from './vendor/candor/predicates.mjs';
import { MemoryLayer } from './vendor/candor/memory.mjs';

export const PREDICATE_NAME = 'lane-auditor-stitch';
export const NAMESPACE = 'profile-lane/ledger';
export const WITNESS_FILE = 'witness/memory.jsonl';

// lane.py promote rule, verbatim: only a final "✔ STITCH" verdict admits a
// row. Refusals carry the auditor's one-sentence reason; anything without a
// final tag (empty verdict, truncated think-block) is unfinalized — the
// audit never completed, so the row is not admitted, and the reason says so.
export function registerLanePredicates(registry = new PredicateRegistry()) {
  registry.register(PREDICATE_NAME, (row) => {
    // Payloads are booked as JSON strings (String(payload) is what the
    // receipt hash-commits) — judge the parsed row, deterministically.
    let v;
    try {
      v = String((typeof row === 'string' ? JSON.parse(row) : row)
        ?.verdict ?? '');
    } catch { v = ''; }
    if (v.startsWith('✔ STITCH')) return { pass: true, detail: 'stitched' };
    if (v.startsWith('✘ REFUSE')) {
      const reason = v.slice('✘ REFUSE'.length).replace(/^:?\s*/, '')
        .split('\n')[0].trim();
      return { pass: false, detail: `refused: ${reason || 'no reason given'}` };
    }
    return { pass: false, detail: 'verdict unfinalized — audit never completed' };
  });
  return registry;
}

export function buildWitness({ ledgerFile = 'ledger.jsonl',
    witnessFile = WITNESS_FILE, predicates } = {}) {
  if (existsSync(witnessFile)) rmSync(witnessFile);
  const layer = new MemoryLayer({
    wal: new CandorWAL({ authority: 'profile-lane' }),
    file: witnessFile, predicates,
  });
  const rows = readFileSync(ledgerFile, 'utf8').split('\n')
    .filter(Boolean).map(JSON.parse);
  const results = [];
  for (const [i, row] of rows.entries()) {
    const r = layer.rememberJudged(NAMESPACE,
      predicates.get(PREDICATE_NAME), JSON.stringify(row), `ledger row ${i}`);
    results.push({ i, ts: row.ts, stored: r.stored, detail: r.verdict.detail });
  }
  return { layer, results };
}

export function checkWitness({ witnessFile = WITNESS_FILE,
    predicates } = {}) {
  // Boot is the referee: replay rows, re-derive every hash and link,
  // re-judge every stored payload against the hash-committed predicate.
  // A tampered verdict or payload is refused here, not silently served.
  const layer = new MemoryLayer({
    wal: new CandorWAL({ authority: 'profile-lane' }),
    file: witnessFile, predicates,
  });
  const v = layer.wal.verify();
  return { ok: v.ok, rows: layer.wal.rows.length,
    live: layer.recall(NAMESPACE).length };
}

// The payload string the chain commits to, for one ledger line: the
// canonical re-serialization (JSON.parse then JSON.stringify), exactly
// what buildWitness books via String(payload) in rememberJudged.
export function payloadForLine(line) {
  return JSON.stringify(JSON.parse(line));
}

// Incremental witness — the tick hook. Loads the existing chain (boot
// re-verifies + re-judges it), proves the ledger's already-witnessed
// prefix still hashes to what the chain committed (a shrunk or rewritten
// ledger is refused, not silently re-anchored), then appends each new
// row in order. Returns { layer, results, added, rebuilt }.
export function catchUpWitness({ ledgerFile = 'ledger.jsonl',
    witnessFile = WITNESS_FILE, predicates } = {}) {
  const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
  const existing = existsSync(witnessFile)
    ? readFileSync(witnessFile, 'utf8').split('\n').filter(Boolean)
    : [];
  const rebuilt = existing.length === 0;
  if (rebuilt) return { ...buildWitness({ ledgerFile, witnessFile,
    predicates }), added: lines.length, rebuilt };

  const layer = new MemoryLayer({
    wal: new CandorWAL({ authority: 'profile-lane' }),
    file: witnessFile, predicates,
  });
  const seen = layer.wal.rows.length;
  if (lines.length < seen) {
    throw new Error(`ledger shrank: ${seen} rows witnessed but only ` +
      `${lines.length} rows in ${ledgerFile} — the ledger is append-only; ` +
      'a shorter ledger means rows were deleted or the file was replaced');
  }
  // The witnessed prefix must still hash to what the chain committed —
  // a verdict rewritten under a live chain is refused here, at append
  // time, not silently served forever.
  for (let i = 0; i < seen; i++) {
    const expect = layer.wal.rows[i].payload_hash;
    const actual = fnvHex(payloadForLine(lines[i]));
    if (actual !== expect) {
      throw new Error(`ledger row ${i} rewritten under the chain: ` +
        `commits ${expect}, re-derives ${actual} — the ledger must not ` +
        'change under a witnessed prefix (rebuild with a fresh witness ' +
        'directory only if the rewrite is honest and disclosed)');
    }
  }
  const results = [];
  for (let i = seen; i < lines.length; i++) {
    const row = JSON.parse(lines[i]);
    const r = layer.rememberJudged(NAMESPACE,
      predicates.get(PREDICATE_NAME), payloadForLine(lines[i]),
      `ledger row ${i}`);
    results.push({ i, ts: row.ts, stored: r.stored, detail: r.verdict.detail });
  }
  const v = layer.wal.verify();
  if (!v.ok) throw new Error(`chain broken at row ${v.broken_at}`);
  return { layer, results, added: results.length, rebuilt };
}

function fnvHex(s) {
  return fnv1a64(new TextEncoder().encode(String(s)))
    .toString(16).padStart(16, '0');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const predicates = registerLanePredicates();
  if (process.argv.includes('--check')) {
    const r = checkWitness({ predicates });
    console.log(`chain ok=${r.ok} rows=${r.rows} live-payloads=${r.live}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (process.argv.includes('--catch-up')) {
    const { results, added, rebuilt } = catchUpWitness({ predicates });
    if (rebuilt) {
      const stitched = results.filter(r => r.stored).length;
      console.log(`no witness chain — rebuilt: witnessed ${results.length} ` +
        `rows (${stitched} stitched, ${results.length - stitched} refused)`);
    } else if (added === 0) {
      console.log('witness already current — no new ledger rows');
    } else {
      for (const r of results) {
        console.log(`  row ${r.i} ts=${r.ts} ` +
          `${r.stored ? 'STITCH' : 'REFUSE'} — ${r.detail}`);
      }
      console.log(`caught up: ${added} row(s) witnessed`);
    }
    process.exit(0);
  }
  const { results } = buildWitness({ predicates });
  const stitched = results.filter(r => r.stored).length;
  const refused = results.length - stitched;
  console.log(`witnessed ${results.length} rows: ${stitched} stitched, ` +
    `${refused} refused (visible in chain, payloads not stored)`);
  for (const r of results) {
    console.log(`  row ${r.i} ts=${r.ts} ` +
      `${r.stored ? 'STITCH' : 'REFUSE'} — ${r.detail}`);
  }
}
