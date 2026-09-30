import { z } from "zod";

const clip = (max: number) => z.string().trim().min(1).max(max);

/** Fixed shape, hard limits: handovers stay short enough to be read, not skimmed. */
export const Handover = z.object({
  goal: clip(400),
  decisions: z.array(z.object({ decision: clip(300), why: clip(300) })).max(7),
  rejected: z.array(z.object({ option: clip(300), why: clip(300) })).max(5),
  filesTouched: z.array(z.object({ path: clip(300), why: clip(200) })).max(40),
  verify: z.array(clip(300)).max(5),
  openQuestions: z.array(clip(300)).max(5),
});
export type Handover = z.infer<typeof Handover>;

export type HandoverContent =
  | { format: "structured"; handover: Handover }
  | { format: "raw"; text: string; error: string };

/** Extracts the last ```json block (or a bare JSON object) and validates it. */
export function parseHandover(
  reply: string,
): { ok: true; handover: Handover } | { ok: false; error: string } {
  const blocks = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const candidate = blocks.at(-1) ?? reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "no valid JSON object found" };
  }
  const result = Handover.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, handover: result.data };
}

export function handoverToMarkdown(content: HandoverContent, title?: string): string {
  const head = title ? `### ${title}\n` : "";
  if (content.format === "raw") return `${head}${content.text.trim()}`;
  const h = content.handover;
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join("\n") : "- none";
  return [
    `${head}**Goal:** ${h.goal}`,
    `**Decisions**\n${list(h.decisions.map((d) => `${d.decision} — ${d.why}`))}`,
    `**Rejected**\n${list(h.rejected.map((r) => `${r.option} — ${r.why}`))}`,
    `**Files touched**\n${list(h.filesTouched.map((f) => `\`${f.path}\` — ${f.why}`))}`,
    `**How to verify**\n${list(h.verify)}`,
    `**Open questions**\n${list(h.openQuestions)}`,
  ].join("\n\n");
}
