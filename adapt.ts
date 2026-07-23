#!/usr/bin/env bun
// adapt — turn a real agent-harness install into a swarm-posture description.
//
// An agent's TOOLS are its data reach: Bash can read your credentials/env, Read
// touches the filesystem, the Agent/Task tool is delegation. This reads a real
// install and emits the swarm.json that swarm-posture.ts assesses.
//
//   bun adapt.ts pai ~/.claude   > my-swarm.json && bun swarm-posture.ts my-swarm.json
//   bun adapt.ts pi  ~/.pi/agent > my-swarm.json && bun swarm-posture.ts my-swarm.json
//
// NorthWoods Sentinel Labs · Apache-2.0

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const mode = process.argv[2];
const dir = process.argv[3];
if (!mode || !dir) { console.error("usage: adapt.ts <pai|pi> <install-dir>"); process.exit(1); }

// Tool → what data it can reach. This is the judgment, encoded once.
// Bash is the big one: a shell reaches env vars, ~/.env, 1Password, config — secrets.
const TIERS = { 0: "public", 1: "network-egress", 2: "filesystem", 3: "secrets", 4: "substrate/memory" };
const SENSITIVE_AT = 3; // secrets and above
type Reach = { class: string; max_sensitivity: number };
const TOOL_REACH: Record<string, Reach[]> = {
  bash: [{ class: "secrets", max_sensitivity: 3 }, { class: "filesystem", max_sensitivity: 2 }],
  read: [{ class: "filesystem", max_sensitivity: 2 }], glob: [{ class: "filesystem", max_sensitivity: 2 }], grep: [{ class: "filesystem", max_sensitivity: 2 }],
  write: [{ class: "filesystem", max_sensitivity: 2 }], edit: [{ class: "filesystem", max_sensitivity: 2 }],
  webfetch: [{ class: "network-egress", max_sensitivity: 1 }], websearch: [{ class: "network-egress", max_sensitivity: 1 }],
};
const DELEGATION = ["agent", "task"];               // tools that let a worker spawn another
const ALL_TOOLS = [...Object.keys(TOOL_REACH), ...DELEGATION, "mcp"];

interface Worker { id: string; role: string; reads: Reach[]; invokes: string[] }

function dedupeReads(rs: Reach[]): Reach[] {
  const m = new Map<string, number>();
  for (const r of rs) m.set(r.class, Math.max(m.get(r.class) ?? 0, r.max_sensitivity));
  return [...m].map(([c, s]) => ({ class: c, max_sensitivity: s }));
}
// map a set of tool tokens → reads + whether it can delegate
function toolsToWorker(id: string, role: string, tools: string[], allOtherIds: () => string[]): Worker {
  const t = tools.map((x) => x.toLowerCase().trim());
  const isAll = t.some((x) => x === "all tools" || x.startsWith("all tools"));
  const has = (name: string) => isAll ? !t.some((x) => x.includes(`except`) && x.includes(name)) : t.some((x) => x === name || x.startsWith(name));
  const reads: Reach[] = [];
  for (const [tool, reach] of Object.entries(TOOL_REACH)) if (has(tool)) reads.push(...reach);
  if (has("mcp") || t.some((x) => x.startsWith("mcp"))) reads.push({ class: "external-service", max_sensitivity: 2 });
  const canDelegate = DELEGATION.some((d) => has(d));
  return { id, role, reads: dedupeReads(reads), invokes: canDelegate ? allOtherIds().filter((x) => x !== id) : [] };
}

// ── PAI (Claude Code) ────────────────────────────────────────────────────────
function fromPAI(root: string): Worker[] {
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) { console.error(`no agents/ dir under ${root}`); process.exit(1); }
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  const names = files.map((f) => f.replace(/\.md$/, ""));
  const workers: Worker[] = [];
  for (const f of files) {
    const txt = readFileSync(join(agentsDir, f), "utf8");
    const name = (txt.match(/^name:\s*(.+)$/m)?.[1] ?? f.replace(/\.md$/, "")).trim();
    const toolsLine = txt.match(/^tools:\s*(.+)$/m)?.[1]?.trim();
    // No tools: field in a Claude Code subagent = inherits ALL tools.
    const tools = toolsLine ? toolsLine.split(/\s*,\s*/) : ["All tools"];
    workers.push(toolsToWorker(name, name, tools, () => names));
  }
  return workers;
}

// ── pi ───────────────────────────────────────────────────────────────────────
// pi's tools are its loaded extensions + built-in shell/file. Single-harness:
// one agent whose reach is the union of what its extensions + core tools touch.
function fromPI(root: string): Worker[] {
  const extDir = join(root, "extensions");
  const exts = existsSync(extDir) ? readdirSync(extDir).filter((f) => f.endsWith(".ts")) : [];
  // pi always has shell + file access built in.
  const reads: Reach[] = [...TOOL_REACH.bash, ...TOOL_REACH.read];
  // classify extensions by what they touch (name heuristic — inspect and refine per install).
  for (const e of exts) {
    const n = e.toLowerCase();
    if (/substrate|bht|memory|loam/.test(n)) reads.push({ class: "substrate/memory", max_sensitivity: 4 });
    if (/shuttle|fleet|daemon|mycelia/.test(n)) reads.push({ class: "fleet-comms", max_sensitivity: 3 });
    if (/search|fff|grep|read/.test(n)) reads.push({ class: "filesystem", max_sensitivity: 2 });
    if (/external|review|web|fetch/.test(n)) reads.push({ class: "network-egress", max_sensitivity: 1 });
  }
  return [{ id: "pi-agent", role: "pi", reads: dedupeReads(reads), invokes: [] }];
}

const workers = mode === "pai" ? fromPAI(dir) : mode === "pi" ? fromPI(dir) : (() => { console.error(`unknown mode "${mode}"`); process.exit(1); })();
const swarm = {
  swarm: `${mode}-install`,
  _generated_by: `adapt.ts ${mode} ${dir}`,
  _note: "Tool→reach mapping is a starting heuristic. Set role_owns to mark which roles LEGITIMATELY hold each sensitive class, and refine reads if your agents are tool-restricted.",
  data_tiers: TIERS,
  sensitive_at_or_above: SENSITIVE_AT,
  role_owns: {},
  workers,
};
console.log(JSON.stringify(swarm, null, 2));
