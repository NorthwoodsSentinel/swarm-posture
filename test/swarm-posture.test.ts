// Tests for swarm-posture.ts, the structural posture check. The golden case pins the CLI output byte for byte
// against what the script printed before the factory change; the rest drive each finding and verdict branch with
// small synthetic swarms written to a temp directory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScript } from "./helpers/run.ts";

const dir = mkdtempSync(join(tmpdir(), "swarm-posture-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function swarmFile(cfg: unknown): string {
  const p = join(dir, `swarm-${n++}.json`);
  writeFileSync(p, typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  return p;
}
const posture = (cfg: unknown) => runScript("swarm-posture.ts", [swarmFile(cfg)]);
// eslint-disable-next-line no-control-regex -- stripping the ANSI colour codes the CLI prints
const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "");

type W = { id: string; role: string; reads: Array<{ class: string; max_sensitivity: number }>; invokes: string[] };
const tiers = { "0": "public", "1": "internal", "2": "pii", "3": "payment" };
const base = (workers: W[], extra: Record<string, unknown> = {}) => ({
  swarm: "t",
  data_tiers: tiers,
  sensitive_at_or_above: 2,
  workers,
  ...extra,
});
const w = (id: string, role: string, reads: Array<[string, number]>, invokes: string[] = []): W => ({
  id,
  role,
  reads: reads.map(([c, s]) => ({ class: c, max_sensitivity: s })),
  invokes,
});

describe("swarm-posture CLI", () => {
  it("prints exactly what the pre-change script printed for example-swarm.json", async () => {
    const r = await runScript("swarm-posture.ts", ["example-swarm.json"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(readFileSync("test/golden/posture-example.txt", "utf8"));
  });

  it("exits 1 with usage when no file is given", async () => {
    const r = await runScript("swarm-posture.ts", []);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("swarm-posture: usage: swarm-posture.ts <swarm.json>");
    expect(r.stdout).toBe("");
  });

  it("exits 1 when the file cannot be read", async () => {
    const r = await runScript("swarm-posture.ts", [join(dir, "missing.json")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read/parse");
  });

  it("exits 1 when the file is not JSON", async () => {
    const r = await posture("{not json");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read/parse");
  });

  for (const key of ["workers", "data_tiers", "sensitive_at_or_above"]) {
    it(`exits 1 when "${key}" is missing`, async () => {
      const cfg: Record<string, unknown> = base([]);
      delete cfg[key];
      const r = await posture(cfg);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`swarm file missing "${key}"`);
    });
  }

  it("reports a tight swarm when nothing reaches sensitive data", async () => {
    const r = await posture(base([w("a", "x", [["ticket", 1]])]));
    const out = plain(r.stdout);
    expect(r.code).toBe(0);
    expect(out).toContain("POSTURE  tight");
    expect(out).toContain("none reach sensitive");
    expect(out).toContain("none — every worker's sensitive reach is owned by its role.");
    expect(out).toContain("none — no invocation chain reaches sensitive data");
    expect(out).toContain("clean — no structural findings");
  });

  it("treats a class the role owns as not excessive", async () => {
    const r = await posture(base([w("b", "billing", [["payment", 3]])], { role_owns: { billing: ["payment"] } }));
    const out = plain(r.stdout);
    expect(out).toContain("POSTURE  tight");
    expect(out).toContain("1 reach payment");
  });

  it("labels a sensitivity with no tier name as 'sensitivity N'", async () => {
    const r = await posture(base([w("a", "x", [["vault", 4]])]));
    expect(plain(r.stdout)).toContain("reaches vault (pii), vault (payment), vault (sensitivity 4)");
  });

  it("calls a fleet unscoped when every worker reaches the same class and can delegate", async () => {
    const r = await posture(base([w("a", "x", [["payment", 3]], ["b"]), w("b", "y", [["payment", 3]], ["a"])]));
    const out = plain(r.stdout);
    expect(out).toContain("unscoped — all 2 workers can reach payment and spawn other agents");
    expect(out).toContain("2 structural finding(s): 2 excessive-permission, 0 attack-path");
  });

  it("collapses more than five excessive workers over at most two classes into one line", async () => {
    const ws = ["a", "b", "c", "d", "e", "f"].map((id) => w(id, "x", [["payment", 3]]));
    const out = plain((await posture(base(ws))).stdout);
    expect(out).toContain("⚠ 6 of 6 workers reach payment (pii), payment (payment) — none are tool-scoped.");
    expect(out).toContain("(a, b, c, d, e, f)");
  });

  it("lists excessive workers one by one when they span more than two classes", async () => {
    const ws = ["a", "b", "c", "d", "e", "f"].map((id, i) => w(id, "x", [[`c${i % 3}`, 2]]));
    const out = plain((await posture(base(ws))).stdout);
    expect(out).toContain("⚠ a (role: x) reaches c0 (pii) — its role does not own this; scope down.");
    expect(out).not.toContain("none are tool-scoped");
  });

  it("finds an attack path through a deputy and skips classes the origin owns or holds", async () => {
    const r = await posture(
      base(
        [
          w("triage", "triage", [["ticket", 1]], ["billing", "ghost", "holder"]),
          w("billing", "billing", [["payment", 3]], ["triage"]),
          w("holder", "holder", [["pii", 2]], []),
        ],
        { role_owns: { billing: ["payment"], triage: ["pii"], holder: ["pii"] } },
      ),
    );
    const out = plain(r.stdout);
    expect(out).toContain("triage → billing reaches payment (pii)");
    expect(out).not.toContain("triage → billing reaches payment (payment)"); // one path per chain and class
    expect(out).not.toContain("⚠ triage → holder"); // triage owns pii
    expect(out).toContain("⚠ billing → triage → holder reaches pii (pii)");
    // excessive = 0, paths > 0: the 3-way verdict falls through to the counted line, summary count is green
    expect(out).toContain("0 worker(s) over-broad for their role, 2 escalation path(s)");
    expect(out).toContain("2 structural finding(s): 0 excessive-permission, 2 attack-path");
    expect(r.stdout).toContain("\x1b[32m2\x1b[0m structural finding(s)");
  });

  it("stops at the depth bound", async () => {
    // a chain of 9 workers; only the last one reaches payment. MAX_DEPTH = 6 bounds chain length to 7.
    const ids = Array.from({ length: 9 }, (_, i) => `w${i}`);
    const ws = ids.map((id, i) => w(id, "r", i === 8 ? [["payment", 3]] : [], i < 8 ? [ids[i + 1]] : []));
    const out = plain((await posture(base(ws, { role_owns: { r: ["payment"] } }))).stdout);
    expect(out).toContain("POSTURE  tight");

    const ws2 = ids.map((id, i) =>
      w(id, i === 8 ? "owner" : "r", i === 8 ? [["payment", 3]] : [], i < 8 ? [ids[i + 1]] : []),
    );
    const out2 = plain((await posture(base(ws2, { role_owns: { owner: ["payment"] } }))).stdout);
    expect(out2).toContain("w2 → w3 → w4 → w5 → w6 → w7 → w8 reaches payment (pii)");
    expect(out2).not.toContain("w1 → w2 → w3 → w4 → w5 → w6 → w7 → w8");
    expect(out2.split("w7 → w8 reaches payment (pii)").length - 1).toBe(6); // origins w2..w7; w0 and w1 are past the depth bound
  });

  it("does not walk a worker that already reaches every sensitive class", async () => {
    const r = await posture(base([w("a", "x", [["payment", 3]], ["b"]), w("b", "y", [["payment", 3]], [])]));
    const out = plain(r.stdout);
    expect(out).not.toContain("a → b");
    expect(out).toContain("2 worker(s) over-broad for their role, 0 escalation path(s)");
  });
});
