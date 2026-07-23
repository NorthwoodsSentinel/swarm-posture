#!/usr/bin/env bun
// swarm-posture — attack-path analysis + least-privilege for AI agent swarms.
//
// Free structural posture check for agentic AI systems. Describe your swarm
// (workers, what data each reads, which workers each can invoke) and this finds:
//   • EXCESSIVE PERMISSIONS — a worker that can reach sensitive data its role
//     doesn't own. The silent case: injection lands and no gate ever fires,
//     because the worker was allowed too much (least-privilege / CIEM).
//   • ATTACK PATHS — a chain of authorized invocations that reaches sensitive
//     data no single worker should. Each hop looks fine; the composition is the
//     escalation. A per-worker review is structurally blind to it.
//
// Zero dependencies. Run:  bun swarm-posture.ts your-swarm.json
//                  or:     npx tsx swarm-posture.ts your-swarm.json
//
// This is the STRUCTURAL half. It reads your declared config — it does not run
// your agents. Whether a real model actually falls for an injection (behavioral
// simulation / intent-fidelity measurement) is the paid tier; see the footer.
//
// NorthWoods Sentinel Labs · Apache-2.0

interface DataRead { class: string; max_sensitivity: number }
interface Worker { id: string; role: string; reads: DataRead[]; invokes: string[] }
interface Swarm {
  swarm: string;
  data_tiers: Record<string, string>;
  sensitive_at_or_above: number;
  role_owns?: Record<string, string[]>; // role -> sensitive classes it legitimately owns
  workers: Worker[];
}

function die(msg: string): never { console.error(`swarm-posture: ${msg}`); process.exit(1); }

