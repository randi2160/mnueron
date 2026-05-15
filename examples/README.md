# MNUERON examples

Real-world agents built on the MNUERON memory layer. Each is a single Python
file you can read and run.

| Example | What it demonstrates | LLM providers used |
| --- | --- | --- |
| `customer_support_agent.py` | Per-customer memory in a support bot; multi-LLM; token cost tracking | OpenAI (classify) + Anthropic (respond) |
| `elevizio_creator_agent.py` | Multi-workflow content generation (cooking / music / podcast) with three-level memory namespaces (brand → workflow → episodes). Shows cross-workflow brand inheritance and performance feedback loop. | OpenAI |
| `elevizio_memory.py` | Production-ready wrapper class around the Mnueron SDK. Drop into Elevizio's `services/` folder. Hides namespace conventions, adds graceful degradation, gives every workflow a clean memory API. | (library, not a demo) |
| `research_assistant.py` | Compact demonstration of the SDK's three core patterns — save, search, LLM-with-context. Build a topic-scoped research assistant in ~150 lines. | OpenAI |

## Plugins (`plugins/` subfolder)

Sample plugins showing how to extend MNUERON with custom behavior. Plugins are
regular npm packages following the `mnueron-plugin-*` naming convention.
See [`plugins/README.md`](./plugins/README.md) for the full developer guide.

| Plugin | Type | What it does |
| --- | --- | --- |
| [`redact-pii`](./plugins/redact-pii/) | Processor | Strips emails, phones, credit cards, and AWS keys from memories before they're saved |

## Prerequisites

- Python 3.9+
- A running MNUERON backend (local server pointing at Supabase free tier is fine — see `../server/SUPABASE_SETUP.md`)
- API keys from the providers each example uses

## Setup

```bash
# From the repo root
cd examples
pip install mnueron openai anthropic

# Set env vars
export MNUERON_API_KEY=mnu_xxxxxxxxxxxxxx
export MNUERON_API_URL=http://localhost:3111    # or your deployed URL
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
python customer_support_agent.py
```

You'll see a two-turn demo: customer mentions something on Tuesday, comes
back Friday with a generic question, agent already knows the context. The
script prints token usage and the cost saved vs. a memory-less baseline.

## Adapting these for your own apps

The pattern is always the same three steps:

```python
# 1. Recall — pull relevant memories for this user
memories = mem.search(user_message, namespace=f"user-{user_id}", k=5)

# 2. Generate — call your LLM(s) with the memory context injected
reply = call_llm(user_message, memories)

# 3. Remember — save new facts back
mem.save(extract_facts(user_message, reply), namespace=f"user-{user_id}")
```

That's the entire memory pattern. Swap LLM providers freely — `call_llm()`
can be OpenAI, Anthropic, Mistral, Gemini, or all of them mixed. The
memory layer doesn't care.
