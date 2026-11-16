// Tests for adapt.ts, which turns an agent-harness install into a swarm.json. The two golden cases pin the output
// for the shipped examples byte for byte against what the script printed before the factory change; the rest build
// synthetic installs in a temp directory (never a real one) and check the reach each mode assigns.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScript } from "./helpers/run.ts";

const tmp = mkdtempSync(join(tmpdir(), "swarm-posture-adapt-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** Create a fresh install tree under its own parent dir; keys are relative paths, values file contents. */
function tree(files: Record<string, string>): string {
  const parent = join(tmp, `case-${n++}`);
  const root = join(parent, "install");
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(parent, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

interface Reach {
  class: string;
  max_sensitivity: number;
}
interface Worker {
  id: string;
  role: string;
  reads: Reach[];
  invokes: string[];
}
async function adapt(mode: string, root: string): Promise<Worker[]> {
  const r = await runScript("adapt.ts", [mode, root]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  const swarm = JSON.parse(r.stdout) as { workers: Worker[]; sensitive_at_or_above: number; swarm: string };
  expect(swarm.sensitive_at_or_above).toBe(3);
  expect(swarm.swarm).toBe(`${mode}-install`);
  return swarm.workers;
}
const reach = (w: Worker | undefined) => Object.fromEntries((w?.reads ?? []).map((r) => [r.class, r.max_sensitivity]));
const byId = (ws: Worker[], id: string) => ws.find((w) => w.id === id);

describe("adapt CLI arguments", () => {
  it("prints usage and exits 1 without a mode and dir", async () => {
    for (const args of [[], ["pai"]]) {
      const r = await runScript("adapt.ts", args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("usage: adapt.ts <pai|pi> <install-dir>");
    }
  });

  it("rejects an unknown mode", async () => {
    const r = await runScript("adapt.ts", ["autogen", tmp]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown mode "autogen" (pai|pi|langgraph|crewai)');
    expect(r.stdout).toBe("");
  });
});

describe("golden output for the shipped examples", () => {
  it("langgraph examples", async () => {
    const r = await runScript("adapt.ts", ["langgraph", "examples"]);
    expect(r.stdout).toBe(readFileSync("test/golden/adapt-lg.txt", "utf8"));
  });
  it("crewai example project", async () => {
    const r = await runScript("adapt.ts", ["crewai", "examples/crewai-project"]);
    expect(r.stdout).toBe(readFileSync("test/golden/adapt-crew.txt", "utf8"));
  });
});

describe("pai mode", () => {
  it("exits 1 when there is no agents/ dir", async () => {
    const root = tree({});
    const r = await runScript("adapt.ts", ["pai", root]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`no agents/ dir under ${root}`);
  });

  it("maps each agent's tools to reach and delegation to invoke edges", async () => {
    const root = tree({
      "install/agents/reader.md": "---\nname: Reader\ntools: Read, Grep, WebFetch\n---\n",
      "install/agents/inherit.md": "---\ndescription: no tools line, so all tools\n---\n",
      "install/agents/nobash.md": "---\nname: NoBash\ntools: All tools except Bash, Agent\n---\n",
      "install/agents/boss.md": "---\nname: Boss\ntools: Task, Edit\n---\n",
      "install/agents/notes.txt": "ignored",
    });
    const ws = await adapt("pai", root);
    expect(ws.map((w) => w.id).sort()).toEqual(["Boss", "NoBash", "Reader", "inherit"]);
    expect(reach(byId(ws, "Reader"))).toEqual({ filesystem: 2, "network-egress": 1 });
    expect(byId(ws, "Reader")?.invokes).toEqual([]);
    // no tools: line inherits everything, including MCP (generic reach: no MCP config here) and delegation
    expect(reach(byId(ws, "inherit"))).toEqual({
      secrets: 3,
      filesystem: 2,
      "network-egress": 1,
      "external-service": 2,
    });
    expect(byId(ws, "inherit")?.invokes.sort()).toEqual(["boss", "nobash", "reader"]);
    expect(reach(byId(ws, "NoBash"))).not.toHaveProperty("secrets");
    // "except bash, agent" still has task. Pre-existing: invoke targets are filenames but self is filtered by
    // name:, so an agent whose name differs from its filename lists itself.
    expect(byId(ws, "NoBash")?.invokes.sort()).toEqual(["boss", "inherit", "nobash", "reader"]);
    expect(byId(ws, "Boss")?.invokes.sort()).toEqual(["boss", "inherit", "nobash", "reader"]);
  });

  it("uses declared github-mcp-server toolsets from each config location", async () => {
    const env = { mcpServers: { gh: { command: "github-mcp-server", env: { GITHUB_TOOLSETS: "actions,issues" } } } };
    const root = tree({
      "install/agents/a.md": "---\nname: A\ntools: mcp__gh\n---\n",
      "install/.mcp.json": JSON.stringify(env),
    });
    expect(reach(byId(await adapt("pai", root), "A"))).toEqual({ "ci-cd": 3, "github-collab": 2 });

    const header = { mcpServers: { github: { url: "https://x", headers: { "X-MCP-Toolsets": "code_security" } } } };
    const root2 = tree({
      "install/agents/a.md": "---\nname: A\ntools: MCP\n---\n",
      "install/settings.json": JSON.stringify(header),
    });
    expect(reach(byId(await adapt("pai", root2), "A"))).toEqual({ "security-findings": 3 });

    const nested = {
      projects: { "/p": { mcpServers: { g: { command: "x", args: ["github-mcp-server", "--toolsets", "gists"] } } } },
    };
    const root3 = tree({
      "install/agents/a.md": "---\nname: A\ntools: mcp\n---\n",
      ".claude.json": JSON.stringify(nested),
    });
    expect(reach(byId(await adapt("pai", root3), "A"))).toEqual({ "source-code": 2 });

    const remote = { mcpServers: { r: { url: "https://api.githubcopilot.com/mcp/x/dependabot" } } };
    const root4 = tree({
      "install/agents/a.md": "---\nname: A\ntools: mcp\n---\n",
      "install/.mcp.json": JSON.stringify(remote),
    });
    expect(reach(byId(await adapt("pai", root4), "A"))).toEqual({ "security-findings": 3 });
  });

  it("expands all, default and undeclared toolsets; maps unknown servers and empty reach", async () => {
    const cfg = (sc: unknown) => ({
      "install/agents/a.md": "---\nname: A\ntools: mcp\n---\n",
      "install/.mcp.json": JSON.stringify({ mcpServers: sc }),
    });
    const all = reach(
      byId(
        await adapt("pai", tree(cfg({ g: { command: "github-mcp-server", env: { GITHUB_TOOLSETS: "all" } } }))),
        "A",
      ),
    );
    expect(all).toEqual({ "source-code": 3, "ci-cd": 3, "security-findings": 3, "github-collab": 2 });

    const def = reach(
      byId(
        await adapt(
          "pai",
          tree(cfg({ g: { command: "github-mcp-server", env: { GITHUB_TOOLSETS: "default,actions" } } })),
        ),
        "A",
      ),
    );
    expect(def).toEqual({ "ci-cd": 3, "source-code": 3, "github-collab": 2 });

    const none = reach(byId(await adapt("pai", tree(cfg({ g: { command: "github-mcp-server" } }))), "A"));
    expect(none).toEqual({ "source-code": 3, "github-collab": 2 });

    const unknownToolset = reach(
      byId(
        await adapt(
          "pai",
          tree(cfg({ g: { command: "github-mcp-server", env: { GITHUB_TOOLSETS: "context,bogus" } } })),
        ),
        "A",
      ),
    );
    expect(unknownToolset).toEqual({}); // configured, but zero mapped reach: no generic fallback

    const other = reach(byId(await adapt("pai", tree(cfg({ slack: { command: "slack-mcp" } }))), "A"));
    expect(other).toEqual({ "external-service": 2 });
  });

  it("skips an MCP config file that is not JSON", async () => {
    const root = tree({ "install/agents/a.md": "---\nname: A\ntools: mcp\n---\n", "install/.mcp.json": "{nope" });
    expect(reach(byId(await adapt("pai", root), "A"))).toEqual({ "external-service": 2 });
  });
});

describe("pi mode", () => {
  it("gives the single pi agent shell and file reach with no extensions dir", async () => {
    const ws = await adapt("pi", tree({}));
    expect(ws).toEqual([{ id: "pi-agent", role: "pi", reads: expect.any(Array), invokes: [] }]);
    expect(reach(ws[0])).toEqual({ secrets: 3, filesystem: 2 });
  });

  it("classifies extensions by name", async () => {
    const ws = await adapt(
      "pi",
      tree({
        "install/extensions/loam-memory.ts": "",
        "install/extensions/fleet-bus.ts": "",
        "install/extensions/fff-search.ts": "",
        "install/extensions/web-fetch.ts": "",
        "install/extensions/readme.md": "",
      }),
    );
    expect(reach(ws[0])).toEqual({
      secrets: 3,
      filesystem: 2,
      "substrate/memory": 4,
      "fleet-comms": 3,
      "network-egress": 1,
    });
  });
});

describe("langgraph mode", () => {
  it("reads a single file root, conditional edges, shared tools and skips vendored dirs", async () => {
    const src = [
      'g.add_node("planner", f)',
      'g.add_conditional_edges("router", pick)',
      'g.add_edge(START, "planner")',
      'g.add_edge("planner", "router")',
      'g.add_edge("router", END)',
      "planner_llm = llm.bind_tools([github_commit, slack_send])",
      "helpers = ToolNode([vault_token, postgres_query, mystery])",
    ].join("\n");
    const root = tree({
      "install/app/graph.py": src,
      "install/node_modules/x.py": 'g.add_node("vendored", f)',
      "install/.git/y.py": 'g.add_node("vendored", f)',
      "install/.venv-1/z.py": 'g.add_node("vendored", f)',
      "install/__pycache__/w.py": 'g.add_node("vendored", f)',
      "install/a/b/c/d/e/f/g/deep.py": 'g.add_node("toodeep", f)',
    });
    const ws = await adapt("langgraph", root);
    expect(ws.map((w) => w.id).sort()).toEqual(["planner", "router"]);
    expect(byId(ws, "planner")?.invokes).toEqual(["router"]);
    expect(byId(ws, "router")?.invokes).toEqual([]);
    // helpers matches no node, so its tools are shared by every node
    // postgres_query also matches "post" (name heuristic), so it adds external-service too
    expect(reach(byId(ws, "router"))).toEqual({ secrets: 3, database: 3, "external-service": 2, "unknown-tool": 1 });
    expect(reach(byId(ws, "planner"))).toEqual({
      "source-code": 3,
      "external-service": 2,
      secrets: 3,
      database: 3,
      "unknown-tool": 1,
    });

    const single = await adapt("langgraph", join(root, "app", "graph.py"));
    expect(single.map((w) => w.id).sort()).toEqual(["planner", "router"]);
  });

  it("returns no workers for a root that does not exist", async () => {
    expect(await adapt("langgraph", join(tmp, "does-not-exist"))).toEqual([]);
  });
});

describe("crewai mode", () => {
  it("handles python-only agents, roleless Agent() calls, .yml config and a sequential crew", async () => {
    const py = [
      'a = Agent(role="Data Analyst", tools=[file_reader, web_scraper], allow_delegation=True)',
      'b = Agent(role="Writer")',
      "c = Agent(goal='no role here')",
      "crew = Crew(agents=[a, b], process=Process.sequential)",
    ].join("\n");
    const ws = await adapt(
      "crewai",
      tree({ "install/crew.py": py, "install/config/agents.yml": "writer:\n  role: Writer\n  goal: write\n" }),
    );
    expect(ws.map((w) => w.id)).toEqual(["writer", "data_analyst"]);
    expect(byId(ws, "writer")).toEqual({ id: "writer", role: "writer", reads: [], invokes: [] });
    expect(reach(byId(ws, "data_analyst"))).toEqual({ filesystem: 2, "network-egress": 1 });
    expect(byId(ws, "data_analyst")?.invokes).toEqual(["writer"]);
  });
});
