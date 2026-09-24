// predicates.mjs — deterministic predicates with hash-committed identity.
//
// The WAL's honest gap was: "predicates are caller-named strings, not
// evaluated here — the WAL books claims, it does not judge them." This
// module closes that gap on the WRITE side, which is where the receipts
// lane's positioning lives: gate-at-write, not post-hoc detection
// (forensic trajectory signatures, arXiv 2606.30566, AUC 0.9904, prove
// detection is commoditizing; the unclaimed defense is at the write path,
// arXiv 2605.08442).
//
// Contract:
// - A predicate is { name, source, hash, evaluate(payload) }.
// - evaluate MUST be pure and deterministic: same payload -> same verdict,
//   every time, on any node. That is what makes a booked judgment
//   re-derivable at boot (replay-verify extends from the chain to the
//   verdicts).
// - Predicates are IMMUTABLE once registered: re-registering a name with a
//   different body throws. A changed judgment rule is a NEW predicate
//   (new name); silently swapping the rule under a booked verdict would
//   launder exactly the attack this gate exists to catch.
// - The predicate's source is hash-committed (FNV-1a-64, fleet family) at
//   registration. Judged receipt rows book {predicate_name, predicate_hash,
//   verdict}, so any auditor knows exactly WHICH rule judged, and can
//   re-judge from source.

import { fnv1a64 } from './wal.mjs';

export class PredicateRegistry {
  constructor() {
    this.predicates = new Map(); // name -> { name, source, hash, evaluate }
  }

  // Register a deterministic predicate. fn.toString() is the committed
  // source; two registrations of the same name must commit to the same
  // source, or the second throws (identity is not costume).
  register(name, fn) {
    if (!name || typeof fn !== 'function') {
      throw new TypeError('predicate needs a name and an evaluate function');
    }
    const source = fn.toString();
    const hash = fnv1a64(new TextEncoder().encode(source))
      .toString(16).padStart(16, '0');
    const existing = this.predicates.get(name);
    if (existing) {
      if (existing.hash !== hash) {
        throw new Error(
          `predicate '${name}' already registered with a different body ` +
          `(${existing.hash} vs ${hash}) — predicates are immutable; ` +
          'a changed judgment rule is a new predicate');
      }
      return existing;
    }
    const predicate = { name, source, hash, evaluate: fn };
    this.predicates.set(name, predicate);
    return predicate;
  }

  get(name) {
    const p = this.predicates.get(name);
    if (!p) throw new Error(`predicate '${name}' is not registered`);
    return p;
  }
}

// Re-judge a payload against a predicate entry, normalizing the verdict
// into { pass, detail }. evaluate() may return boolean or
// { pass, detail }; anything else is a refusal with the honest reason
// (a predicate that cannot answer is not a pass).
export function judge(predicate, payload) {
  let raw;
  try {
    raw = predicate.evaluate(payload);
  } catch (err) {
    return { pass: false, detail: `predicate threw: ${err.message}` };
  }
  if (typeof raw === 'boolean') return { pass: raw, detail: raw ? 'ok' : 'predicate returned false' };
  if (raw && typeof raw === 'object' && typeof raw.pass === 'boolean') {
    return { pass: raw.pass, detail: String(raw.detail ?? (raw.pass ? 'ok' : 'refused')) };
  }
  return { pass: false, detail: 'predicate returned a non-verdict — not a pass' };
}
