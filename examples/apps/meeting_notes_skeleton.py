"""
Meeting-notes skeleton — minimal end-to-end on mnueron.

What this shows:
  1. Read a transcript file (you bring your own — Deepgram/AssemblyAI/
     mac dictation/anything).
  2. Use Claude to extract structured items: decisions, action items,
     and a summary.
  3. Save each as its own searchable mnueron memory in a per-meeting
     namespace.
  4. Expose a recall(query) function for the UI or for the next
     conversation about this meeting.

Why this is a "skeleton" not an app:
  - No UI (CLI invocation only).
  - No audio capture (drop in a Deepgram client here).
  - No user system (one-meeting-per-process). For multi-tenant SaaS,
    use namespace="meeting-{meeting_id}-user-{user_id}" or similar.

Run:
    pip install mnueron anthropic
    export ANTHROPIC_API_KEY=sk-ant-...
    export MNUERON_API_TOKEN=mnu_...               # optional; omit for local
    python meeting_notes_skeleton.py transcript.txt
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass

# These imports are mnueron's Python SDK and Anthropic's SDK. If you don't
# have the mnueron SDK installed yet:
#   pip install mnueron
# (or for hacking on a local clone of the mnueron repo:
#   pip install -e sdks/python)
from mnueron import Mnueron        # type: ignore[import-not-found]
import anthropic                    # type: ignore[import-not-found]


# ─── Config ──────────────────────────────────────────────────────────────
# Provider auto-selection: when MNUERON_API_URL is set we hit the hosted
# backend; otherwise we use the local SQLite store at ~/.mnueron/. Same
# SDK call sites either way.
def make_mem(meeting_id: str) -> Mnueron:
    return Mnueron(
        api_url=os.environ.get("MNUERON_API_URL"),       # None = local
        api_key=os.environ.get("MNUERON_API_TOKEN", ""),
    )


# Pick a model good at structured extraction. Claude Haiku 4.5 is cheap
# and accurate for this scale; swap for sonnet/opus for higher quality.
LLM_MODEL = "claude-haiku-4-5"


# ─── Extraction ──────────────────────────────────────────────────────────
@dataclass
class Decision:
    speaker: str | None
    text: str
    tags: list[str]


@dataclass
class ActionItem:
    owner: str | None
    text: str
    due: str | None


@dataclass
class Extracted:
    summary: str
    decisions: list[Decision]
    actions: list[ActionItem]


EXTRACT_PROMPT = """You are extracting structured items from a meeting
transcript. Output strict JSON matching this schema:

{
  "summary": "one paragraph, <120 words, neutral voice",
  "decisions": [{"speaker": str|null, "text": str, "tags": [str]}],
  "actions":   [{"owner": str|null, "text": str, "due": str|null}]
}

Rules:
- Decisions = concrete choices the team agreed to (e.g., "we'll use Postgres").
  NOT vague preferences. NOT questions.
- Actions = specific to-dos with an owner if named, a due-date if mentioned.
- Tags on decisions: 1-3 short kebab-case labels like "stack", "pricing".
- If a section has no items, return an empty array. Never invent.

TRANSCRIPT:
\"\"\"
%CONTENT%
\"\"\"

Output JSON only — no preamble, no markdown fences."""


def extract(transcript: str) -> Extracted:
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=LLM_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": EXTRACT_PROMPT.replace("%CONTENT%", transcript)}],
    )
    raw = ""
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            raw += block.text
    data = json.loads(raw.strip())
    return Extracted(
        summary=str(data.get("summary", "")).strip(),
        decisions=[
            Decision(
                speaker=d.get("speaker"),
                text=str(d["text"]).strip(),
                tags=list(d.get("tags", [])),
            )
            for d in data.get("decisions", [])
        ],
        actions=[
            ActionItem(
                owner=a.get("owner"),
                text=str(a["text"]).strip(),
                due=a.get("due"),
            )
            for a in data.get("actions", [])
        ],
    )


# ─── Save into mnueron ───────────────────────────────────────────────────
def save_meeting(mem: Mnueron, meeting_id: str, transcript: str, x: Extracted) -> None:
    ns = f"meeting-{meeting_id}"

    # 1. The raw transcript as one big memory, tagged so we can exclude it
    #    from quick recall queries that want decisions/actions specifically.
    mem.save(
        content=transcript,
        namespace=ns,
        tags=["raw-transcript"],
        metadata={"chars": len(transcript)},
    )

    # 2. The one-paragraph summary — answers "what was that meeting about?"
    if x.summary:
        mem.save(
            content=x.summary,
            namespace=ns,
            tags=["summary"],
        )

    # 3. Each decision as its own memory, so semantic search picks them up.
    for d in x.decisions:
        mem.save(
            content=d.text,
            namespace=ns,
            tags=["decision", *d.tags],
            metadata={"speaker": d.speaker} if d.speaker else None,
        )

    # 4. Each action item — same pattern, different tags. Owner + due go
    #    into metadata so filters like metadata_filter={"owner": "sarah"}
    #    work without parsing free text.
    for a in x.actions:
        meta: dict[str, str] = {}
        if a.owner:
            meta["owner"] = a.owner
        if a.due:
            meta["due"] = a.due
        mem.save(
            content=a.text,
            namespace=ns,
            tags=["action-item"],
            metadata=meta or None,
        )


# ─── Recall (for the UI / next conversation) ──────────────────────────────
def recall(mem: Mnueron, meeting_id: str, query: str, k: int = 5) -> list[dict]:
    return [
        {"id": m.id, "content": m.content, "tags": m.tags, "score": getattr(m, "score", None)}
        for m in mem.search(query, namespace=f"meeting-{meeting_id}", k=k)
    ]


# ─── Entry point ─────────────────────────────────────────────────────────
def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: meeting_notes_skeleton.py <transcript.txt> [meeting_id]", file=sys.stderr)
        return 2
    path = sys.argv[1]
    meeting_id = sys.argv[2] if len(sys.argv) > 2 else os.path.basename(path).rsplit(".", 1)[0]
    transcript = open(path, encoding="utf-8").read()

    mem = make_mem(meeting_id)
    print(f"  📋  Extracting decisions + action items from {len(transcript)} chars …")
    x = extract(transcript)

    print(f"      Summary: {x.summary[:80]}{'…' if len(x.summary) > 80 else ''}")
    print(f"      Decisions: {len(x.decisions)}    Actions: {len(x.actions)}")

    save_meeting(mem, meeting_id, transcript, x)
    print(f"\n  ✓ Saved into mnueron namespace `meeting-{meeting_id}`")

    # Quick smoke-test of recall
    sample = "what did we decide"
    print(f"\n  🔎  recall('{sample}'):")
    for hit in recall(mem, meeting_id, sample, k=3):
        snippet = hit["content"].replace("\n", " ")[:80]
        print(f"      • {snippet}{'…' if len(hit['content']) > 80 else ''}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
