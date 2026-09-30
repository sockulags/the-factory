// Bundles main + preload (everything, incl. electron-updater, so the packaged app
// needs no node_modules) and copies the built UI into dist/renderer.
import { cp, rm } from "node:fs/promises";
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
};

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main.cjs" });
await build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs" });
await cp(
  new URL("../../packages/ui/dist", import.meta.url),
  new URL("./dist/renderer", import.meta.url),
  {
    recursive: true,
  },
);
console.log("desktop built → dist/");
