// Usage: node scripts/set-version.mjs v1.2.3[-beta.1]
// Stamps the release version into the app and server package.json files (CI, on tag).
import { readFile, writeFile } from "node:fs/promises";

const raw = process.argv[2] ?? "";
const version = raw.replace(/^refs\/tags\//, "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a valid version: "${raw}"`);
  process.exit(1);
}
for (const file of ["apps/desktop/package.json", "apps/server/package.json"]) {
  const pkg = JSON.parse(await readFile(file, "utf8"));
  pkg.version = version;
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${file} → ${version}`);
}
