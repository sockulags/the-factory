import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface DocFile {
  /** Relative to the worktree, with forward slashes. */
  path: string;
  title: string;
  content: string;
}

const MAX_FILES = 300;
const MAX_FILE_BYTES = 100_000;

/** Reads the Markdown docs under `<cwd>/<dir>` (recursively, bounded). */
export async function readDocs(cwd: string, dir = "docs"): Promise<DocFile[]> {
  const root = path.join(cwd, dir);
  const out: DocFile[] = [];
  const walk = async (current: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) await walk(full);
      else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
        if ((await stat(full)).size > MAX_FILE_BYTES) continue;
        const content = await readFile(full, "utf8");
        const rel = path.relative(cwd, full).split(path.sep).join("/");
        const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? rel;
        out.push({ path: rel, title, content });
      }
    }
  };
  await walk(root);
  return out;
}
