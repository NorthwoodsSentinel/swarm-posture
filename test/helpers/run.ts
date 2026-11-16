// Runs one of the repo's top-level CLI scripts in-process so coverage can measure it.
// Both scripts do all their work at import time (argv in, console out, process.exit on error), so each call
// resets the module registry, sets process.argv, captures console output and turns process.exit into a thrown
// ExitError. The scripts themselves are not modified to make this possible.
import { vi } from "vitest";

export class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

const line = (args: unknown[]) => args.map(String).join(" ") + "\n";

export async function runScript(script: "swarm-posture.ts" | "adapt.ts", args: string[]): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const savedArgv = process.argv;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(line(a)));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(line(a)));
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new ExitError(typeof code === "number" ? code : undefined);
  });
  process.argv = ["node", script, ...args];
  vi.resetModules();
  let code = 0;
  try {
    await (script === "adapt.ts" ? import("../../adapt.ts") : import("../../swarm-posture.ts"));
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
    code = e.code ?? 0;
  } finally {
    process.argv = savedArgv;
    vi.restoreAllMocks();
  }
  return { stdout: out.join(""), stderr: err.join(""), code };
}
