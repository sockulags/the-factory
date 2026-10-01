import type { Board, Card } from "../board.js";

/** PR/MR description: what the card is and what each step concluded, from the handovers. */
export async function pullRequestBody(board: Board, card: Card): Promise<string> {
  const handovers = await board.handovers(card.id);
  const latestByStep = new Map<string, (typeof handovers)[number]>();
  for (const h of handovers) latestByStep.set(h.step, h);
  const lines = [`**${card.key}**: ${card.title}`, ""];
  if (card.body.trim()) lines.push(card.body.trim(), "");
  const summary = [...latestByStep.values()]
    .map((h) =>
      h.content.format === "structured" ? `- **${h.step}**: ${h.content.handover.goal}` : null,
    )
    .filter((l): l is string => l != null);
  if (summary.length) lines.push("### Steps", ...summary, "");
  const verify = [...latestByStep.values()].flatMap((h) =>
    h.content.format === "structured" ? h.content.handover.verify : [],
  );
  if (verify.length)
    lines.push("### How to verify", ...[...new Set(verify)].map((v) => `- ${v}`), "");
  const open = [...latestByStep.values()].flatMap((h) =>
    h.content.format === "structured" ? h.content.handover.openQuestions : [],
  );
  if (open.length) lines.push("### Open questions", ...[...new Set(open)].map((q) => `- ${q}`), "");
  lines.push("_Opened by The Factory._");
  return lines.join("\n");
}
