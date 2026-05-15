"""
elevizio_creator_agent.py

A multi-workflow content-creation agent built on MNUERON memory.
Generates briefs for cooking videos, music tracks, and podcast episodes —
all using the same creator's brand identity, with workflow-specific
style memory layered on top.

Memory architecture:

    creator-{id}                         brand voice, audience, visual style
        applies to every workflow

    creator-{id}/workflow-cooking        cooking video style, recipe focus
    creator-{id}/workflow-music          music genre, BPM range, instruments
    creator-{id}/workflow-podcast        podcast format, host style, segments

    creator-{id}/episodes                per-output performance + what worked
        tagged with workflow name for filtering

This is the pattern you'd embed in Elevizio's agent workflows. Each agent
queries memory in three layers (brand → workflow → past episodes), generates
the content with full context, then writes back what was generated and what
the creator liked or didn't.

Run:
    pip install mnueron openai
    export MNUERON_API_KEY=mnu_xxx
    export OPENAI_API_KEY=sk-...
    python elevizio_creator_agent.py
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import List, Optional

from openai import OpenAI
from mnueron import Mnueron, Memory


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _bullets(memories: List[Memory]) -> str:
    if not memories:
        return "(none yet — first time running this workflow)"
    return "\n".join(f"- {m.content}" for m in memories)


# ---------------------------------------------------------------------------
# Core creator agent
# ---------------------------------------------------------------------------

class CreatorAgent:
    """One agent per creator. Handles all workflows for that creator."""

    def __init__(self, creator_id: str):
        self.creator_id = creator_id
        self.brand_ns = f"creator-{creator_id}"
        self.episodes_ns = f"creator-{creator_id}/episodes"
        self.mem = Mnueron()
        self.llm = OpenAI()

    # -- workflow namespace helpers -----------------------------------------

    def _workflow_ns(self, workflow: str) -> str:
        return f"creator-{self.creator_id}/workflow-{workflow}"

    # -- bootstrap: creator onboarding (runs once) --------------------------

    def onboard(
        self,
        brand_voice: str,
        target_audience: str,
        visual_style: str,
    ) -> None:
        """Called once when a creator signs up. Saves the foundational
        brand identity that every workflow will inherit."""
        self.mem.save(brand_voice, namespace=self.brand_ns, tags=["brand", "voice"])
        self.mem.save(target_audience, namespace=self.brand_ns, tags=["brand", "audience"])
        self.mem.save(visual_style, namespace=self.brand_ns, tags=["brand", "visual"])

    def onboard_workflow(self, workflow: str, style_notes: List[str]) -> None:
        """Called when a creator adds a new workflow (cooking, music, podcast).
        Saves workflow-specific style patterns."""
        ns = self._workflow_ns(workflow)
        for note in style_notes:
            self.mem.save(note, namespace=ns, tags=[workflow, "style"])

    # -- the three-layer recall pattern -------------------------------------

    def gather_context(self, workflow: str, request: str) -> str:
        """Pull brand identity + workflow style + relevant past episodes."""
        brand = self.mem.search(request, namespace=self.brand_ns, k=3)
        style = self.mem.search(request, namespace=self._workflow_ns(workflow), k=5)
        past = self.mem.search(
            request, namespace=self.episodes_ns, k=3, tags=[workflow]
        )
        return (
            f"## Brand identity (applies to everything):\n{_bullets(brand)}\n\n"
            f"## {workflow.title()} workflow style:\n{_bullets(style)}\n\n"
            f"## Past {workflow} episodes that worked:\n{_bullets(past)}"
        )

    # -- workflow: cooking video --------------------------------------------

    def generate_cooking_video(self, recipe: str) -> str:
        """Returns a brief that Elevizio's downstream pipeline (FAL.ai,
        MiniMax, etc.) would use to actually render the video."""
        context = self.gather_context("cooking", recipe)
        brief = self._llm_brief(
            workflow="cooking video",
            request=recipe,
            context=context,
        )
        # Save the generation event so future videos know what this one was
        self.mem.save(
            f"Cooking video brief for '{recipe}': {brief[:200]}...",
            namespace=self.episodes_ns,
            tags=["cooking", "generated"],
        )
        return brief

    # -- workflow: music track ----------------------------------------------

    def generate_music_track(self, vibe: str) -> str:
        context = self.gather_context("music", vibe)
        brief = self._llm_brief(
            workflow="music track",
            request=vibe,
            context=context,
        )
        self.mem.save(
            f"Music track brief for '{vibe}': {brief[:200]}...",
            namespace=self.episodes_ns,
            tags=["music", "generated"],
        )
        return brief

    # -- workflow: podcast episode ------------------------------------------

    def generate_podcast_episode(self, topic: str) -> str:
        context = self.gather_context("podcast", topic)
        brief = self._llm_brief(
            workflow="podcast episode",
            request=topic,
            context=context,
        )
        self.mem.save(
            f"Podcast brief for '{topic}': {brief[:200]}...",
            namespace=self.episodes_ns,
            tags=["podcast", "generated"],
        )
        return brief

    # -- post-publish feedback (closes the learning loop) -------------------

    def record_performance(
        self,
        workflow: str,
        title: str,
        outcome: str,
        what_worked: Optional[str] = None,
    ) -> None:
        """Call this after a piece of content goes live to feed performance
        data back into memory. Future generations recall what worked."""
        self.mem.save(
            f"{title}: {outcome}" + (f". Worked because: {what_worked}" if what_worked else ""),
            namespace=self.episodes_ns,
            tags=[workflow, "performance"],
        )

    # -- the underlying LLM call --------------------------------------------

    def _llm_brief(self, workflow: str, request: str, context: str) -> str:
        system = f"""You are Elevizio's content brief writer. You generate
