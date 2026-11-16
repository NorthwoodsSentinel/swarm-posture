// Test and coverage config. The coverage bar is the source's (modelcontextprotocol/inspector): >= 90 on all four
// dimensions, per file, enforced here and therefore in `npm test` and CI. Never lower it to pass;
// see AGENTS.md "Always test new or modified code".
// Coverage `include` lists exact paths (the two CLI scripts at the repo root), never a glob: a glob can silently
// match nothing or the wrong files. scripts/verify-gate-scope.ts fails the gate if either is missing from the report.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["swarm-posture.ts", "adapt.ts"],
      reporter: [["text", { skipFull: false }], "json-summary"],
      thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
