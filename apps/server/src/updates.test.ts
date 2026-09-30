import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mirrorLatestRelease } from "./updates.js";

function fakeGithub(releases: unknown[], files: Record<string, string>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/releases?")) return new Response(JSON.stringify(releases));
    const body = files[url];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const asset = (name: string) => ({ name, url: `https://api.github.com/assets/${name}` });

describe("mirrorLatestRelease", () => {
  const releases = [
    {
      tag_name: "v0.3.0-beta.1",
      draft: false,
      prerelease: true,
      assets: [asset("latest.yml"), asset("Factory-Setup-0.3.0-beta.1.exe")],
    },
    { tag_name: "v0.2.1", draft: true, prerelease: false, assets: [asset("latest.yml")] },
    {
      tag_name: "v0.2.0",
      draft: false,
      prerelease: false,
      assets: [
        asset("latest.yml"),
        asset("Factory-Setup-0.2.0.exe"),
        asset("Factory-Setup-0.2.0.exe.blockmap"),
        asset("notes.txt"),
      ],
    },
  ];
  const files = {
    "https://api.github.com/assets/latest.yml": "version: x\n",
    "https://api.github.com/assets/Factory-Setup-0.2.0.exe": "EXE",
    "https://api.github.com/assets/Factory-Setup-0.2.0.exe.blockmap": "MAP",
    "https://api.github.com/assets/Factory-Setup-0.3.0-beta.1.exe": "BETA",
  };

  it("mirrors the newest stable release, skipping drafts, prereleases and unrelated files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mirror-"));
    const { fetchImpl, calls } = fakeGithub(releases, files);
    const result = await mirrorLatestRelease({
      repo: "o/r",
      updatesDir: dir,
      channel: "stable",
      includePrereleases: false,
      fetch: fetchImpl,
    });
    expect(result).toEqual({ status: "updated", tag: "v0.2.0" });
    expect(await readFile(path.join(dir, "stable", "Factory-Setup-0.2.0.exe"), "utf8")).toBe("EXE");
    expect(calls.at(-1)).toContain("latest.yml"); // feed written last
    expect(calls.some((c) => c.includes("notes.txt"))).toBe(false);

    const again = await mirrorLatestRelease({
      repo: "o/r",
      updatesDir: dir,
      channel: "stable",
      includePrereleases: false,
      fetch: fetchImpl,
    });
    expect(again).toEqual({ status: "unchanged", tag: "v0.2.0" });
  });

  it("uses prereleases for the beta channel", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mirror-"));
    const { fetchImpl } = fakeGithub(releases, files);
    const result = await mirrorLatestRelease({
      repo: "o/r",
      updatesDir: dir,
      channel: "beta",
      includePrereleases: true,
      fetch: fetchImpl,
    });
    expect(result).toEqual({ status: "updated", tag: "v0.3.0-beta.1" });
  });
});
