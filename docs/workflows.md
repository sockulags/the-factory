# Workflows

Each card has a type (`bug`, `feature`, …). The type's workflow decides which steps the
card goes through, which agent runs each step, the prompt it gets, and what has to
happen before the card moves on. Workflows are files in `workflows/`, reviewed like code.

```
workflows/
  _shared/handover.md    how every step ends (structured handover)
  _shared/consult.md     prompt for agents asked to critique ({{driver}})
  _shared/revise.md      prompt for the driver after critique
  _shared/docs.md        the docs step
  bug/workflow.yaml      steps of the "bug" type
  bug/prompts/*.md       one prompt per step
  feature/…
```

## workflow.yaml

```yaml
type: bug                 # card type (lowercase)
name: Bug
description: …
steps:                    # in order; a step advances to the next one when approved
  fix:
    agent: claude         # drives the step
    mode: write           # write | consult (read-only; alias: read-only)
    prompt: prompts/fix.md
    consult: [codex]      # optional: critique by other agents, then the driver revises
    gate: checks          # auto | human | checks
    maxCheckAttempts: 3   # checks gate: failures go back into the thread this many times
    on:                   # optional overrides of where a decision leads
      approved: review    # default: next step (or done after the last)
      changes_requested: fix   # default: this step
    hooks:
      enter: []
      exit: [vcs.open_pr] # named actions provided by plugins
    outputs: [doc_proposal]   # docs step: its docs/ changes become a reviewable proposal
```

## What happens in a step

1. The card's worktree is created on first need (`factory/<key>-<title>` branch from the
   repo's default branch). All steps of a card share it.
2. **First entry:** a new thread is created and the rendered step prompt is sent to the
   step's agent. **Re-entry** (for example review → fix on "changes requested", or failed
   checks) *continues the same thread* with the new input, so the agent keeps its
   context.
3. If `consult` is set, each consulted agent critiques in the same thread (read-only),
   then the driver revises.
4. The driver writes the **handover**: JSON with a fixed shape and hard limits (goal,
   decisions, rejected, files touched, verify, open questions). It's validated, and the
   agent gets one retry to fix it. The next step's prompt starts from it
   (`{{handover.previous}}`). An agent that has to start a fresh session gets it as its
   recap.
5. The **gate** decides:
   - `auto`: approved immediately.
   - `human`: the card waits in *awaiting gate* until someone approves or requests changes
     (with a comment, which goes into the thread).
   - `checks`: the repo's check commands run in the worktree. On failure the output goes
     back into the step's thread (up to `maxCheckAttempts`), then the card is *blocked*.

6. When a step is **approved**, whatever a `write` step changed is committed on the card
   branch (`WEB-12 Fix: <handover goal>`), so the branch reads step by step.

### Documentation steps

A step with `outputs: [doc_proposal]` edits the product docs (`docs/` in the repo). When
it ends, the engine takes the diff of `docs/` since the step began and saves it as a
**doc proposal**. Changes outside `docs/` are flagged. At the gate, a person reads the
diff (*Doc changes* tab) and:

- **Approve & commit docs**: the changes are committed with the step.
- **Request changes**: the comment goes back into the docs thread. The next proposal
  still covers everything since the step began.
- **Discard doc changes**: `docs/` is restored to how it was before the step, and the
  card continues.

A card that errors is *blocked* with the reason. A person can retry the step, decide, or
move the card manually.

## Prompt templates

Markdown with `{{…}}` placeholders and `{{#if x}}…{{/if}}` blocks:

| Placeholder | Value |
|---|---|
| `card.key`, `card.title`, `card.body`, `card.type` | the card |
| `step.id`, `step.name` | the current step |
| `repo.name`, `repo.branch`, `repo.base`, `repo.checks` | the card's repo, work branch, base branch, check commands |
| `handover.previous` | the latest handover from another step, as markdown |
| `input` | the re-entry input, if any |
| `docs.dir` | the docs directory (`docs`) |
| `docs.index` | one line per doc page: path and title |
| `docs.relevant` | the doc pages most related to the card (by title/body/previous goal), within a size budget |

Keep prompts specific to the step's job. The thread already carries the conversation, so
prompts don't need to repeat it.
