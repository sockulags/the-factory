import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const FEED_FILE = /\.(yml|exe|blockmap)$/i;

const CONTENT_TYPES: Record<string, string> = {
  ".yml": "text/yaml; charset=utf-8",
  ".exe": "application/octet-stream",
  ".blockmap": "application/octet-stream",
};

export async function serveUpdateFile(
  updatesDir: string,
  channels: string[],
  channel: string,
  file: string,
): Promise<Response> {
  if (!channels.includes(channel) || !SAFE_FILE.test(file) || !FEED_FILE.test(file)) {
    return new Response("not found", { status: 404 });
  }
  const filePath = path.join(updatesDir, channel, file);
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return new Response("not found", { status: 404 });
    size = info.size;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const ext = path.extname(file).toLowerCase();
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(body, {
    headers: {
      "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "content-length": String(size),
      // latest.yml must never be cached, installers are immutable per version.
      "cache-control": ext === ".yml" ? "no-cache" : "public, max-age=31536000, immutable",
    },
  });
}

interface GithubAsset {
  name: string;
  url: string;
}
interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
}

export interface MirrorOptions {
  /** owner/repo */
  repo: string;
  token?: string;
  updatesDir: string;
  channel: string;
  /** Whether prereleases count as the latest release for this channel. */
  includePrereleases: boolean;
  fetch?: typeof fetch;
}

export type MirrorResult =
  | { status: "updated"; tag: string }
  | { status: "unchanged"; tag: string }
  | { status: "none" };

/**
 * Copies the newest matching GitHub Release (installer, blockmap, latest.yml) into
 * <updatesDir>/<channel>. The server sits behind the VPN, so clients can't reach GitHub
 * with credentials; the server pulls releases outbound instead.
 */
export async function mirrorLatestRelease(options: MirrorOptions): Promise<MirrorResult> {
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "the-factory-update-mirror",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const res = await doFetch(`https://api.github.com/repos/${options.repo}/releases?per_page=20`, {
    headers,
  });
  if (!res.ok) throw new Error(`GitHub releases request failed: HTTP ${res.status}`);
  const releases = (await res.json()) as GithubRelease[];
  const release = releases.find(
    (r) =>
      !r.draft &&
      (options.includePrereleases || !r.prerelease) &&
      r.assets.some((a) => a.name === "latest.yml"),
  );
  if (!release) return { status: "none" };

  const channelDir = path.join(options.updatesDir, options.channel);
  const marker = path.join(channelDir, ".release");
  const current = await readFile(marker, "utf8").catch(() => "");
  if (current.trim() === release.tag_name) return { status: "unchanged", tag: release.tag_name };

  await mkdir(channelDir, { recursive: true });
  const assets = release.assets.filter((a) => FEED_FILE.test(a.name) && SAFE_FILE.test(a.name));
  // Installers first, latest.yml last: clients must never see a feed pointing at a missing file.
  assets.sort((a, b) => Number(a.name === "latest.yml") - Number(b.name === "latest.yml"));
  for (const asset of assets) {
    const download = await doFetch(asset.url, {
      headers: { ...headers, accept: "application/octet-stream" },
    });
    if (!download.ok) throw new Error(`Downloading ${asset.name} failed: HTTP ${download.status}`);
    const tmp = path.join(channelDir, `.${asset.name}.tmp`);
    await writeFile(tmp, Buffer.from(await download.arrayBuffer()));
    await rename(tmp, path.join(channelDir, asset.name));
  }
  await writeFile(marker, release.tag_name);
  return { status: "updated", tag: release.tag_name };
}
