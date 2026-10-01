import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  checkpoint,
  commitAll,
  diffPatch,
  ensureWorktree,
  inspectRepo,
  listsWorktree,
  restorePaths,
} from "../src/git.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await exec("git", args, { cwd })).stdout.trim();

async function repo() {
  const dir = await mkdtemp(path.join(tmpdir(), "git-test-"));
  await mkdir(path.join(dir, "docs"));
  await writeFile(path.join(dir, "docs/a.md"), "A\n");
  await writeFile(path.join(dir, "docs/b.md"), "B\n");
  await writeFile(path.join(dir, "code.ts"), "x\n");
  await git(dir, "init", "-q");
  await git(dir, "add", ".");
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return dir;
}

describe("git helpers", () => {
  it("restores only the given paths to a snapshot: modified, added and deleted files", async () => {
    const dir = await repo();
    const base = await checkpoint(dir, "refs/factory/test/base", "base");
    await writeFile(path.join(dir, "docs/a.md"), "A changed\n");
    await writeFile(path.join(dir, "docs/new.md"), "new\n");
    await rm(path.join(dir, "docs/b.md"));
    await writeFile(path.join(dir, "code.ts"), "y\n");

    const head = await checkpoint(dir, "refs/factory/test/head", "head");
    const { patch } = await diffPatch(dir, base, head, ["docs"]);
    expect(patch).toContain("+A changed");
    expect(patch).toContain("docs/new.md");
    expect(patch).not.toContain("code.ts");

    await restorePaths(dir, base, ["docs"]);
    expect(await readFile(path.join(dir, "docs/a.md"), "utf8")).toBe("A\n");
    expect(await readFile(path.join(dir, "docs/b.md"), "utf8")).toBe("B\n");
    expect(existsSync(path.join(dir, "docs/new.md"))).toBe(false);
    expect(await readFile(path.join(dir, "code.ts"), "utf8")).toBe("y\n"); // untouched
    expect(await git(dir, "status", "--porcelain")).toBe("M code.ts");
  });

  it("commits everything, or nothing when clean", async () => {
    const dir = await repo();
    expect(await commitAll(dir, "nothing")).toBeNull();
    await writeFile(path.join(dir, "code.ts"), "z\n");
    const commit = await commitAll(dir, "WEB-1 Fix: it works");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(dir, "log", "-1", "--format=%an %s")).toBe("The Factory WEB-1 Fix: it works");
  });

  it("inspects a repo: root and branch from a pasted, quoted subfolder path", async () => {
    const dir = await repo();
    await git(dir, "checkout", "-qb", "trunk");
    const found = await inspectRepo(`"${path.join(dir, "docs")}"`);
    expect(found.path).toBe(path.resolve(await git(dir, "rev-parse", "--show-toplevel")));
    expect(found.defaultBranch).toBe("trunk");
  });

  it("explains a wrong repo path instead of 'spawn git ENOENT'", async () => {
    const missing = path.join(tmpdir(), "no-such-repo-xyz");
    await expect(inspectRepo(missing)).rejects.toThrow(`folder not found: ${missing}`);
    await expect(inspectRepo(tmpdir())).rejects.toThrow("not a git repository");
    await expect(ensureWorktree(missing, path.join(missing, "wt"), "b", "main")).rejects.toThrow(
      `folder not found: ${missing}`,
    );
  });

  it("recognizes an existing worktree whatever the slashes or case (Windows)", () => {
    const out =
      "worktree C:/Tools/repo\nHEAD abc\n\nworktree C:/Tools/the-factory/data/worktrees/ef-1\nbranch refs/heads/x\n";
    expect(listsWorktree(out, "C:\\Tools\\the-factory\\data\\worktrees\\ef-1", "win32")).toBe(true);
    expect(listsWorktree(out, "c:\\tools\\THE-FACTORY\\data\\worktrees\\ef-1", "win32")).toBe(true);
    expect(listsWorktree(out, "C:\\Tools\\the-factory\\data\\worktrees\\ef-2", "win32")).toBe(
      false,
    );
    expect(listsWorktree("worktree /srv/wt/ef-1\n", "/srv/wt/ef-1/", "linux")).toBe(true);
  });

  it("reuses a card's worktree on the next step", async () => {
    const dir = await repo();
    const base = await git(dir, "symbolic-ref", "--short", "HEAD");
    const wt = path.join(await mkdtemp(path.join(tmpdir(), "wt-")), "ef-1");
    await ensureWorktree(dir, wt, "factory/ef-1", base);
    await writeFile(path.join(wt, "work.txt"), "keep me\n");
    await ensureWorktree(dir, wt, "factory/ef-1", base);
    expect(await readFile(path.join(wt, "work.txt"), "utf8")).toBe("keep me\n");
  });
});
