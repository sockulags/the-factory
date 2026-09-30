import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).then(
    (out) => out === "true",
    () => false,
  );
}

/**
 * Snapshots the whole worktree (tracked + untracked, respecting .gitignore) as a commit
 * under `ref`, without touching HEAD, the branch or the real index. Returns the commit id.
 */
export async function checkpoint(cwd: string, ref: string, message: string): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "factory-index-"));
  const env = {
    GIT_INDEX_FILE: path.join(tmp, "index"),
    GIT_AUTHOR_NAME: "The Factory",
    GIT_AUTHOR_EMAIL: "factory@localhost",
    GIT_COMMITTER_NAME: "The Factory",
    GIT_COMMITTER_EMAIL: "factory@localhost",
  };
  try {
    const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
    if (head) await git(cwd, ["read-tree", head], env);
    await git(cwd, ["add", "-A", "."], env);
    const tree = await git(cwd, ["write-tree"], env);
    const parents = head ? ["-p", head] : [];
    const commit = await git(cwd, ["commit-tree", tree, ...parents, "-m", message], env);
    await git(cwd, ["update-ref", ref, commit]);
    return commit;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface DiffSummary {
  files: { path: string; added: number; removed: number }[];
  /** `git diff --stat` style text for humans/agents. */
  stat: string;
}

/** What changed between two snapshots (commit ids or refs). */
export async function diffSummary(cwd: string, from: string, to: string): Promise<DiffSummary> {
  const numstat = await git(cwd, ["diff", "--numstat", from, to]);
  const files = numstat
    ? numstat.split("\n").map((line) => {
        const [added = "0", removed = "0", ...rest] = line.split("\t");
        return { path: rest.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
      })
    : [];
  const stat = files.length ? await git(cwd, ["diff", "--stat=100", from, to]) : "";
  return { files, stat };
}

/** Deletes every ref under a prefix, e.g. when a card's worktree is removed. */
export async function deleteRefs(cwd: string, prefix: string): Promise<void> {
  const refs = await git(cwd, ["for-each-ref", "--format=%(refname)", prefix]);
  for (const ref of refs.split("\n").filter(Boolean)) await git(cwd, ["update-ref", "-d", ref]);
}