const file = process.argv[2];
if (!file) die("usage: swarm-posture.ts <swarm.json>  (see example-swarm.json)");
let cfg: Swarm;
try { cfg = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch (e) { die(`cannot read/parse ${file}: ${(e as Error).message}`); }
for (const k of ["workers", "data_tiers", "sensitive_at_or_above"] as const) if (cfg[k] === undefined) die(`swarm file missing "${k}"`);

const threshold = cfg.sensitive_at_or_above;
const tier = (s: number) => cfg.data_tiers[String(s)] ?? `sensitivity ${s}`;
const byId = new Map(cfg.workers.map((w) => [w.id, w]));
const owns = cfg.role_owns ?? {};

// The sensitive (class, sensitivity) reach of a worker: any read whose tier >= threshold.
function sensitiveReach(w: Worker): Array<{ class: string; sens: number }> {
  const out: Array<{ class: string; sens: number }> = [];
  for (const r of w.reads) for (let s = threshold; s <= r.max_sensitivity; s++) out.push({ class: r.class, sens: s });
  return out;
}
function roleOwns(role: string, cls: string): boolean { return (owns[role] ?? []).includes(cls); }

// ── 1 · LEAST-PRIVILEGE (excessive permissions / blast radius) ──────────────
const excessive: Array<{ worker: string; role: string; hits: string[] }> = [];
for (const w of cfg.workers) {
  const reach = sensitiveReach(w);
  const notOwned = [...new Set(reach.filter((r) => !roleOwns(w.role, r.class)).map((r) => `${r.class} (${tier(r.sens)})`))];
  if (notOwned.length) excessive.push({ worker: w.id, role: w.role, hits: notOwned });
}

// ── 2 · ATTACK-PATH ANALYSIS (composed escalation across invoke edges) ──────
// Walk invoke edges from each worker; report a path whose terminal reaches a
// sensitive class the ORIGIN can't reach directly — i.e. the origin gets there
// only through a deputy. An attack path to a class the origin ALREADY holds
// directly is not an escalation (that's just blast radius, reported above), so
// it is skipped — which also keeps a densely-connected swarm from exploding.
const MAX_DEPTH = 6; // real escalation chains are short; bounds path enumeration
interface Path { chain: string[]; reaches: string }
const paths: Path[] = [];
const seen = new Set<string>();
const directClasses = (w: Worker) => new Set(sensitiveReach(w).map((r) => r.class));
const allSensitive = new Set(cfg.workers.flatMap((w) => sensitiveReach(w).map((r) => r.class)));
function walk(originRole: string, ownDirect: Set<string>, chain: string[]) {
  if (chain.length > MAX_DEPTH) return;
  const node = byId.get(chain[chain.length - 1]);
  if (!node) return;
  for (const next of node.invokes) {
    if (chain.includes(next)) continue; // cycle guard
    const nw = byId.get(next);
    if (!nw) continue;
    const newChain = [...chain, next];
    for (const r of sensitiveReach(nw)) {
      if (roleOwns(originRole, r.class) || ownDirect.has(r.class)) continue; // origin owns or already reaches it directly
      const key = newChain.join(">") + ":" + r.class;
      if (seen.has(key)) continue; seen.add(key);
      paths.push({ chain: newChain, reaches: `${r.class} (${tier(r.sens)})` });
    }
    walk(originRole, ownDirect, newChain);
  }
}
for (const w of cfg.workers) {
  const own = directClasses(w);
  // if the origin already reaches every sensitive class directly, no invoke path
  // can grant it MORE — skip its walk entirely (this short-circuits dense swarms).
  if ([...allSensitive].every((c) => own.has(c) || roleOwns(w.role, c))) continue;
  walk(w.role, own, [w.id]);
}

// ── report ──────────────────────────────────────────────────────────────────
const B = "\x1b[1m", D = "\x1b[2m", Y = "\x1b[33m", R = "\x1b[31m", G = "\x1b[32m", X = "\x1b[0m";
console.log(`\n${B}swarm-posture${X} — ${cfg.swarm}  ${D}(${cfg.workers.length} workers · sensitive = ${tier(threshold)} and above)${X}\n`);

// ── POSTURE HEADLINE — the finding at a glance ──────────────────────────────
const n = cfg.workers.length;
const withDelegation = cfg.workers.filter((w) => w.invokes.length > 0).length;
const reachSensitive = cfg.workers.filter((w) => sensitiveReach(w).length > 0);
// which single sensitive class the most workers reach (the dominant exposure)
const classCount = new Map<string, number>();
for (const w of cfg.workers) for (const c of new Set(sensitiveReach(w).map((r) => r.class))) classCount.set(c, (classCount.get(c) ?? 0) + 1);
const topClass = [...classCount.entries()].sort((a, b) => b[1] - a[1])[0];
let verdict: string;
if (excessive.length === 0 && paths.length === 0) verdict = `${G}tight — no worker reaches sensitive data outside its role, no escalation paths.${X}`;
else if (topClass && topClass[1] === n && withDelegation === n) verdict = `${R}unscoped — all ${n} workers can reach ${topClass[0]} and spawn other agents. This fleet has no per-agent least-privilege.${X}`;
else verdict = `${Y}${excessive.length} worker(s) over-broad for their role, ${paths.length} escalation path(s). Not least-privilege.${X}`;
console.log(`${B}POSTURE${X}  ${verdict}`);
console.log(`${D}  ${n} workers · ${reachSensitive.length} reach sensitive data · ${withDelegation} can spawn other agents · ${topClass ? topClass[1] + " reach " + topClass[0] : "none reach sensitive"}${X}\n`);

console.log(`${B}EXCESSIVE PERMISSIONS${X} ${D}(least-privilege / blast radius)${X}`);
// collapse the common case: many workers, same single over-broad class → one line + detail.
if (excessive.length > 5 && new Set(excessive.flatMap((e) => e.hits)).size <= 2) {
  const cls = [...new Set(excessive.flatMap((e) => e.hits))].join(", ");
  console.log(`  ${Y}⚠${X} ${B}${excessive.length} of ${n} workers${X} reach ${cls} — none are tool-scoped. ${D}Set role_owns to mark which roles legitimately need it; scope the rest down.${X}`);
  console.log(`  ${D}   (${excessive.map((e) => e.worker).join(", ")})${X}`);
} else {
  if (!excessive.length) console.log(`  ${G}none — every worker's sensitive reach is owned by its role.${X}`);
  for (const e of excessive) console.log(`  ${Y}⚠${X} ${B}${e.worker}${X} ${D}(role: ${e.role})${X} reaches ${e.hits.join(", ")} ${D}— its role does not own this; scope down.${X}`);
}

console.log(`\n${B}ATTACK PATHS${X} ${D}(composed escalation — a chain a per-worker review can't see)${X}`);
if (!paths.length) console.log(`  ${G}none — no invocation chain reaches sensitive data its origin doesn't own.${X}`);
for (const p of paths) console.log(`  ${R}⚠${X} ${p.chain.join(" → ")} ${D}reaches${X} ${p.reaches} ${D}— an injected ${p.chain[0]} needs no such access itself; it invokes a deputy that has it.${X}`);

const findings = excessive.length + paths.length;
console.log(`\n${B}━━ SUMMARY ━━${X}`);
console.log(`  ${findings === 0 ? G + "clean" + X + " — no structural findings" : (excessive.length ? R : G) + String(findings) + X + " structural finding(s): " + excessive.length + " excessive-permission, " + paths.length + " attack-path"}`);
console.log(`\n${D}This is the STRUCTURAL check (free). It reads your declared config; it does not run your agents.`);
console.log(`Behavioral simulation — running your workers under live prompt injection to measure whether they`);
console.log(`ACTUALLY breach their intended objective (intent fidelity), and how often — is the paid tier.`);
console.log(`→ NorthWoods Sentinel Labs${X}\n`);
