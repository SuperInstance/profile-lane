"""playtest-lane — diverse agents read the profile README and report.

The garden, not the gardener: the lane plants the README in front of N
different voices and lets each tell us what they see. The output is a
playtest report — what landed for whom, what didn't, where each voice
would plant themselves next.

Each persona runs the README through a different LLM voice (cheap fast
agents) with a different system prompt. The voices are not interchangeable;
each carries its own field and customs.

Usage:
    python3 playtest.py --run       # one full playtest pass
    python3 playtest.py --report    # consolidate latest playtest into markdown
"""

import argparse
import json
import os
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
PLAYTEST_DIR = ROOT / "playtests"
PLAYTEST_DIR.mkdir(exist_ok=True)
README_URL = "https://raw.githubusercontent.com/SuperInstance/superinstance/main/README.md"


def fetch_readme():
    """Pull the live README. If we can't, fall back to the local copy."""
    try:
        with urllib.request.urlopen(README_URL, timeout=15) as r:
            return r.read().decode()
    except Exception:
        local = Path("/workspace/research/profile-lane/last-readme.md")
        if local.exists():
            return local.read_text()
        return ""


def call_zai(prompt, max_tokens=600, system=None):
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    req = urllib.request.Request(
        "https://api.z.ai/api/paas/v4/chat/completions",
        data=json.dumps({
            "model": "glm-4.5-flash",
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": 0.6,
            "thinking": {"type": "disabled"},
        }).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['ZAI_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def call_groq(prompt, max_tokens=1500, system=None, model="qwen/qwen3.6-27b"):
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=json.dumps({
            "model": model,
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": 0.6,
        }).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['GROQ_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": "curl/7.88.0",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    return d["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Personas — each is a (name, system prompt, voice) tuple. The voice picks
# which LLM actually speaks. The system prompt shapes the field/customs.
# ---------------------------------------------------------------------------

PERSONAS = [
    {
        "name": "marine_engineer",
        "label": "Marine engineer (instrumentation, NMEA 2000)",
        "system": (
            "You are a 30-year marine engineer who has wired NMEA 2000 backbones "
            "on commercial vessels. You have heard 'AI will revolutionize "
            "boating' from every vendor since 2015. You are skeptical but you "
            "stay because you love the work. You read technical documentation "
            "for the architecture, not the metaphors. When a metaphor gets in "
            "the way of a precise claim, you push back."
        ),
        "voice": "zai",
    },
    {
        "name": "github_first_timer",
        "label": "First-time GitHub visitor (high schooler, curious)",
        "system": (
            "You are a 17-year-old who just discovered GitHub. You don't know "
            "what an LLM is. You are here because a friend said this site was "
            "cool. You read for the story. You do not know what FNV-1a means. "
            "You do not care what a substrate is. You are looking for: is this "
            "for me? What would I do here? Where do I start?"
        ),
        "voice": "groq",
    },
    {
        "name": "game_designer",
        "label": "Game designer (systems, mechanics, NPC behavior)",
        "system": (
            "You are a game designer who has shipped two roguelikes and one "
            "MMO. You think in systems: agents, NPCs, feedback loops, "
            "economies, emergence. When you read documentation, you translate "
            "it into 'is this a mechanic? a system? a content drop?' You are "
            "looking for: what would this feel like to play? Where are the "
            "verbs? What's the simulation?"
        ),
        "voice": "groq",
    },
    {
        "name": "educator",
        "label": "Educator (community-college CS teacher, first-gen)",
        "system": (
            "You teach intro CS at a community college. Your students are "
            "first-generation, mostly working adults. You are always looking "
            "for material that hooks a beginner without lying to them. When "
            "you read documentation, you ask: would I assign this? Where "
            "would my student get stuck? What would I need to add to make "
            "this their first PR?"
        ),
        "voice": "zai",
    },
]

PROMPT_TEMPLATE = """You are reading the SuperInstance project README.

README (current canon):
{readme}

Read it as a {persona_label}. Then answer four questions, each in 1-3 sentences:

1. LANDED: What one part of the README spoke to you? Quote the line.
2. DID_NOT_LAND: What one part confused or put you off? Be specific.
3. WHERE_I_PLANT_MYSELF: If you were to engage with this project tomorrow,
   what is the smallest first step you'd take? Be concrete.
4. WHAT_I_WOULD_PLANT: If you were given a fork and a week, what one
   small contribution would you make — not to the project itself, but
   to make it more hospitable to someone like you?

Reply in plain text. No headings, no bullets, no JSON. Just four short
paragraphs, one per question. Stay in character; do not break the fourth
wall; do not say "as an AI".
"""


def playtest_persona(readme, persona):
    """Run one persona through the README. Returns the response."""
    prompt = PROMPT_TEMPLATE.format(
        readme=readme[:6000],  # truncate for token budget
        persona_label=persona["label"],
    )
    if persona["voice"] == "zai":
        out = call_zai(prompt, max_tokens=600, system=persona["system"])
    else:
        out = call_groq(prompt, max_tokens=1500, system=persona["system"])
    return out


def run():
    readme = fetch_readme()
    if not readme:
        print("no README found"); return
    # Save for offline replay
    Path("/workspace/research/profile-lane/last-readme.md").write_text(readme)

    ts = int(time.time())
    out = {"ts": ts, "readme_sha": "live", "personas": []}
    for p in PERSONAS:
        print(f"  playing {p['name']}…", end=" ", flush=True)
        try:
            response = playtest_persona(readme, p)
            print("✓")
        except Exception as e:
            response = f"(playtest failed: {e})"
            print(f"✗ {e}")
        out["personas"].append({
            "name": p["name"],
            "label": p["label"],
            "voice": p["voice"],
            "response": response,
        })

    path = PLAYTEST_DIR / f"{ts}.json"
    path.write_text(json.dumps(out, indent=2))
    print(f"  wrote {path}")


def report():
    """Consolidate the latest playtest into a markdown report."""
    files = sorted(PLAYTEST_DIR.glob("*.json"))
    if not files:
        print("no playtests yet"); return
    latest = json.loads(files[-1].read_text())

    lines = [
        f"# Playtest report — {latest['ts']}",
        "",
        "Four personas, four voices, one README. Each planted in the soil.",
        "",
    ]
    for p in latest["personas"]:
        lines.append(f"## {p['label']}  (voice: {p['voice']})")
        lines.append("")
        lines.append(p["response"])
        lines.append("")
        lines.append("---")
        lines.append("")

    out = ROOT / "playtest-report.md"
    out.write_text("\n".join(lines))
    print(f"wrote {out} ({len(latest['personas'])} personas)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()
    if args.run: run()
    elif args.report: report()
    else: ap.print_help()


if __name__ == "__main__":
    main()
