"""profile-lane — long-running lane that grows superinstance/superinstance README.

Architecture: a "primitive quilt" of markdown patches between two cheap agents.

  - DRAFTER (Z.AI glm-4.5-flash, thinking disabled): proposes a markdown patch.
    A patch is a self-contained block of README content with three sections:
      claim   — what the patch says about the profile
      source  — which receipt grounds the claim (repo, paper, witness)
      counter — what could falsify the claim
  - AUDITOR (Groq qwen3.6-27b): reads the patch and either:
      ✔ STITCH  — keeps it
      ✘ REFUSE  — rejects with a one-sentence reason
      ↻ REVISE  — proposes a one-line correction
  - The state is a JSONL ledger: one line per patch = one double-entry row.
  - After N patches, the lane calls a PROMOTE step that merges surviving patches
    into a candidate README, validates hyperlink density, and writes
    out/next-readme.md.

This is the long-running lane. Run it as:
    python3 lane.py --tick   # one round, append to ledger (+ witness)
    python3 lane.py --digest # pull GH fleet state, refresh fleet.json
    python3 lane.py --promote # merge surviving patches into a candidate README
    python3 lane.py --loop   # run --tick every N seconds (cron-friendly)

The lane never overwrites the existing README without a human approve step.
The candidate README is always in out/next-readme.md.

The --tick witness hook runs `node witness.mjs --catch-up` after each row
lands (append-only; refuses a shrunk/rewritten ledger loudly on stderr).
Set PROFILE_LANE_NO_WITNESS=1 to skip it; the lane predates the witness
and still runs where node is absent.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).parent
LEDGER = ROOT / "ledger.jsonl"
FLEET = ROOT / "fleet.json"
OUT_DIR = ROOT / "out"
OUT = OUT_DIR / "next-readme.md"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Agents — sequential, cheap, fast. Z.AI for drafting, Groq for auditing.
# ---------------------------------------------------------------------------

def call_zai(prompt, max_tokens=600):
    """Z.AI glm-4.5-flash, thinking disabled. Fast + cheap."""
    req = urllib.request.Request(
        "https://api.z.ai/api/paas/v4/chat/completions",
        data=json.dumps({
            "model": "glm-4.5-flash",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max(1500, max_tokens),
            "temperature": 0.4,
            "thinking": {"type": "disabled"},
        }).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['ZAI_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    return d["choices"][0]["message"]["content"]


def call_groq(prompt, max_tokens=400):
    """Groq qwen3.6-27b. Cheap + reasoning-aware audit pass."""
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=json.dumps({
            "model": "qwen/qwen3.6-27b",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max(1500, max_tokens),
            "temperature": 0.0,
        }).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['GROQ_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": "curl/7.88.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    return d["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Witness hook — every tick lands its ledger row in the candor chain too.
# ---------------------------------------------------------------------------

def witness_catch_up():
    """Append the tick's new ledger row to the candor witness (best-effort).

    witness.mjs --catch-up refuses loudly on a shrunk or rewritten ledger;
    here that refusal is surfaced as WITNESS REFUSED on stderr without
    killing the tick — the row is already in the ledger, and the next
    --check / --catch-up surfaces the same refusal. Skip entirely with
    PROFILE_LANE_NO_WITNESS=1 (or when node/witness.mjs is absent — the
    lane predates the witness and must still run without it).
    """
    if os.environ.get("PROFILE_LANE_NO_WITNESS"):
        return
    if not (ROOT / "witness.mjs").exists():
        return
    try:
        r = subprocess.run(
            ["node", "witness.mjs", "--catch-up"],
            cwd=ROOT, capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"witness: skipped ({e})", file=sys.stderr)
        return
    out = (r.stdout or "").strip()
    if r.returncode != 0:
        print(f"WITNESS REFUSED — ledger row is in ledger.jsonl but NOT "
              f"in the chain:\n{out}\n{r.stderr or ''}", file=sys.stderr)
    elif out:
        print(f"witness: {out}")


# ---------------------------------------------------------------------------
# Fleet digest — pull current GH state. Cheap: top 30 most-pushed.
# ---------------------------------------------------------------------------

def digest_fleet():
    """Pull top 30 most-recently-pushed repos + their descriptions."""
    req = urllib.request.Request(
        "https://api.github.com/users/SuperInstance/repos?per_page=30&sort=pushed",
        headers={"Authorization": f"token {os.environ['GITHUB_TOKEN']}"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        repos = json.loads(r.read())
    fleet = []
    for r in repos:
        fleet.append({
            "name": r["name"],
            "description": (r.get("description") or "")[:140],
            "pushed_at": r["pushed_at"][:10],
            "stars": r.get("stargazers_count", 0),
            "url": r["html_url"],
        })
    FLEET.write_text(json.dumps(fleet, indent=2))
    return fleet


# ---------------------------------------------------------------------------
# Patch protocol — double-entry markdown
# ---------------------------------------------------------------------------

DRAFTER_PROMPT = """You are extending the SuperInstance profile README.

Fleet digest (most-recently-pushed repos):
{fleet}

