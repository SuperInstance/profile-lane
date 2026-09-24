# profile-lane

A long-running lane that grows the [superinstance/superinstance](https://github.com/SuperInstance/superinstance) profile README.

## What it does

A "primitive quilt" of markdown patches between two cheap agents:

- **DRAFTER** ([Z.AI glm-4.5-flash](https://docs.z.ai)): proposes one self-contained markdown patch per tick. Each patch has a `claim` (what the patch says), a `source` (which receipt grounds it), and a `counter` (what could falsify it).
- **AUDITOR** ([Groq qwen3.6-27b](https://console.groq.com/)): reads the patch and replies `✔ STITCH` / `✘ REFUSE` / `↻ REVISE`. This is the **double-entry** in the lane: every claim has a counter-claim.
- **State**: `ledger.jsonl` — one row per patch, append-only, double-entry.
- **Promote**: stitches all `✔ STITCH` patches into `out/next-readme.md`. A human reads it, edits it, and pushes.

## Why a primitive quilt

The cell model is too small for a profile. But the pattern is the same: collect a terrain (digest the fleet), witness the input (audit the patch), promote what survives (merge into the README). The lane is a cell that wraps the profile, and it inherits the cell's three properties — small, addressable, receipted.

## Run it

```bash
export ZAI_TOKEN=...
export GROQ_TOKEN=...
export GITHUB_TOKEN=...
python3 lane.py --digest    # pull current fleet state → fleet.json
python3 lane.py --tick      # one round: draft + audit + ledger
python3 lane.py --promote   # merge surviving patches → out/next-readme.md

# Long-running
while true; do python3 lane.py --tick; sleep 60; done
python3 lane.py --promote  # every N rounds
```

## Doctrine it enforces

- **Hull Doctrine** — model = shell, code = rigging, data = alive.
- **Three words** — STITCH, WITNESS, PROMOTE.
- **Tone** — mildly undersell, greatly overdeliver. No "amazing", "best ever", "revolutionary", "click here", "buy now", "incredible".
- **Bootstrap the reader** — story first, then the abstraction, then what it lets them BE.
- **Hyperlinks on every phrase** — every link to a real SuperInstance repo.

## Receipts

- Lane lives at `lane.py` (228 lines, no deps beyond stdlib + `urllib`).
- Ledger: one patch per line, JSONL.
- Generated output: `out/next-readme.md`, candidate README for human review.

## Witness (candor WAL)

The ledger's rows are unchained — an auditor verdict can be rewritten
undetectably. `witness.mjs` replays the ledger through candor's
gate-at-write (`vendor/candor/`, pin in `vendor/candor/PROVENANCE.md`):

```
node witness.mjs             # build witness/memory.jsonl from ledger.jsonl
node witness.mjs --check     # boot: re-verify chain + re-judge payloads
node witness.mjs --catch-up  # witness only rows not yet in the chain
node --test                  # 11 regression pins (incl. tamper refusals)
```

`--tick` runs the catch-up itself after each row lands (best-effort;
`PROFILE_LANE_NO_WITNESS=1` skips). catch-up is a referee, not just an
appender: it re-derives the hash of every already-witnessed ledger row
and refuses a shrunk or rewritten ledger loudly — the ledger cannot
change under the chain any more than the chain can change under the
ledger.

Predicate = lane.py's promote rule verbatim: only a final `✔ STITCH`
verdict admits a row. `✘ REFUSE` rows book a visible PREDICATE-REFUSAL
receipt carrying the auditor's reason; unfinalized think-blocks are
refusals too (a predicate that cannot answer is not a pass). Refusals
store no payload but stay in the chain as evidence — deleting one breaks
the link at `--check`. Current ledger: 10 rows witnessed, 5 stitched,
5 refused (4 unfinalized, 1 audited refusal: ts 1790195742, moth-ledger/
quilt-port/moth-cells false-refuse — now hash-committed, re-judgeable).
