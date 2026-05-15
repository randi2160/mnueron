"""
elevizio_memory.py

A production-ready wrapper around the Mnueron Python SDK for Elevizio.

This is the abstraction layer every Elevizio workflow should use — never reach
into Mnueron directly from a workflow. Why:

  1. Namespace conventions live in ONE place. Change them here, every
     workflow gets the new convention without code changes.
  2. Graceful degradation. If Mnueron is unavailable, content generation
     keeps working with empty context instead of crashing.
  3. Workflow-agnostic helpers. Cooking, music, podcast, image, video, and
     anything you add later all use the same API.
  4. Easy to swap providers later. If you ever move off Mnueron, you change
     this one file.

Drop this into Elevizio's `lib/` or `services/` folder and import it from
every workflow.

Requirements:
    pip install mnueron

Environment:
    MNUERON_API_KEY     bearer token for your Mnueron backend
    MNUERON_API_URL     base URL of your Mnueron API
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any

from mnueron import Mnueron, Memory, MnueronError

log = logging.getLogger("elevizio.memory")


# ---------------------------------------------------------------------------
# Configuration / data classes
# ---------------------------------------------------------------------------

@dataclass
class GenerationContext:
    """The bundle of context a workflow passes to its LLM."""
    brand: List[Memory] = field(default_factory=list)
    workflow_style: List[Memory] = field(default_factory=list)
    past_winners: List[Memory] = field(default_factory=list)

    def as_prompt_block(self, workflow: str) -> str:
        """Render the context as a markdown block ready to drop into a
        system prompt."""

        def section(title: str, items: List[Memory]) -> str:
            if not items:
                return f"## {title}\n(none yet)"
            return f"## {title}\n" + "\n".join(f"- {m.content}" for m in items)

        return "\n\n".join([
            section("Brand identity", self.brand),
            section(f"{workflow.title()} workflow style", self.workflow_style),
            section("Past episodes that worked", self.past_winners),
        ])

    @property
    def is_empty(self) -> bool:
        return not (self.brand or self.workflow_style or self.past_winners)


# ---------------------------------------------------------------------------
# The wrapper
# ---------------------------------------------------------------------------

class ElevizioMemory:
    """Memory abstraction scoped to one creator.

    Construct once per creator (or per request, if you prefer), then call
    the workflow methods. The class hides all namespace strings, error
    handling, and Mnueron-specific details.

    Failure mode: every method catches MnueronError and returns an empty
    result. Workflows always succeed, even if memory is unavailable. The
    LLM call just runs with less context.
    """

    def __init__(
        self,
        creator_id: str,
        client: Optional[Mnueron] = None,
        *,
        recall_k_brand: int = 3,
        recall_k_workflow: int = 5,
        recall_k_winners: int = 3,
    ):
        self.creator_id = creator_id
        self._brand_ns = f"creator-{creator_id}"
        self._episodes_ns = f"creator-{creator_id}/episodes"
        self._client = client or Mnueron()
        self.recall_k_brand = recall_k_brand
        self.recall_k_workflow = recall_k_workflow
        self.recall_k_winners = recall_k_winners

    def _workflow_ns(self, workflow: str) -> str:
        return f"creator-{self.creator_id}/workflow-{workflow}"

    # =======================================================================
    # ONBOARDING — call these once when a creator signs up or adds a workflow
    # =======================================================================

    def set_brand_voice(self, description: str) -> bool:
        return self._save(description, self._brand_ns, tags=["brand", "voice"])

    def set_target_audience(self, description: str) -> bool:
        return self._save(description, self._brand_ns, tags=["brand", "audience"])

    def set_visual_style(self, description: str) -> bool:
        return self._save(description, self._brand_ns, tags=["brand", "visual"])

    def add_brand_attribute(
        self,
        attribute_name: str,
        value: str,
    ) -> bool:
        return self._save(
            value,
            self._brand_ns,
            tags=["brand", attribute_name],
        )

    def add_workflow_style_note(self, workflow: str, note: str) -> bool:
        return self._save(
            note,
            self._workflow_ns(workflow),
            tags=[workflow, "style"],
        )

    def configure_workflow(self, workflow: str, notes: List[str]) -> int:
        """Bulk-add style notes for a workflow. Returns count saved."""
        saved = 0
        for n in notes:
            if self.add_workflow_style_note(workflow, n):
                saved += 1
        return saved

    # =======================================================================
    # RECALL — workflows call this before every LLM generation
    # =======================================================================

    def gather_full_context(self, workflow: str, query: str) -> GenerationContext:
        """The main method workflows use. Pulls brand + workflow style +
        past winners in one call, returns a structured context object."""
        return GenerationContext(
            brand=self._search(query, self._brand_ns, k=self.recall_k_brand),
            workflow_style=self._search(
                query, self._workflow_ns(workflow), k=self.recall_k_workflow
            ),
            past_winners=self._search(
                query,
                self._episodes_ns,
                k=self.recall_k_winners,
                tags=[workflow, "high-performer"],
            ),
        )

    def brand_context(self, query: str, k: Optional[int] = None) -> List[Memory]:
        return self._search(query, self._brand_ns, k=k or self.recall_k_brand)

    def workflow_style(
        self, workflow: str, query: str, k: Optional[int] = None
    ) -> List[Memory]:
        return self._search(
            query, self._workflow_ns(workflow), k=k or self.recall_k_workflow
        )

    def past_winners(
        self, workflow: str, query: str = "what worked", k: Optional[int] = None
    ) -> List[Memory]:
        return self._search(
            query,
            self._episodes_ns,
            k=k or self.recall_k_winners,
            tags=[workflow, "high-performer"],
        )

    # =======================================================================
    # WRITE-BACK — workflows call these after generation and after publish
    # =======================================================================

    def record_generation(
        self,
        workflow: str,
        title: str,
        brief_summary: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Called right after a workflow generates something. Logs the
        generation for traceability and future similarity search."""
        content = f"[{workflow}] {title}\n{brief_summary}"
        return self._save(
            content,
            self._episodes_ns,
            tags=[workflow, "generated"],
            metadata=metadata,
        )

    def record_performance(
        self,
        workflow: str,
        title: str,
        outcome_summary: str,
        what_worked: Optional[str] = None,
        is_high_performer: bool = False,
        metrics: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Called after content goes live and you have engagement data.
        Set is_high_performer=True for content that significantly
        outperformed — those memories become the 'what worked' pool that
        future generations pull from."""
        parts = [f"[{workflow}] {title}: {outcome_summary}"]
        if what_worked:
            parts.append(f"What worked: {what_worked}")
        content = "\n".join(parts)
        tags = [workflow, "performance"]
        if is_high_performer:
            tags.append("high-performer")
        return self._save(
            content,
            self._episodes_ns,
            tags=tags,
            metadata=metrics,
        )

    def record_creator_feedback(
        self,
        workflow: str,
        feedback: str,
        was_positive: bool = True,
    ) -> bool:
        """Creator told us they liked / disliked something. Goes into
        episodes so future generations adapt."""
        tags = [workflow, "feedback", "positive" if was_positive else "negative"]
        return self._save(
            f"[{workflow} feedback] {feedback}",
            self._episodes_ns,
            tags=tags,
        )

    # =======================================================================
    # ADMIN — for the creator dashboard
    # =======================================================================

    def list_brand_memories(self) -> List[Memory]:
        return self._list(self._brand_ns, limit=100)

    def list_workflow_memories(self, workflow: str) -> List[Memory]:
        return self._list(self._workflow_ns(workflow), limit=100)

    def list_recent_episodes(self, limit: int = 50) -> List[Memory]:
        return self._list(self._episodes_ns, limit=limit)

    def forget(self, memory_id: str) -> bool:
        """Creator wants this fact gone. Hard delete."""
        try:
            self._client.delete(memory_id)
            return True
        except MnueronError as e:
            log.warning(f"forget({memory_id}) failed: {e}")
            return False

    # =======================================================================
    # Internals — single point of failure-handling
    # =======================================================================

    def _save(
        self,
        content: str,
        namespace: str,
        *,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> bool:
        try:
            self._client.save(
                content,
                namespace=namespace,
                tags=tags or [],
                source="elevizio",
                metadata=metadata,
            )
            return True
        except MnueronError as e:
            log.warning(f"save to {namespace} failed: {e}")
            return False

    def _search(
        self,
        query: str,
        namespace: str,
        *,
        k: int = 5,
        tags: Optional[List[str]] = None,
    ) -> List[Memory]:
        try:
            return self._client.search(
                query, namespace=namespace, k=k, tags=tags
            )
        except MnueronError as e:
            log.warning(f"search in {namespace} failed: {e}")
            return []

    def _list(self, namespace: str, *, limit: int) -> List[Memory]:
        try:
            return self._client.list(namespace=namespace, limit=limit)
        except MnueronError as e:
            log.warning(f"list of {namespace} failed: {e}")
            return []

    def close(self) -> None:
        """Call on shutdown if you constructed your own Mnueron client."""
        try:
            self._client.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Example usage from inside an Elevizio workflow
# ---------------------------------------------------------------------------

def example_cooking_workflow(creator_id: str, recipe: str) -> str:
    """Shows what one Elevizio workflow looks like with the wrapper.
    All workflows have this exact shape — only the LLM prompt and the
    workflow name change."""
    from openai import OpenAI
    llm = OpenAI()
    mem = ElevizioMemory(creator_id)

    # 1. Recall
    ctx = mem.gather_full_context("cooking", recipe)

    # 2. Generate
    system_prompt = (
        "You are Elevizio's brief writer for cooking videos. Respect "
        "everything in the context below.\n\n"
        + ctx.as_prompt_block("cooking")
    )
    resp = llm.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Brief for: {recipe}"},
        ],
        max_tokens=600,
    )
    brief = resp.choices[0].message.content or ""

    # 3. Remember (the generation itself — performance gets recorded later)
    mem.record_generation(
        workflow="cooking",
        title=recipe,
        brief_summary=brief[:200],
        metadata={"model": "gpt-4o-mini", "input_tokens": resp.usage.prompt_tokens},
    )

    return brief


def example_full_lifecycle() -> None:
    """End-to-end demo: onboard creator, run workflow, record performance,
    run workflow again, see how recall improves."""
    creator_id = "reshmee-001"
    mem = ElevizioMemory(creator_id)

    # --- Onboarding (would run at creator signup) ---
    mem.set_brand_voice(
        "Warm, casual, occasional humor. Conversational not instructional."
    )
    mem.set_target_audience(
        "25-45, mostly women, busy professionals who care about wellness."
    )
    mem.set_visual_style(
        "Warm earth tones, natural light, intentional negative space."
    )
    mem.configure_workflow("cooking", [
        "60-90 second vertical videos, hook in first 3 seconds",
        "Mediterranean and South Asian fusion, vegetarian-friendly",
        "Rhythmic chopping ASMR + light folk music underneath",
    ])

    # --- First cooking video ---
    brief1 = example_cooking_workflow(creator_id, "spinach paneer wrap")
    print("BRIEF #1:\n" + brief1[:300] + "...\n")

    # --- Performance comes in 2 days later, creator dashboard records it ---
    mem.record_performance(
        workflow="cooking",
        title="Spinach Paneer Wrap",
        outcome_summary="120K views in 48 hours, 4x average save rate",
        what_worked="Hand-crushing fresh spinach as opening hook",
        is_high_performer=True,
        metrics={"views": 120_000, "saves": 4_800, "save_rate_multiplier": 4.0},
    )

    # --- Second cooking video — recall now includes the winner pattern ---
    brief2 = example_cooking_workflow(creator_id, "chickpea curry, 60 seconds")
    print("BRIEF #2 (memory should reference the fresh-ingredient hook):")
    print(brief2[:300] + "...")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    example_full_lifecycle()
