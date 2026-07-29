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

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

// recursively read all files with a given extension, as their text contents.
function collectFiles(root: string, ext: string, depth = 6): string[] {
  const out: string[] = [];
  const walk = (d: string, dep: number) => {
    if (dep < 0) return;
    let entries: string[]; try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e.startsWith(".venv") || e === "__pycache__") continue;
      const p = join(d, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, dep - 1);
      else if (e.endsWith(ext)) { try { out.push(readFileSync(p, "utf8")); } catch { /* skip */ } }
    }
  };
  const st = existsSync(root) ? statSync(root) : null;
  if (st?.isFile()) { try { out.push(readFileSync(root, "utf8")); } catch { /* skip */ } }
  else walk(root, depth);
  return out;
}

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

// ── MCP servers: a configured server extends every agent that can reach it ──
// github-mcp-server is the common big one, and its grants are DECLARED: the
// toolsets allow-list (GITHUB_TOOLSETS env / --toolsets arg, or the remote URL)
// decides whether an agent merely reads issues or can touch code, CI, and
// security findings. Map each toolset to what it reaches. Read-only mode does
// not shrink DATA reach (Actions logs leak secrets to a reader too) — it only
// removes write paths, which this structural model doesn't score yet.
const GITHUB_TOOLSET_REACH: Record<string, Reach[]> = {
  repos: [{ class: "source-code", max_sensitivity: 3 }],
  pull_requests: [{ class: "source-code", max_sensitivity: 3 }],
  gists: [{ class: "source-code", max_sensitivity: 2 }],
  actions: [{ class: "ci-cd", max_sensitivity: 3 }],
  code_security: [{ class: "security-findings", max_sensitivity: 3 }],
  secret_protection: [{ class: "security-findings", max_sensitivity: 3 }],
  security_advisories: [{ class: "security-findings", max_sensitivity: 3 }],
  dependabot: [{ class: "security-findings", max_sensitivity: 3 }],
  issues: [{ class: "github-collab", max_sensitivity: 2 }],
  discussions: [{ class: "github-collab", max_sensitivity: 2 }],
  users: [{ class: "github-collab", max_sensitivity: 2 }],
  orgs: [{ class: "github-collab", max_sensitivity: 2 }],
  notifications: [{ class: "github-collab", max_sensitivity: 2 }],
  context: [],                                       // server-side context helpers, no distinct reach
};
// per README: the `default` toolset = context, repos, issues, pull_requests, users
const GITHUB_DEFAULT_TOOLSETS = ["context", "repos", "issues", "pull_requests", "users"];

// find every `mcpServers` object anywhere in a config JSON (Claude Code nests
// them per-project inside ~/.claude.json as well as at top level).
function findMcpServers(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "mcpServers" && v && typeof v === "object") out.push(v as Record<string, unknown>);
      else findMcpServers(v, out);
    }
  }
  return out;
}

