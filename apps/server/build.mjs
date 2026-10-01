// Bundles the server and its workspace packages (TypeScript sources) into dist/.
// Third-party dependencies stay external and are installed next to the bundle.
import { cp, readFile } from "node:fs/promises";
import { build } from "esbuild";

const workspacePackages = [
  "../../packages/db/package.json",
  "../../packages/protocol/package.json",
  "../../packages/core/package.json",
  "../../packages/runner/package.json",
  "./package.json",
];
const external = new Set();
for (const file of workspacePackages) {
  const pkg = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!dep.startsWith("@factory/")) external.add(dep);
  }
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
await cp(
  new URL("../../packages/db/drizzle", import.meta.url),
  new URL("./dist/drizzle", import.meta.url),
  {
    recursive: true,
  },
);
console.log("server built → dist/");
