import { spawn } from "node:child_process";

export interface ExecResult {
  command: string;
  exitCode: number;
  /** Combined stdout+stderr, tail-truncated. */
  output: string;
  durationMs: number;
}

const MAX_OUTPUT = 20_000;

/** Runs a shell command in `cwd` (used by the `checks` gate). */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 15 * 60_000,
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, CI: "1" },
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      output += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      const tail = output.length > MAX_OUTPUT ? `…\n${output.slice(-MAX_OUTPUT)}` : output;
      resolve({ command, exitCode, output: tail.trim(), durationMs: Date.now() - started });
    };
    child.on("error", (err) => {
      output += err.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}
