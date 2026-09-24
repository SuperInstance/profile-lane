# Vendored: candor WAL (witness plumbing)

Source: SuperInstance/candor @ 33f9513bcdff3136f0b6756fe70a22bed338a7b0 (main, 2026-09-22)
Files: wal.mjs, predicates.mjs, memory.mjs — copied verbatim, no edits.
License/canon: candor repo (SuperInstance org).

Why vendored: profile-lane's ledger rows are currently unchained JSONL —
the lane's auditor emits `✔ STITCH` / `✘ REFUSE` verdicts, but nothing
binds those verdicts to the rows they judged, and a rewritten verdict is
undetectable. witness.mjs replays the ledger through candor's
`rememberJudged` (gate-at-write): every row books a hash-chained receipt,
STITCH rows are stored, REFUSE/unfinalized rows book a visible
PREDICATE-REFUSAL receipt and store nothing — but the attempt stays in
the chain as evidence. Boot re-verifies the chain and RE-JUDGES stored
payloads against the hash-committed predicate.

Update policy: bump this pin as a deliberate commit; never vendor main's
tip silently.