// read the install's MCP config and return the reach its servers add.
function mcpServerReach(root: string): Reach[] {
  const reads: Reach[] = [];
  const candidates = [join(root, ".mcp.json"), join(root, "settings.json"), join(root, "..", ".claude.json")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let cfg: unknown; try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    for (const servers of findMcpServers(cfg)) {
      for (const [name, sc] of Object.entries(servers)) {
        const raw = JSON.stringify(sc).toLowerCase();
        if (/github-mcp-server|githubcopilot\.com\/mcp/.test(raw) || name.toLowerCase() === "github") {
          // toolsets from env, args, or remote URL path (…/mcp/x/<toolset>); else the documented default set.
          const declared = raw.match(/"github_toolsets"\s*:\s*"([a-z_,\s]+)"/)?.[1]
            ?? raw.match(/--toolsets[",\s]+([a-z_,]+)/)?.[1]
            ?? raw.match(/githubcopilot\.com\/mcp\/x\/([a-z_]+)/)?.[1];
          const toolsets = declared === "all" || raw.includes('"all"')
            ? Object.keys(GITHUB_TOOLSET_REACH)
            : (declared?.split(",").map((t) => t.trim()) ?? GITHUB_DEFAULT_TOOLSETS);
          for (const t of toolsets) reads.push(...(GITHUB_TOOLSET_REACH[t] ?? []));
        } else {
          reads.push({ class: "external-service", max_sensitivity: 2 }); // unknown server — generic
        }
      }
    }
  }
  return reads;
}

interface Worker { id: string; role: string; reads: Reach[]; invokes: string[] }

function dedupeReads(rs: Reach[]): Reach[] {
  const m = new Map<string, number>();
  for (const r of rs) m.set(r.class, Math.max(m.get(r.class) ?? 0, r.max_sensitivity));
  return [...m].map(([c, s]) => ({ class: c, max_sensitivity: s }));
}
// map a set of tool tokens → reads + whether it can delegate
function toolsToWorker(id: string, role: string, tools: string[], allOtherIds: () => string[], mcpReads: Reach[] = []): Worker {
  const t = tools.map((x) => x.toLowerCase().trim());
  const isAll = t.some((x) => x === "all tools" || x.startsWith("all tools"));
  const has = (name: string) => isAll ? !t.some((x) => x.includes(`except`) && x.includes(name)) : t.some((x) => x === name || x.startsWith(name));
  const reads: Reach[] = [];
  for (const [tool, reach] of Object.entries(TOOL_REACH)) if (has(tool)) reads.push(...reach);
  if (has("mcp") || t.some((x) => x.startsWith("mcp"))) {
    // configured servers give specific reach; fall back to generic when none found
    if (mcpReads.length) reads.push(...mcpReads);
    else reads.push({ class: "external-service", max_sensitivity: 2 });
  }
  const canDelegate = DELEGATION.some((d) => has(d));
  return { id, role, reads: dedupeReads(reads), invokes: canDelegate ? allOtherIds().filter((x) => x !== id) : [] };
}

// ── PAI (Claude Code) ────────────────────────────────────────────────────────
function fromPAI(root: string): Worker[] {
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) { console.error(`no agents/ dir under ${root}`); process.exit(1); }
  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  const names = files.map((f) => f.replace(/\.md$/, ""));
  const mcpReads = mcpServerReach(root);   // configured MCP servers (e.g. github-mcp-server toolsets)
  const workers: Worker[] = [];
  for (const f of files) {
    const txt = readFileSync(join(agentsDir, f), "utf8");
    const name = (txt.match(/^name:\s*(.+)$/m)?.[1] ?? f.replace(/\.md$/, "")).trim();
    const toolsLine = txt.match(/^tools:\s*(.+)$/m)?.[1]?.trim();
    // No tools: field in a Claude Code subagent = inherits ALL tools.
    const tools = toolsLine ? toolsLine.split(/\s*,\s*/) : ["All tools"];
    workers.push(toolsToWorker(name, name, tools, () => names, mcpReads));
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

// ── generalized tool-NAME → reach (for frameworks with arbitrary tool names) ─
// LangGraph/CrewAI tools are named freely. Classify by what the name implies it
// touches. Heuristic, and honest about it — the README says refine role_owns/reads.
function reachForToolName(name: string): Reach[] {
  const n = name.toLowerCase();
  const out: Reach[] = [];
  if (/shell|bash|python|exec|terminal|code_?interpreter|command|subprocess|repl/.test(n)) out.push({ class: "secrets", max_sensitivity: 3 }, { class: "filesystem", max_sensitivity: 2 });
  if (/github|gitlab|repo|pull_?request|commit|branch/.test(n)) out.push({ class: "source-code", max_sensitivity: 3 });
  if (/secret|credential|vault|api_?key|token|env/.test(n)) out.push({ class: "secrets", max_sensitivity: 3 });
  if (/sql|db|database|postgres|mysql|mongo|query|datastore/.test(n)) out.push({ class: "database", max_sensitivity: 3 });
  if (/file|read|write|fs|directory|path|document|load/.test(n)) out.push({ class: "filesystem", max_sensitivity: 2 });
  if (/web|search|http|fetch|browse|url|scrape|request/.test(n)) out.push({ class: "network-egress", max_sensitivity: 1 });
  if (/email|slack|send|message|webhook|notify|post/.test(n)) out.push({ class: "external-service", max_sensitivity: 2 });
  return out.length ? out : [{ class: "unknown-tool", max_sensitivity: 1 }];
}
const idTokens = (s: string) => (s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

// ── LangGraph (parse the Python graph construction) ─────────────────────────
function fromLangGraph(root: string): Worker[] {
  const py = collectFiles(root, ".py");
  const nodes = new Set<string>();
  const edges: Array<[string, string]> = [];
  const bindings: Array<{ varName: string; tools: string[] }> = []; // LHS var of a bind_tools/ToolNode call
  const shared = new Set<string>();                                  // tools we can't attribute to a node
  for (const src of py) {
    for (const m of src.matchAll(/\.add_node\(\s*["']([^"']+)["']/g)) nodes.add(m[1]);
    for (const m of src.matchAll(/\.add_edge\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g)) edges.push([m[1], m[2]]);
    for (const m of src.matchAll(/\.add_conditional_edges\(\s*["']([^"']+)["']/g)) nodes.add(m[1]);
    for (const m of src.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^=\n]*?(?:bind_tools|ToolNode)\(\s*\[([^\]]*)\]/g)) bindings.push({ varName: m[1].toLowerCase(), tools: idTokens(m[2]) });
    for (const m of src.matchAll(/(?<![=]\s*[^=\n]{0,80})(?:bind_tools|ToolNode)\(\s*\[([^\]]*)\]/g)) { /* unassigned binds handled below via shared */ }
  }
  for (const [a, b] of edges) { nodes.add(a); nodes.add(b); }
  const START = new Set(["START", "END", "__start__", "__end__"]);
  const list = [...nodes].filter((n) => !START.has(n));
  const stem = (s: string) => s.toLowerCase().replace(/_?(llm|agent|node|fn|chain|runnable|model|bound)$/g, "").replace(/_/g, "");
  // any binding whose var matches no node → its tools are shared across the graph.
  for (const b of bindings) if (!list.some((n) => stem(b.varName).includes(stem(n)) || stem(n).includes(stem(b.varName)))) b.tools.forEach((t) => shared.add(t));
  return list.map((id) => {
    const own = bindings.filter((b) => stem(b.varName).includes(stem(id)) || stem(id).includes(stem(b.varName))).flatMap((b) => b.tools);
    const tools = [...new Set([...own, ...shared])];
    return { id, role: id, reads: dedupeReads(tools.flatMap(reachForToolName)), invokes: edges.filter(([a]) => a === id).map(([, b]) => b).filter((b) => !START.has(b)) };
  });
}

// ── CrewAI (agents.yaml + Agent()/Crew() in Python) ─────────────────────────
function fromCrewAI(root: string): Worker[] {
  const py = collectFiles(root, ".py").join("\n");
  const yaml = collectFiles(root, ".yaml").concat(collectFiles(root, ".yml")).join("\n");
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const hierarchical = /Process\.hierarchical/.test(py);

  // agents.yaml: each top-level key is an agent; capture its role: value to match Python.
  const yamlRole = new Map<string, string>(); // yaml key -> normalized role
  for (const m of yaml.matchAll(/^([a-z0-9_]+):\s*\n(?:[ \t]+.*\n)*?[ \t]+role:\s*["']?([^"'\n]+)["']?/gim)) yamlRole.set(m[1], norm(m[2]));

  const agents = new Map<string, { tools: string[]; delegation: boolean }>();
  for (const key of yamlRole.keys()) agents.set(key, { tools: [], delegation: false });
  // Python Agent(role=..., tools=[...], allow_delegation=...) → attach to the matching yaml agent by role.
  for (const m of py.matchAll(/Agent\(([\s\S]{0,500}?)\)/g)) {
    const blk = m[1];
    const roleRaw = blk.match(/role\s*=\s*["']([^"']+)["']/)?.[1];
    if (!roleRaw) continue;
    const role = norm(roleRaw);
    const tools = idTokens(blk.match(/tools\s*=\s*\[([^\]]*)\]/)?.[1] ?? "");
    const delegation = /allow_delegation\s*=\s*True/.test(blk);
    const key = [...yamlRole.entries()].find(([, r]) => r === role)?.[0] ?? role; // match yaml agent, else python-only
    const cur = agents.get(key) ?? { tools: [], delegation: false };
    cur.tools = [...new Set([...cur.tools, ...tools])];
    cur.delegation = cur.delegation || delegation;
    agents.set(key, cur);
  }
  const ids = [...agents.keys()];
  const workers: Worker[] = ids.map((id) => {
    const a = agents.get(id)!;
    return { id, role: id, reads: dedupeReads(a.tools.flatMap(reachForToolName)), invokes: a.delegation ? ids.filter((x) => x !== id) : [] };
  });
  // hierarchical process → an auto-manager delegates to the whole crew. Represent it,
  // so its reach-through-a-deputy (the classic hierarchical risk) shows as an attack path.
  if (hierarchical) workers.push({ id: "crew_manager", role: "manager", reads: [], invokes: ids });
  return workers;
}

const workers = mode === "pai" ? fromPAI(dir) : mode === "pi" ? fromPI(dir)
  : mode === "langgraph" ? fromLangGraph(dir) : mode === "crewai" ? fromCrewAI(dir)
  : (() => { console.error(`unknown mode "${mode}" (pai|pi|langgraph|crewai)`); process.exit(1); })();
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
