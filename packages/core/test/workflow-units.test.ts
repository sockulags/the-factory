import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../src/workflow/definition.js";
import { handoverToMarkdown, parseHandover } from "../src/workflow/handover.js";
import { renderTemplate } from "../src/workflow/template.js";

describe("renderTemplate", () => {
  it("fills values, drops missing ones and conditional blocks", () => {
    const out = renderTemplate(
      "A {{card.title}} B {{missing.x}}\n{{#if repo.checks}}run {{repo.checks}}{{/if}}\n\n\n\nend",
      {
        card: { title: "T" },
        repo: { checks: "" },
      },
    );
    expect(out).toBe("A T B \n\nend");
  });
});

describe("parseHandover", () => {
  const valid = {
    goal: "Fix it",
    decisions: [{ decision: "d", why: "w" }],
    rejected: [],
    filesTouched: [{ path: "a.ts", why: "x" }],
    verify: ["run tests"],
    openQuestions: [],
  };
  it("takes the last json block", () => {
    const reply = `draft:\n\`\`\`json\n{"goal": "old"}\n\`\`\`\nfinal:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
    const parsed = parseHandover(reply);
    expect(parsed.ok && parsed.handover.goal).toBe("Fix it");
  });
  it("reports what is wrong", () => {
    const parsed = parseHandover(
      `\`\`\`json\n${JSON.stringify({ ...valid, verify: ["1", "2", "3", "4", "5", "6"] })}\n\`\`\``,
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toContain("verify");
    expect(parseHandover("no json here").ok).toBe(false);
  });
  it("renders markdown", () => {
    const parsed = parseHandover(JSON.stringify(valid));
    if (!parsed.ok) throw new Error("expected valid");
    const md = handoverToMarkdown(
      { format: "structured", handover: parsed.handover },
      "Handover from fix",
    );
    expect(md).toContain("### Handover from fix");
    expect(md).toContain("`a.ts` — x");
    expect(md).toContain("**Rejected**\n- none");
  });
});

describe("parseWorkflow", () => {
  const shared = { handover: "h", consult: "c", revise: "r" };
  it("rejects unknown transition targets and agents", async () => {
    const yaml =
      "type: x\nsteps:\n  a:\n    agent: claude\n    prompt: p.md\n    on:\n      approved: nowhere\n";
    await expect(parseWorkflow(yaml, "/nonexistent", shared)).rejects.toThrow();
  });
});
