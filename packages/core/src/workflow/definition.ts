import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const StepId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "step ids are lowercase words, e.g. fix or code-review");

const Step = z.object({
  name: z.string().optional(),
  /** Agent that drives the step. */
  agent: z.string(),
  /** `read-only` is accepted as an alias of `consult`. */
  mode: z
    .enum(["write", "consult", "read-only"])
    .default("write")
    .transform((m) => (m === "read-only" ? "consult" : m)),
  /** Markdown prompt template, relative to the workflow file. */
  prompt: z.string(),
  /** Agents asked for critique (read-only) after the driver's first answer. */
  consult: z.array(z.string()).default([]),
  gate: z.enum(["auto", "human", "checks"]).default("human"),
  /** How many times a failing `checks` gate sends the output back before blocking. */
  maxCheckAttempts: z.number().int().min(1).max(10).default(3),
  /** Where a decision leads. Default: approved → next step, changes_requested → this step. */
  on: z.partialRecord(z.enum(["approved", "changes_requested"]), z.string()).default({}),
  hooks: z
    .object({ enter: z.array(z.string()).default([]), exit: z.array(z.string()).default([]) })
    .default({ enter: [], exit: [] }),
  outputs: z.array(z.string()).default(["handover"]),
});

const WorkflowFile = z.object({
  type: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().optional(),
  description: z.string().optional(),
  steps: z.record(StepId, Step),
});

export type StepDefinition = z.infer<typeof Step> & {
  id: string;
  name: string;
  promptTemplate: string;
};

export interface WorkflowDefinition {
  type: string;
  name: string;
  description: string;
  /** In order. */
  steps: StepDefinition[];
  /** Shared templates (handover instructions, consult prompt, …). */
  shared: { handover: string; consult: string; revise: string };
}

export const DONE = "done";

export function stepById(wf: WorkflowDefinition, id: string): StepDefinition {
  const step = wf.steps.find((s) => s.id === id);
  if (!step) throw new Error(`workflow "${wf.type}" has no step "${id}"`);
  return step;
}

export function nextStepId(wf: WorkflowDefinition, id: string): string {
  const index = wf.steps.findIndex((s) => s.id === id);
  return wf.steps[index + 1]?.id ?? DONE;
}

const DEFAULT_SHARED = {
  consult:
    "Review the proposal above from {{driver}}. Point out problems, risks and better alternatives. Be concrete and brief. Do not repeat what is already fine.",
  revise:
    "Consider the feedback above. Revise your proposal where it is right, push back where it isn't, and state the final version.",
};

/**
 * Loads every `<dir>/<type>/workflow.yaml`. Shared templates come from `<dir>/_shared/`.
 * Validates step references (transitions, agents known to the caller).
 */
export async function loadWorkflows(
  dir: string,
  knownAgents?: string[],
): Promise<Map<string, WorkflowDefinition>> {
  const shared = {
    handover: await readFile(path.join(dir, "_shared", "handover.md"), "utf8"),
    consult: await readFile(path.join(dir, "_shared", "consult.md"), "utf8").catch(
      () => DEFAULT_SHARED.consult,
    ),
    revise: await readFile(path.join(dir, "_shared", "revise.md"), "utf8").catch(
      () => DEFAULT_SHARED.revise,
    ),
  };
  const workflows = new Map<string, WorkflowDefinition>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const file = path.join(dir, entry.name, "workflow.yaml");
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw == null) continue;
    const wf = await parseWorkflow(raw, path.dirname(file), shared, knownAgents).catch(
      (err: Error) => {
        throw new Error(`${file}: ${err.message}`);
      },
    );
    workflows.set(wf.type, wf);
  }
  return workflows;
}

export async function parseWorkflow(
  raw: string,
  baseDir: string,
  shared: WorkflowDefinition["shared"],
  knownAgents?: string[],
): Promise<WorkflowDefinition> {
  const result = WorkflowFile.safeParse(parse(raw));
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const file = result.data;
  const steps: StepDefinition[] = [];
  for (const [id, step] of Object.entries(file.steps)) {
    const promptTemplate = await readFile(path.resolve(baseDir, step.prompt), "utf8");
    steps.push({ ...step, id, name: step.name ?? titleCase(id), promptTemplate });
  }
  if (!steps.length) throw new Error("a workflow needs at least one step");
  const ids = new Set([...steps.map((s) => s.id), DONE]);
  for (const step of steps) {
    for (const [decision, target] of Object.entries(step.on)) {
      if (!ids.has(target))
        throw new Error(`steps.${step.id}.on.${decision}: unknown step "${target}"`);
    }
    if (knownAgents) {
      for (const agent of [step.agent, ...step.consult]) {
        if (!knownAgents.includes(agent))
          throw new Error(`steps.${step.id}: unknown agent "${agent}"`);
      }
    }
  }
  return {
    type: file.type,
    name: file.name ?? titleCase(file.type),
    description: file.description ?? "",
    steps,
    shared,
  };
}

function titleCase(id: string): string {
  return id.replace(
    /(^|-)(\w)/g,
    (_, sep: string, c: string) => `${sep ? " " : ""}${c.toUpperCase()}`,
  );
}