production briefs for {workflow}s that downstream rendering agents will
turn into finished content.

The brief must respect everything in the context below — the creator's
brand voice, the workflow style, and what's worked in past episodes.
Write the brief as a structured, production-ready document.

{context}"""
        resp = self.llm.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": request},
            ],
            max_tokens=600,
        )
        return resp.choices[0].message.content or ""


# ---------------------------------------------------------------------------
# Demo: creator onboards, then runs all three workflows
# ---------------------------------------------------------------------------

def divider(label: str) -> None:
    print(f"\n{'='*70}\n  {label}\n{'='*70}")


def main() -> None:
    agent = CreatorAgent(creator_id="reshmee-001")

    # --- One-time onboarding (would happen at signup in Elevizio) ----------
    divider("Onboarding: brand identity (saved once, applies to all workflows)")
    agent.onboard(
        brand_voice=(
            "Brand voice: warm, casual, occasional self-aware humor, "
            "never preachy. Conversational rather than instructional."
        ),
        target_audience=(
            "Target audience: 25-45, mostly women, busy professionals "
            "who care about wellness but don't have time for elaborate routines."
        ),
        visual_style=(
            "Visual style: warm earth tones, natural light, soft shadows, "
            "intentional negative space. Never overly polished or studio-perfect."
        ),
    )
    print("Brand identity saved. Now setting up three workflows...")

    # --- Workflow setup (would happen when creator adds each workflow) -----
    agent.onboard_workflow("cooking", [
        "Cooking videos: Mediterranean and South Asian fusion, vegetarian-friendly",
        "Format: 60-90 second vertical videos, hook in first 3 seconds",
        "Pacing: rhythmic chopping ASMR + light folk music underneath",
        "Avoid: heavy cream, processed ingredients, complex techniques",
    ])
    agent.onboard_workflow("music", [
        "Music: lo-fi background tracks for cooking content",
        "BPM range 70-90, key in C or A minor, no vocals",
        "Instruments: jazz piano, vinyl crackle, soft brushed drums, occasional sitar",
        "Track length 90-120 seconds, loop-friendly",
    ])
    agent.onboard_workflow("podcast", [
        "Podcast 'Slow Spice' — wellness + food intersection",
        "Episodes 18-22 minutes, single host (no guests)",
        "Structure: cold open story → topic intro → main body → wrap-up",
        "Sponsor read at 11-minute mark, max 60 seconds",
    ])
    print("Workflows configured.")

    # --- Generation: same agent, three different workflows -----------------
    divider("Generating: cooking video for 'spinach paneer wrap'")
    print(agent.generate_cooking_video("spinach paneer wrap, weeknight dinner"))

    divider("Generating: music track for 'morning cooking session'")
    print(agent.generate_music_track("morning cooking session, sunlit kitchen feel"))

    divider("Generating: podcast episode on 'turmeric'")
    print(agent.generate_podcast_episode("turmeric — beyond the latte trend"))

    # --- Closing the loop: feed performance back into memory ---------------
    divider("Recording performance (this would happen post-publish)")
    agent.record_performance(
        workflow="cooking",
        title="Spinach Paneer Wrap",
        outcome="120K views in 48 hours, save rate 4x average",
        what_worked="Hook started with hand crushing fresh spinach — visual + texture combo",
    )
    print("Performance recorded. Future cooking briefs will recall this.")

    # --- Show it: generate a SECOND cooking video, memory is smarter -----
    divider("Generating SECOND cooking video — memory now knows what worked")
    print(agent.generate_cooking_video("chickpea curry, 60 seconds"))
    # Notice: the brief should now reference fresh-ingredient hooks because
    # we just told memory that worked.


if __name__ == "__main__":
    main()
