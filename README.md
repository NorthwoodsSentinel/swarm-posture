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
