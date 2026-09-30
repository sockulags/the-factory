import type { DocFile } from "@factory/runner";

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its not of on or so that the their then there these this to was we what when where which who why will with you your".split(
    " ",
  ),
);

function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** One line per page: where things are documented. */
export function docsIndex(docs: DocFile[]): string {
  return docs.map((d) => `- \`${d.path}\` — ${d.title}`).join("\n");
}

/**
 * Picks the doc pages most related to `query` (card title/body, previous handover) and
 * returns them as markdown within `budget` characters. Scores by term overlap, weighting
 * titles and paths; no embeddings needed at this scale.
 */
export function relevantDocs(docs: DocFile[], query: string, budget = 8000, maxPages = 3): string {
  const wanted = new Set(terms(query));
  if (!wanted.size) return "";
  const scored = docs
    .map((doc) => {
      const head = new Set(terms(`${doc.title} ${doc.path}`));
      const body = terms(doc.content);
      let score = 0;
      for (const t of wanted) if (head.has(t)) score += 5;
      const counts = new Map<string, number>();
      for (const t of body) if (wanted.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const n of counts.values()) score += Math.min(n, 5);
      return { doc, score };
    })
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages);

  const parts: string[] = [];
  let used = 0;
  for (const { doc } of scored) {
    const room = budget - used;
    if (room < 400) break;
    const content =
      doc.content.length > room ? `${doc.content.slice(0, room)}\n… [truncated]` : doc.content;
    parts.push(`#### \`${doc.path}\`\n${content.trim()}`);
    used += content.length;
  }
  return parts.join("\n\n");
}
