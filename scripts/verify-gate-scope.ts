#!/usr/bin/env -S npx tsx
// verify-gate-scope: a gate must show how much it checked (AGENTS.md "Always test new or modified code").
// Two silent-shrink failures this catches, both of which would leave the gate green while checking less:
//   1. a tracked .ts/.mts file that is in no tsconfig project is never typechecked (or linted with types);
//   2. a first-party source file (a .ts file at the repo root) missing from the coverage summary is never held
//      to the 90% bar. Zero measured files is a failure, never a pass.
// Fix a failure by fixing the include lists, never by excusing the file.
// Runs after `vitest run --coverage` (via `npm test`), which writes coverage/coverage-summary.json.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const fail = (msg: string): never => {
  throw new Error(`verify-gate-scope: ${msg}`);
};

const ls = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.mts"], {
  cwd: root,
  encoding: "utf8",
});
if (ls.status !== 0) fail(`git ls-files failed:\n${ls.stderr}`);
const tracked = ls.stdout.split("\n").filter((f) => f && !f.startsWith("node_modules/"));
if (!tracked.length) fail("found no .ts/.mts files at all; the check itself is broken");

// 1. typecheck scope. Read the project's file list through the TypeScript API in-process (no subprocess, so the
// result cannot depend on how a launcher behaves in a given shell or sandbox).
const parsed = ts.getParsedCommandLineOfConfigFile(
  resolve(root, "tsconfig.json"),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) =>
      fail(`tsconfig.json: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`),
  },
);
if (!parsed || parsed.errors.length) fail("could not parse tsconfig.json; the check itself is broken");
const typed = new Set(parsed!.fileNames.map((f) => relative(root, f)));
if (!typed.size) fail("tsconfig.json lists no files; the check itself is broken");
const untyped = tracked.filter((f) => !typed.has(f));

// 2. coverage scope: the first-party sources are the .ts files at the repo root (the two CLI scripts).
const summaryPath = resolve(root, "coverage/coverage-summary.json");
if (!existsSync(summaryPath)) fail("no coverage summary; run vitest with --coverage first");
const measured = new Set(
  Object.keys(JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>)
    .filter((k) => k !== "total")
    .map((k) => relative(root, k)),
);
const sources = tracked.filter((f) => !f.includes("/") && f.endsWith(".ts") && !f.endsWith(".d.ts"));
if (!sources.length) fail("found no first-party source files; the check itself is broken");
if (!measured.size) fail("coverage measured zero files; the gate would pass while checking nothing");
const unmeasured = sources.filter((f) => !measured.has(f));

console.log(`gate scope: typechecked ${tracked.length - untyped.length} of ${tracked.length} .ts/.mts files`);
console.log(`gate scope: coverage measured ${sources.length - unmeasured.length} of ${sources.length} source files`);
if (untyped.length || unmeasured.length) {
  for (const f of untyped) console.error(`  not in any tsconfig project: ${f}`);
  for (const f of unmeasured) console.error(`  missing from coverage: ${f}`);
  process.exit(1);
}
