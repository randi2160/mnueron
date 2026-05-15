"""
research_assistant.py

A small research-assistant agent built on the MNUERON Python SDK.

What it does:
  - You give it a research topic at startup.
  - You feed it findings as you research (URLs, quotes, hunches, sources).
  - It saves each finding to MNUERON, tagged by source type.
  - At any point you can ASK questions about your accumulated research,
    and it'll synthesize an answer using only what you've told it.
  - It can produce a summary of everything you've gathered.

Why this example: it's the cleanest demonstration of the SDK shape.
Three patterns appear over and over in real agents:

  1. SAVE  — `mem.save(content, namespace=..., tags=...)`
  2. RECALL — `mem.search(query, namespace=..., k=...)`
  3. LLM-with-context — pull memories, paste them into the system prompt,
     let the model reason over them.

Once you internalize this shape, every other agent pattern is a variation.

Run:
    pip install mnueron openai
    export MNUERON_API_KEY=mnu_xxx
    export MNUERON_API_URL=http://localhost:3111
    export OPENAI_API_KEY=sk-...
    python research_assistant.py
"""
from __future__ import annotations

import sys
from typing import List

from openai import OpenAI
from mnueron import Mnueron, Memory


# ---------------------------------------------------------------------------
# The agent
# ---------------------------------------------------------------------------

class ResearchAssistant:
    """A research assistant scoped to ONE topic.

    Each topic gets its own namespace so findings don't bleed between
    research projects. Inside that namespace, tags categorize entries
    (`url`, `quote`, `hunch`, etc.) so you can later filter when you want
    only your sources, or only your interpretations.
    """

    def __init__(self, topic: str):
        self.topic = topic
        # Namespace per research project — keeps "AI memory architecture"
        # findings separate from "vacation planning" findings.
        self.namespace = f"research/{topic.lower().replace(' ', '-')}"
        self.mem = Mnueron()
        self.llm = OpenAI()

    # -- save: three kinds of findings ---------------------------------------

    def add_url(self, url: str, note: str = "") -> Memory:
        """Save a source URL with optional commentary."""
        content = f"URL: {url}" + (f"\nNote: {note}" if note else "")
        return self.mem.save(
            content,
            namespace=self.namespace,
            tags=["source", "url"],
            source="research-assistant",
        )

    def add_quote(self, quote: str, source: str) -> Memory:
        """Save a direct quote, attributed."""
        return self.mem.save(
            f"Quote from {source}:\n\"{quote}\"",
            namespace=self.namespace,
            tags=["quote", "source"],
            source="research-assistant",
        )

    def add_hunch(self, idea: str) -> Memory:
        """Save your own hunch or interpretation."""
        return self.mem.save(
            f"Hunch: {idea}",
            namespace=self.namespace,
            tags=["hunch", "interpretation"],
            source="research-assistant",
        )

    def add_finding(self, finding: str) -> Memory:
        """Catch-all for raw findings."""
        return self.mem.save(
            finding,
            namespace=self.namespace,
            tags=["finding"],
            source="research-assistant",
        )

    # -- ask: question-answering over accumulated findings ------------------

    def ask(self, question: str, k: int = 8) -> str:
        """Answer a question using only what's been recorded for this topic.

        This is the canonical RAG pattern:
          1. retrieve relevant memories,
          2. inject them into the system prompt,
          3. let the LLM synthesize an answer grounded in those memories.
        """
        relevant = self.mem.search(question, namespace=self.namespace, k=k)
        if not relevant:
            return "No findings yet for this topic — add some research first."

        context = "\n\n".join(
            f"[{m.tags[0] if m.tags else 'note'}] {m.content}"
            for m in relevant
        )

        resp = self.llm.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": (
                    f"You are a research assistant helping with the topic: '{self.topic}'.\n"
                    "Answer using ONLY the findings provided below. If the findings don't "
                    "cover the question, say so directly — don't invent.\n\n"
                    f"Findings:\n{context}"
                )},
                {"role": "user", "content": question},
            ],
            max_tokens=600,
        )
        return resp.choices[0].message.content or ""

    # -- summary: synthesize everything so far ------------------------------

    def summary(self) -> str:
        """Produce a structured summary of all findings."""
        all_findings = self.mem.list(namespace=self.namespace, limit=200)
        if not all_findings:
            return "No findings recorded yet."

        formatted = "\n".join(
            f"- [{m.tags[0] if m.tags else 'note'}] {m.content}"
            for m in all_findings
        )

        resp = self.llm.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": (
                    f"You're summarizing research on '{self.topic}'.\n"
                    "Group the findings into themes, identify open questions, "
                    "and note where sources agree or disagree.\n\n"
                    f"All recorded findings:\n{formatted}"
                )},
                {"role": "user", "content": "Give me the summary."},
            ],
            max_tokens=800,
        )
        return resp.choices[0].message.content or ""

    # -- admin --------------------------------------------------------------

    def count(self) -> dict:
        items = self.mem.list(namespace=self.namespace, limit=500)
        counts = {}
        for m in items:
            for t in m.tags:
                counts[t] = counts.get(t, 0) + 1
        return {"total": len(items), "by_tag": counts}

    def sources(self) -> List[Memory]:
        return self.mem.search("source URL", namespace=self.namespace, tags=["source"], k=50)


# ---------------------------------------------------------------------------
# Demo: simulated research session
# ---------------------------------------------------------------------------

def divider(label: str) -> None:
    print(f"\n{'='*70}\n  {label}\n{'='*70}")


def main() -> None:
    agent = ResearchAssistant(topic="AI agent memory architectures")

    # ----- simulate gathering findings throughout the day -----
    divider("Adding research findings")

    agent.add_url(
        "https://arxiv.org/abs/2308.00352",
        "MemGPT paper — virtual memory pattern for LLMs",
    )
    agent.add_quote(
        "Mem0 achieves 26% higher accuracy than OpenAI Memory at 91% lower latency",
        "Mem0 LoCoMo benchmark paper",
    )
    agent.add_quote(
        "RLS at the database level is the cleanest way to enforce multi-tenant isolation",
        "Postgres docs",
    )
    agent.add_hunch(
        "Most agent-memory products price per-call, which makes them economic only "
        "for high-volume apps. Per-user/per-seat pricing might be the wedge for "
        "lower-volume but more discerning customers."
    )
    agent.add_url(
        "https://supabase.com/docs/guides/database/extensions/pgvector",
        "pgvector + HNSW indexes — supabase docs",
    )
    agent.add_finding(
        "Vector search latency stays acceptable up to ~10M rows per tenant with "
        "HNSW indexes; past that point, partition by tenant_id."
    )

    print(f"Counts: {agent.count()}")

    # ----- ask questions -----
    divider("Q: How do existing products price their memory layer?")
    print(agent.ask("How do existing products price their memory layer?"))

    divider("Q: What's the architecture for multi-tenant isolation?")
    print(agent.ask("What's the architecture for multi-tenant isolation?"))

    divider("Q: Will memory scale past 1M memories per user?")
    print(agent.ask("Will memory scale past 1M memories per user?"))

    # ----- ask the agent for a synthesis -----
    divider("Summary of everything we've gathered")
    print(agent.summary())


if __name__ == "__main__":
    main()
