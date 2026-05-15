"""
customer_support_agent.py

A working customer-support agent built on MNUERON memory.
Demonstrates:

  - Memory recall BEFORE the LLM call (the "remember this user" step)
  - Memory save AFTER the LLM response (the "learn from this turn" step)
  - Multi-LLM usage: OpenAI gpt-4o-mini for cheap classification,
    Anthropic Claude Sonnet for the actual response. Same memory layer
    feeds both. The memory layer doesn't know or care which model you use.
  - Token tracking so you can see the actual cost of memory-vs-no-memory.

Run:
    pip install mnueron openai anthropic
    export MNUERON_API_KEY=mnu_xxx
    export MNUERON_API_URL=http://localhost:3111   # or your hosted URL
    export OPENAI_API_KEY=sk-...
    export ANTHROPIC_API_KEY=sk-ant-...
    python customer_support_agent.py

What you'll see in the demo:

  Tuesday: customer mentions they're on the Pro plan and allergic to peanuts.
           Agent stores those facts.
  Friday:  customer comes back, asks a generic question. Agent already
           knows the context. Response is personalized without the
           customer having to repeat themselves.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List

from openai import OpenAI
from anthropic import Anthropic
from mnueron import Mnueron


# ---------------------------------------------------------------------------
# Token & cost tracking — so we can see the savings vs. a no-memory baseline
# ---------------------------------------------------------------------------

# Current per-million-token pricing (May 2026)
PRICE = {
    "gpt-4o-mini":      (0.15,  0.60),   # ($ per Mtok input, output)
    "claude-sonnet-4-6": (3.00, 15.00),
}


@dataclass
class TokenUsage:
    by_model: dict = field(default_factory=lambda: {
        "gpt-4o-mini":       [0, 0],
        "claude-sonnet-4-6": [0, 0],
    })

    def add(self, model: str, input_tokens: int, output_tokens: int) -> None:
        self.by_model[model][0] += input_tokens
        self.by_model[model][1] += output_tokens

    def total_cost_usd(self) -> float:
        cost = 0.0
        for model, (ip, op) in self.by_model.items():
            pi, po = PRICE[model]
            cost += (ip * pi + op * po) / 1_000_000
        return cost

    def summary(self) -> str:
        lines = ["Token usage:"]
        for model, (ip, op) in self.by_model.items():
            lines.append(f"  {model:24} input={ip:>6}  output={op:>5}")
        lines.append(f"  Total cost: ${self.total_cost_usd():.6f}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# The agent itself
# ---------------------------------------------------------------------------

class SupportAgent:
    """A customer-support agent backed by MNUERON memory.

    State: one Mnueron client, one OpenAI client, one Anthropic client.
    Memory is scoped per customer via namespace = f"customer-{customer_id}".
    """

    def __init__(self, customer_id: str):
        self.customer_id = customer_id
        self.namespace = f"customer-{customer_id}"
        self.mem = Mnueron()              # picks up MNUERON_API_KEY / URL from env
        self.openai = OpenAI()
        self.anthropic = Anthropic()
        self.usage = TokenUsage()

    # -- the main turn -------------------------------------------------------

    def handle(self, message: str) -> str:
        # 1. Pull what we already know about this customer
        memories = self.mem.search(message, namespace=self.namespace, k=5)
        context_block = (
            "\n".join(f"- {m.content}" for m in memories) if memories else "(no prior context)"
        )

        # 2. Classify the request cheaply (gpt-4o-mini)
        category = self._classify(message)

        # 3. Generate the actual response with Claude, with memory injected
        reply = self._respond(message, context_block, category)

        # 4. Pull out anything worth remembering and write it back
        new_facts = self._extract_facts(message, reply)
        for fact in new_facts:
            self.mem.save(
                fact,
                namespace=self.namespace,
                source="auto",
                tags=[category],
            )

        return reply

    # -- LLM calls -----------------------------------------------------------

    def _classify(self, message: str) -> str:
        """Cheap router: which support category is this?"""
        resp = self.openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content":
                    "Classify the support request. Reply with EXACTLY ONE word from: "
                    "billing, technical, account, refund, general."},
                {"role": "user", "content": message},
            ],
            max_tokens=5,
        )
        self.usage.add("gpt-4o-mini", resp.usage.prompt_tokens, resp.usage.completion_tokens)
        return resp.choices[0].message.content.strip().lower().split()[0]

    def _respond(self, message: str, context: str, category: str) -> str:
        """Real reply, with memory context injected into the system prompt."""
        system = f"""You are a helpful customer-support agent. Reply naturally and concisely.

Category: {category}

What you know about this customer (pulled from memory):
{context}

When the customer references prior context implicitly, use what you know above.
Don't recite the context back at them — just behave as if you remember."""
        resp = self.anthropic.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=512,
            system=system,
            messages=[{"role": "user", "content": message}],
        )
        self.usage.add("claude-sonnet-4-6", resp.usage.input_tokens, resp.usage.output_tokens)
        return resp.content[0].text

    # -- fact extraction -----------------------------------------------------

    def _extract_facts(self, user_msg: str, ai_reply: str) -> List[str]:
        """In production you'd use a small LLM call here.
        For a clean demo, we use a tiny LLM extraction with cheap gpt-4o-mini."""
        resp = self.openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content":
                    "Extract durable facts about the customer from the message below. "
                    "Examples: subscription plan, allergies, preferences, location, role. "
                    "Output one fact per line, no commentary. If no facts, output nothing."},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=200,
        )
        self.usage.add("gpt-4o-mini", resp.usage.prompt_tokens, resp.usage.completion_tokens)
        text = (resp.choices[0].message.content or "").strip()
        return [line.strip("- ").strip() for line in text.split("\n") if line.strip()]


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

def divider(label: str) -> None:
    print(f"\n{'='*60}\n  {label}\n{'='*60}")


def main() -> None:
    agent = SupportAgent(customer_id="alice-42")

    # --- Tuesday: first contact ---
    divider("Tuesday — Customer's first message")
    msg = ("Hi! I'm on your Pro plan and I'm allergic to peanuts. "
           "I'm looking for vegetarian meal recommendations.")
    print(f"Customer: {msg}\n")
    print(f"Agent:    {agent.handle(msg)}")

    # --- Friday: returns, says nothing about themselves ---
    divider("Friday — Customer returns three days later")
    msg = "What should I have for dinner tonight?"
    print(f"Customer: {msg}\n")
    print(f"Agent:    {agent.handle(msg)}")
    # The reply should mention vegetarian + no-peanut options without the
    # customer having to repeat themselves. That's the memory in action.

    # --- Cost report ---
    divider("What this cost")
    print(agent.usage.summary())

    divider("What this would cost WITHOUT memory")
    # If we had no memory, we'd typically paste ~3000 tokens of customer
    # history into the system prompt for each turn. Rough estimate:
    pretend_extra = (3000 - 200) * 2   # 2 turns, ~2800 extra input tokens each
    extra_cost = pretend_extra * 3.00 / 1_000_000
    print(f"Would inject ~{pretend_extra} extra Sonnet input tokens "
          f"({pretend_extra * 3.00 / 1_000_000:.6f} extra cost = ${extra_cost:.6f})")
    print(f"Actual cost with memory: ${agent.usage.total_cost_usd():.6f}")
    print(f"Estimated saving:        ${extra_cost:.6f} per 2-turn session")


if __name__ == "__main__":
    main()
