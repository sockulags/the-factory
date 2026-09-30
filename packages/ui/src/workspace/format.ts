import type { CardDto, CardState, WorkflowDto } from "@factory/protocol";

export const STATE_LABEL: Record<CardState, string> = {
  backlog: "Backlog",
  running: "Running",
  awaiting_gate: "Needs you",
  blocked: "Blocked",
  done: "Done",
  closed: "Closed",
};

export function stepName(workflows: WorkflowDto[], card: CardDto): string {
  if (!card.step) return "Backlog";
  const wf = workflows.find((w) => w.type === card.type);
  return wf?.steps.find((s) => s.id === card.step)?.name ?? card.step;
}

export function timeAgo(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function actorName(
  actor: string,
  names: Record<string, string>,
  agentNames: Record<string, string>,
): string {
  if (names[actor]) return names[actor];
  if (actor === "workflow") return "Workflow";
  if (actor.startsWith("agent:")) return agentNames[actor.slice(6)] ?? actor.slice(6);
  if (actor.startsWith("user:")) return "Someone";
  return actor;
}
