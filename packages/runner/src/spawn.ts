import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Quotes one argument for cmd.exe. Arguments with spaces or quotes are wrapped in
 * double quotes, with embedded quotes doubled.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Spawns an agent process. On Windows, bare commands like `npx` are .cmd shims that
 * need a shell; we pass one pre-quoted command line instead of an args array, since
 * Node deprecates shell + args (DEP0190). Absolute paths are spawned directly.
 */
export function spawnAgent(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const options = { stdio: ["pipe", "pipe", "pipe"] as "pipe"[], env, windowsHide: true };
  if (process.platform === "win32" && !path.isAbsolute(command)) {
    const line = [command, ...args].map(quoteWindowsArg).join(" ");
    return spawn(line, { ...options, shell: true });
  }
  return spawn(command, args, options);
}

/**
 * Stops a process and everything it started. On Windows, killing the shell leaves its
 * children (npx → node) running and holding files open, so kill the whole tree.
 */
export function killTree(child: ChildProcess, force = false): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
      windowsHide: true,
    });
    if (!force) child.kill();
  } else {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}
