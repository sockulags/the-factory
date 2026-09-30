// Bundles the runner service (and the runner package's TypeScript) into dist/.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const external = new Set();
for (const file of ["../../packages/runner/package.json", "./package.json"]) {
  const pkg = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {}))
    if (!dep.startsWith("@factory/")) external.add(dep);
}
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: [...external],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
console.log("runner built → dist/");