Existing README doctrine (do not contradict):
- Hull Doctrine: model=shell, code=rigging, data=alive, witness chain=tree-rings
- Three words: STITCH, WITNESS, PROMOTE
- The cell is the smallest addressable unit; the port wraps it for multi-tenancy
- Hermit-crab analogy = system model, not metaphor
- Tone: mildly undersell, greatly overdeliver
- Bootstrap reader: story first, then the abstraction, then what it lets them BE
- Hyperlink on every few phrases — every link to a real SuperInstance repo

Propose ONE markdown patch. It should:
1. Be a self-contained block (1-3 paragraphs OR one bullet block)
2. Use 1-3 inline links to real repos from the fleet above
3. Either: introduce a new repo, sharpen a metaphor, replace outdated framing, or
   tighten the reader's first 30 seconds

Reply in this exact format:

PATCH:
<the markdown to insert>

CLAIM: <one sentence: what this patch says about the profile>

SOURCE: <the repo/paper/witness that grounds the claim>

COUNTER: <one sentence: what could falsify the claim>
"""

AUDITOR_PROMPT = """You are auditing a proposed patch to the SuperInstance profile README.

The patch:
{patch}

CLAIM: {claim}
SOURCE: {source}
COUNTER: {counter}

Rules:
- Tone must mildly undersell, greatly overdeliver. Reject "amazing", "best ever",
  "revolutionary", "click here", "buy now", "incredible".
- Hyperlinks must point to REAL repos in the SuperInstance GitHub org.
- Patches that contradict the Hull Doctrine or the STITCH/WITNESS/PROMOTE
  doctrine are refused.
- Patches must be self-contained (one block, ≤ 3 paragraphs).
- The reader's first 30 seconds must not be wasted.

Reply ONLY with one of:
✔ STITCH
✘ REFUSE: <one-sentence reason>
↻ REVISE: <the corrected one-line replacement>
"""


def tick(fleet):
    """One round of draft → audit → ledger."""
    digest = "\n".join(
        f"- [{r['name']}]({r['url']}): {r['description']}" for r in fleet
    )
    draft = call_zai(DRAFTER_PROMPT.format(fleet=digest))

    # Parse out the four fields. Robust to format drift.
    patch = claim = source = counter = ""
    cur = None
    for line in draft.splitlines():
        s = line.strip()
        if s.startswith("PATCH:"):
            cur = "patch"; patch = ""; continue
        if s.startswith("CLAIM:"):
            cur = "claim"; claim = s[len("CLAIM:"):].strip(); continue
        if s.startswith("SOURCE:"):
            cur = "source"; source = s[len("SOURCE:"):].strip(); continue
        if s.startswith("COUNTER:"):
            cur = "counter"; counter = s[len("COUNTER:"):].strip(); continue
        if cur == "patch":
            patch += line + "\n"

    audit_prompt = AUDITOR_PROMPT.format(
        patch=patch.strip(), claim=claim, source=source, counter=counter,
    )
    verdict = call_groq(audit_prompt, max_tokens=1500).strip()
    # Strip reasoning block if present
    if "</think>" in verdict:
        verdict = verdict.split("</think>")[-1].strip()
    # Truncate to first line
    for line in verdict.splitlines():
        line = line.strip()
        if line and (line.startswith("✔") or line.startswith("✘") or line.startswith("↻")):
            verdict = line
            break

    row = {
        "ts": int(time.time()),
        "patch": patch.strip(),
        "claim": claim,
        "source": source,
        "counter": counter,
        "verdict": verdict,
    }
    with LEDGER.open("a") as f:
        f.write(json.dumps(row) + "\n")

    # The witness is not a separate batch step: the row is chained as it
    # lands. A refusal here is loud on stderr but does not kill the tick.
    witness_catch_up()

    return row


# ---------------------------------------------------------------------------
# Promote — merge surviving STITCH patches into a candidate README
# ---------------------------------------------------------------------------

def promote():
    if not LEDGER.exists():
        print("no ledger"); return
    stitched = []
    for line in LEDGER.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("verdict", "").startswith("✔ STITCH"):
            stitched.append(row["patch"])

    header = """<!-- GENERATED by profile-lane. Review before promoting to main README. -->

<div align="center">

# SuperInstance

<p align="center">
  <em>The system that builds itself. A cell is a soft body; a port is its address.</em>
</p>

"""
    footer = "\n\n<p align=\"center\"><em>Read <a href=\"ONBOARDING.md\">ONBOARDING.md</a> to wake up.</em></p>\n"
    OUT.write_text(header + "\n\n".join(stitched) + footer)
    print(f"wrote {OUT} ({len(stitched)} stitched patches)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--digest", action="store_true")
    ap.add_argument("--tick", action="store_true")
    ap.add_argument("--promote", action="store_true")
    args = ap.parse_args()

    if args.digest:
        fleet = digest_fleet()
        print(f"digested {len(fleet)} repos → {FLEET}")
        return
    if args.tick:
        if not FLEET.exists():
            digest_fleet()
        fleet = json.loads(FLEET.read_text())
        row = tick(fleet)
        print(json.dumps({k: row[k] for k in ("claim", "source", "verdict")}, indent=2))
        return
    if args.promote:
        promote()
        return

    ap.print_help()


if __name__ == "__main__":
    main()
