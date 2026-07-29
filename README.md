# swarm-posture

**Attack-path analysis and least-privilege checking for AI agent swarms.** Free, open-source, zero-dependency.

AI agents get breached two ways that a per-agent review can't see:

- **Excessive permissions** — a worker granted so much that an injection lands and *no gate ever fires*, because it was allowed too much. The dangerous worker isn't the one that trips an alarm; it's the quiet one handed too much access.
- **Attack paths** — a chain of authorized invocations that reaches sensitive data no single worker should. Each hop looks fine; the composition is the escalation. Security doesn't compose — you can't audit a swarm by auditing its workers one at a time.

`swarm-posture` finds both, structurally, in seconds. You describe your swarm; it maps the reachability.

## Try it in 30 seconds

```bash
git clone https://github.com/NorthwoodsSentinel/swarm-posture
cd swarm-posture
bun swarm-posture.ts example-swarm.json      # or: npx tsx swarm-posture.ts example-swarm.json
```

```
EXCESSIVE PERMISSIONS (least-privilege / blast radius)
  ⚠ kb-helper (role: general) reaches payment — its role does not own this; scope down.

ATTACK PATHS (composed escalation — a chain a per-worker review can't see)
  ⚠ triage-bot → billing-agent reaches payment — an injected triage-bot needs no such
    access itself; it invokes a deputy that has it.
```

Then point it at your own swarm.

## Already running a fleet? Assess it directly

You don't have to hand-write the description — an adapter reads your install and generates the `swarm.json` for you. Four frameworks:

```bash
# Claude Code / PAI  (reads agents/ and their tool grants)
bun adapt.ts pai       ~/.claude              > my-swarm.json && bun swarm-posture.ts my-swarm.json

# pi                  (reads extensions and tool reach)
bun adapt.ts pi        ~/.pi/agent            > my-swarm.json && bun swarm-posture.ts my-swarm.json

# LangGraph           (parses add_node / add_edge / bind_tools in your Python)
bun adapt.ts langgraph ./my-langgraph-app     > my-swarm.json && bun swarm-posture.ts my-swarm.json

# CrewAI              (parses config/agents.yaml + Agent()/Crew() in your Python)
bun adapt.ts crewai    ./my-crewai-project    > my-swarm.json && bun swarm-posture.ts my-swarm.json
```

The mapping is the same for all four: an agent's **tools are its data reach**. A shell/code tool (`Bash`, `python_repl`, `shell`) can read your credentials and env, so any agent with it reaches *secrets*. A delegation edge (`Agent`/`Task`, a LangGraph `add_edge`, a CrewAI `allow_delegation=True` or hierarchical manager) is an invoke edge — that's where attack paths hide. Open the generated `my-swarm.json`, set `role_owns` to mark which roles *legitimately* hold each sensitive class, and re-run to separate by-design from over-broad.

**MCP servers count as reach.** The PAI/Claude Code adapter also reads your MCP config (`.mcp.json`, `settings.json`, `~/.claude.json`) — a configured server extends every agent that can reach it. [github-mcp-server](https://github.com/github/github-mcp-server) gets specific treatment because its grants are declared: the toolsets allow-list (`GITHUB_TOOLSETS`, `--toolsets`, or the remote URL) maps to what it reaches — `repos`/`pull_requests` → source-code, `actions` → ci-cd (workflow logs are a read-side secrets surface), `code_security`/`secret_protection` → security-findings, `issues`/`users`/`orgs` → collab. No toolsets declared means the documented default set (`context, repos, issues, pull_requests, users`), which reaches source-code — worth knowing before you hand it to a triage bot. Unknown MCP servers get a generic external-service reach; refine by hand.

**Two things worth knowing about the framework adapters.** PAI and pi read structured config, so their output is exact. **LangGraph and CrewAI are code-defined**, so their adapters parse the *common* patterns — node/edge/`bind_tools` for LangGraph (tools attributed to a node when the `bind_tools` variable name matches the node, e.g. `coder_llm` → `coder`); `agents.yaml` + `Agent(role=, tools=, allow_delegation=)` + `Process.hierarchical` for CrewAI. A dynamically-constructed or unusually-structured graph may parse partially — treat the generated `swarm.json` as a first draft you can correct by hand, not gospel. And tool **reach is inferred from the tool's name** (a tool called `sql_query` → database; `web_search` → egress), so glance at the `reads` it assigned and adjust any it guessed wrong. Working reference apps are in [`examples/`](examples/) — run the adapter against them to see the shape.

## Describe your swarm

A small JSON file (`example-swarm.json` is the template):

```jsonc
{
  "swarm": "acme-support",
  "data_tiers": { "0": "public", "1": "internal", "2": "customer-pii", "3": "payment" },
  "sensitive_at_or_above": 2,                       // tiers >= this are "sensitive"
  "role_owns": { "billing": ["payment"] },          // which role legitimately owns which sensitive class
  "workers": [
    { "id": "triage-bot",    "role": "triage",  "reads": [{ "class": "ticket",  "max_sensitivity": 1 }], "invokes": ["billing-agent"] },
    { "id": "billing-agent", "role": "billing", "reads": [{ "class": "payment", "max_sensitivity": 3 }], "invokes": [] },
    { "id": "kb-helper",     "role": "general", "reads": [{ "class": "payment", "max_sensitivity": 3 }], "invokes": [] }
  ]
}
```

- `reads` — what data classes a worker can read, and up to what sensitivity tier.
- `invokes` — which other workers it can call. These edges are where attack paths hide.
- `role_owns` — the one judgment call: which sensitive classes a role is *supposed* to have. Billing owning payment is by design; a general helper reaching payment is not.

## What it does and doesn't do

This is the **structural** check. It reads your declared config — it does **not** run your agents. It answers "what can reach what, and through whom." That's the fast, deterministic, run-it-on-every-change layer, and it's free forever.

What it can't tell you: whether a real model *actually* falls for a given prompt injection, and how often. That's **behavioral simulation** — running your workers under live injection to measure whether they breach their intended objective (*intent fidelity*), scored as a rate. That's a paid tier from [NorthWoods Sentinel Labs](https://github.com/NorthwoodsSentinel).

## License

Apache-2.0. Use it, fork it, ship it.
