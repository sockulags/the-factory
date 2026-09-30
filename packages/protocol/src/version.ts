/**
 * Compares two `major.minor.patch[-prerelease]` versions.
 * Returns a negative number if a < b, 0 if equal, positive if a > b.
 * A prerelease sorts before its release (1.0.0-beta.1 < 1.0.0).
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = "", aPre] = splitPrerelease(a);
  const [bCore = "", bPre] = splitPrerelease(b);
  const aParts = aCore.split(".").map(toNumber);
  const bParts = bCore.split(".").map(toNumber);
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return comparePrerelease(aPre, bPre);
}

export function isVersionSupported(clientVersion: string, minVersion: string): boolean {
  return compareVersions(clientVersion, minVersion) >= 0;
}

function splitPrerelease(version: string): [string, string | undefined] {
  const clean = version.trim().replace(/^v/, "").split("+")[0] ?? "";
  const dash = clean.indexOf("-");
  return dash === -1 ? [clean, undefined] : [clean.slice(0, dash), clean.slice(dash + 1)];
}

function comparePrerelease(a: string, b: string): number {
  const aIds = a.split(".");
  const bIds = b.split(".");
  for (let i = 0; i < Math.max(aIds.length, bIds.length); i++) {
    const x = aIds[i];
    const y = bIds[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function toNumber(part: string): number {
  const n = Number.parseInt(part, 10);
  return Number.isNaN(n) ? 0 : n;
}
