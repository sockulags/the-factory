import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    // Node reports a missing working directory as "spawn git ENOENT" too; say which it is.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        (await isDir(cwd))
          ? "git was not found: install Git and make sure it is on PATH"
          : `folder not found: ${cwd}`,
      );
    }
    throw err;
  }
}

/**
 * Checks that `input` is a git repository and returns its root and default branch
 * (origin's HEAD if known, else the checked-out branch). Tolerates pasted quotes.
 */
export async function inspectRepo(input: string): Promise<{ path: string; defaultBranch: string }> {
  const dir = path.resolve(input.trim().replace(/^(["'])(.*)\1$/, "$2"));
  if (!(await isDir(dir))) throw new Error(`folder not found: ${dir}`);
  if (!(await isGitRepo(dir))) throw new Error(`not a git repository: ${dir}`);
  const root = path.resolve(await git(dir, ["rev-parse", "--show-toplevel"]));
  const originHead = await git(root, [
    "symbolic-ref",
    "-q",
    "--short",
    "refs/remotes/origin/HEAD",
  ]).catch(() => "");
  const current = await git(root, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "");
  const defaultBranch = originHead.replace(/^origin\//, "") || current || "main";
  return { path: root, defaultBranch };
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

/**
 * Whether `git worktree list --porcelain` output includes `worktreePath`. On Windows git
 * prints C:/x/y while Node uses C:\\x\\y, and paths are case-insensitive.
 */
export function listsWorktree(
  porcelain: string,
  worktreePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const win = platform === "win32";
  const norm = (p: string) => {
    const resolved = (win ? path.win32 : path.posix).resolve(p);
    return win ? resolved.toLowerCase() : resolved;
  };
  const target = norm(worktreePath);
  return porcelain
    .split(/\r?\n/)
    .some((l) => l.startsWith("worktree ") && norm(l.slice("worktree ".length)) === target);
}

/**
 * Creates (or reuses) a worktree at `worktreePath` on `branch`, branching from `base`.
 * Idempotent: if the worktree already exists it is left as is.
 */
export async function ensureWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  base: string,
): Promise<void> {
  const existing = await git(repoPath, ["worktree", "list", "--porcelain"]);
  if (listsWorktree(existing, worktreePath)) return;
  // Forget worktrees whose folder was deleted by hand, so their path can be reused.
  await git(repoPath, ["worktree", "prune"]);
  const branchExists = await git(repoPath, [
    "rev-parse",
    "--verify",
    "-q",
    `refs/heads/${branch}`,
  ]).then(
    () => true,
    () => false,
  );
  const args = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, base];
  await git(repoPath, args);
}

/** Removes a card's worktree (including uncommitted changes) and prunes its metadata. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
  await git(repoPath, ["worktree", "prune"]);
}

const FACTORY_IDENTITY = {
  GIT_AUTHOR_NAME: "The Factory",
  GIT_AUTHOR_EMAIL: "factory@localhost",
  GIT_COMMITTER_NAME: "The Factory",
  GIT_COMMITTER_EMAIL: "factory@localhost",
};

/** Stages everything and commits on the current branch. Returns the commit id, or null if nothing changed. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await git(cwd, ["add", "-A", "."]);
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (!staged) return null;
  await git(cwd, ["commit", "-q", "-m", message], FACTORY_IDENTITY);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Unified diff between two snapshots, optionally limited to paths. Truncated at `maxBytes`. */
export async function diffPatch(
  cwd: string,
  from: string,
  to: string,
  paths: string[] = [],
  maxBytes = 200_000,
): Promise<{ patch: string; truncated: boolean }> {
  const patch = await git(cwd, ["diff", "--no-color", from, to, "--", ...paths]);
  return patch.length > maxBytes
    ? { patch: `${patch.slice(0, maxBytes)}\n… [diff truncated]`, truncated: true }
    : { patch, truncated: false };
}

/**
 * Puts `paths` in the worktree back to how they were in `source` (a snapshot):
 * modified files are restored, files added since are removed.
 */
export async function restorePaths(cwd: string, source: string, paths: string[]): Promise<void> {
  const current = await checkpoint(cwd, "refs/factory/tmp/restore", "restore point");
  const changes = await git(cwd, [
    "diff",
    "--name-status",
    "--no-renames",
    source,
    current,
    "--",
    ...paths,
  ]);
  for (const line of changes.split("\n").filter(Boolean)) {
    const [status, file = ""] = line.split("\t");
    if (status === "A") await rm(path.join(cwd, file), { force: true });
    else await git(cwd, ["checkout", source, "--", file]);
  }
  await git(cwd, ["update-ref", "-d", "refs/factory/tmp/restore"]);
  // `git checkout <commit> -- file` also stages it; unstage to leave the index as it was.
  await git(cwd, ["reset", "-q", "--", ...paths]).catch(() => undefined);
}

export interface PushAuth {
  username: string;
  password: string;
}

/**
 * Pushes `branch` to `remote` (a URL or path). Credentials go in an HTTP header for this
 * one command only, so tokens never land in the repo's config or remote URLs.
 */
export async function pushBranch(
  cwd: string,
  remote: string,
  branch: string,
  auth?: PushAuth,
): Promise<void> {
  const extra = auth
    ? [
        "-c",
        `http.extraHeader=Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
      ]
    : [];
  await git(cwd, [
    ...extra,
    "push",
    "--porcelain",
    remote,
    `refs/heads/${branch}:refs/heads/${branch}`,
  ]);
}

export async function remoteUrl(cwd: string, name = "origin"): Promise<string | null> {
  return git(cwd, ["remote", "get-url", name]).catch(() => null);
}
