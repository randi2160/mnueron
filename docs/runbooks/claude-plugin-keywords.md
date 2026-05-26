# Claude plugin keywords and namespace defaults

This note documents the places where mnueron gives Claude/Cowork hints about
when to use memory and which namespace to search.

## 1. Codex/Cowork skill trigger text

File:

`mnueron.plugin/skills/mnueron-recall/SKILL.md`

Important fields:

- `name: mnueron-recall`
- `description: Recall any prior conversation, decision, or fact from mnueron memory...`

This is the main natural-language trigger for recall. It tells the assistant to
use memory when the user says things like:

- "what did we decide about X"
- "find that chat where we set up Y"
- "what's the namespace for Z"
- "pick up where we left off"
- "earlier you said..."

It also currently says the most common namespaces are `elevizio` and
`claude-cowork`.

## 2. Plugin package keywords

File:

`mnueron.plugin/plugin.json`

The marketplace/search keywords are:

- `memory`
- `mcp`
- `persistent-memory`
- `cowork`
- `claude-code`
- `context`
- `rag`

These are discovery keywords. They do not control runtime recall behavior.

## 3. MCP namespace default

File:

`mnueron.plugin/mcp-servers.json`

The repo template now sets:

```json
"MNUERON_NAMESPACE": "mnueron"
```

That means a copied plugin config defaults recall/save behavior toward the
general Mnueron namespace. Use a project namespace only when the work is
project-specific.

## 4. Installed Claude Desktop config

Detected installed config:

`%LOCALAPPDATA%/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude_desktop_config.json`

It contains an MCP server named `mnueron` pointing at:

`C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\dist\index.js`

It sets hosted mode with `MNUERON_API_URL`. Best practice is to also set
`MNUERON_NAMESPACE` to `mnueron` for general work, then override by prompt or
tool call when recalling a specific project namespace.

Do not commit real API tokens from installed config files. Use environment
variables or the placeholder `${MNUERON_API_TOKEN}` in repo templates.

## Recommendation

Use project namespaces explicitly:

- `mnueron` for Mnueron product/build work
- `elevizio` for Elevizio memories
- `claude-cowork` for raw imported Cowork sessions

For Claude/Cowork, add this to the installed `mnueron` server env when you want
that client to default to general Mnueron work:

```json
"MNUERON_NAMESPACE": "mnueron"
```

Keep `elevizio` only in the Elevizio-specific setup or when intentionally
recalling that project.
