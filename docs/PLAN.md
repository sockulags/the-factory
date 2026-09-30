# The Factory — Plan

Status: draft, living document. Last updated 2026-09-30.

## 1. What we're building

A board-first workspace where product/dev teams run AI agents against their
codebases. The unit of work is a **card** on a backlog/kanban board, not a chat.
Each card follows a **workflow** determined by its issue type. Each workflow
step runs through one or more **threads** — chats with agents from different
providers (Claude, Codex, Gemini, …) connected via the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP), so the team's
existing subscriptions are used instead of API keys.

Work produces two kinds of output:

- **Card journal** — ephemeral, structured handovers between steps/agents.
- **Product docs** — durable documentation of the product, updated only
  through agent-proposed diffs that a human approves.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| Users | A team from day one; multiple products/repos per factory. |
| Runtime | One server that the team shares, running locally at first and on Kubernetes later. Same shape in both places. Agent execution lives in a separate **runner** so we can move it to each developer's machine if a shared subscription isn't allowed (§3.6). |
| Subscriptions | Enterprise licenses; shared account per provider when hosted. |
| Language | TypeScript end to end. |
| DB | Postgres dialect everywhere. Locally embedded (PGlite) so nothing to install; real Postgres in k8s. Same schema and migrations. |
| Gates | Defined per step by the workflow. |
| Threads | **One thread per workflow step.** Going back to a step (e.g. review → implement) continues that step's thread with the new input. Extra ad-hoc threads are allowed. A thread is the unit of cost measurement. |
| Model switching | Within a thread you can switch provider per message. Each provider keeps its own native session for that thread and only receives what's new since it last spoke. |
| Worktree | **One worktree per card**, shared by all its steps. Only one step is active at a time, so there's one writer per card. Other agents can be consulted read-only. Deleted when the card is closed. |
| Delivery | Finishing a card opens a PR (through the relevant integration plugin). |
| Integrations | Jira, GitLab, GitHub, Confluence, … are **plugins**, wired in through workflows and instructions, not built into the core. |
| Docs changes | Agent proposes, human approves. Doc location TBD. |

## 3. Architecture

```
┌──────────────────────── Web UI (React) ────────────────────────┐
│  Backlog · Board · Card view (threads, handovers, gates) ·      │
│  Doc-change review · Workflow viewer                            │
└───────────────▲──────────────────────────────┬──────────────────┘
                │ SSE / WebSocket (live events) │ HTTP
┌───────────────┴──────────────────────────────▼──────────────────┐
│ Server                                                           │
│  ├─ Board service        cards, types, columns, products, users  │
│  ├─ Workflow engine      per-type state machine (YAML), gates    │
│  ├─ Thread service       canonical event log, turn orchestration │
│  │   └─ Session sync     per-(thread, agent) cursor + delta      │
│  ├─ Context builder      step prompt + handovers + doc sections  │
│  ├─ Docs steward         doc-change proposals, review queue      │
│  └─ Usage meter          per-thread / per-card / per-provider    │
│                                                                  │
│  ├─ Plugin host          integrations (tracker, VCS, docs)        │
│  DB  PGlite (local) → Postgres (k8s)                             │
└───────────────▲──────────────────────────────────────────────────┘
                │ runner protocol (events up, commands down)
┌───────────────┴──────────────────────────────────────────────────┐
│ Runner (in-process locally; separate pod or dev machine later)   │
│  ACP host   spawns & supervises agent processes, answers         │
│             fs/terminal/permission requests, enforces modes      │
│  Workspaces git worktree per card, turn checkpoints as hidden refs│
└──────────────────────────────────────────────────────────────────┘
```

### 3.1 The thread model (the core of the system)

We own the canonical log. Providers own their own sessions. We keep them in
sync with cursors.

- `thread_events` is an append-only log: user messages, agent messages, tool
  calls, permission decisions, turn checkpoints, handovers.
- `agent_sessions` maps `(thread, agent)` → the provider's ACP `sessionId`
  plus a **cursor**: the last thread event that agent has seen.
- When a message is addressed to agent X:
  1. Collect events after X's cursor.
  2. Render a **delta preamble**: new user messages, what other agents said
     (their final messages, not the full tool traces), and which files changed
     since X's last turn (diffstat + the checkpoint ref so X can run
     `git diff` itself).
  3. `session/prompt` X's existing session with preamble + new message.
  4. Stream `session/update` into the log; advance X's cursor.
- **Turn checkpoints:** after every turn we snapshot the worktree to a hidden
  ref (`refs/factory/<card>/<thread>/<turn>`) without touching the branch.
  That makes "what changed since you last spoke" exact and gives cheap undo.
- **Session loss** (process restarted, agent lacks `loadSession`, context
  full): start a new session and rehydrate it from the latest handover plus the
  recent tail of the log. The handover schema is also the recovery format,
  so handovers are useful in their own right and not just ceremony.

### 3.2 Writer vs consultant

The worktree is shared, so only one agent may write at a time.

- Each thread has one **driver** at a time (the agent currently addressed in
  "write" mode). The ACP host enforces it: writes and terminal commands from
  anyone else get denied.
- **Consult**: "@codex what do you think of this approach?" runs a turn in
  read-only permission mode. The consultant sees the same files and diffs, but
  can only answer.
- Only one step per card is active at a time, so only one thread per card
  holds the driver role. Ad-hoc threads on a card are read-only while a
  step is running.

### 3.3 Workflows

Declared in YAML with Markdown prompt templates and versioned in git (see
`workflows/`). A step declares:

- `agent`: default driver (overridable per card).
- `prompt`: template rendered with card, previous handovers and doc sections.
- `mode`: `write` | `read-only`.
- `consult`: optional agents to pull in automatically (e.g. a review from
  another provider).
- `gate`: `auto` | `human` | `checks` (tests/lint must pass).
- `outputs`: what the step must produce — usually a handover, and in the
  docs step, a doc-change proposal.

- `on`: transitions, e.g. `approved: docs`, `changes_requested: implement`.
- `hooks`: plugin actions to run on enter/exit (e.g. `github.open_pr`,
  `jira.transition`).

Moving a card to a column = entering a step. **Each step owns one thread.**
Entering a step for the first time creates its thread and seeds it with the
step prompt and the previous step's handover. Re-entering a step (e.g.
`review → implement` on `changes_requested`) *continues* the existing thread
and posts the new input: "Review findings: …" plus the reviewer's handover.
The agent picks up with its full context still in place.

**Compaction on step exit.** When leaving a step, its handover is written.
That is the compacted form of the thread. Later, if a thread gets expensive
we can reseed it from its handover instead of continuing the raw session
(automatic, based on token count or number of re-entries).

**Card lifecycle.** Card created → worktree + branch created on first step
that needs code. Card done → delivery hook opens a PR. Card closed → worktree
removed, checkpoint refs pruned. The branch/PR stays in the VCS.

### 3.4 Handovers and docs without slop

- **Handover** — fixed schema, hard length limits, produced at the end of
  every step:
  `goal · decisions (with why) · rejected alternatives · files touched ·
  how to verify · open questions`.
  Stored in the card journal. The next step gets the latest handover(s),
  not transcripts.
- **Product docs** are organized by feature/area, not by date. They change only
  in a workflow's docs step, which must output a *diff* (deleting and rewriting
  are first-class, not just appending). The diff goes into a review queue;
  a human approves, edits or rejects it.
- **Context builder** selects doc sections relevant to the card (by
  paths/areas touched and by explicit links) instead of dumping everything.
- Guardrails for the docs step: a style guide in its prompt, a length budget
  per section, a "what would a new teammate need?" rubric, and a rule that
  anything not true of the current code gets removed.

### 3.5 Plugins (integrations)

The core knows nothing about Jira, GitHub, GitLab or Confluence. A plugin
contributes some of the following:

- **Agent tools**, usually as an MCP server passed to agents on
  `session/new`, so agents can read tickets, comment, fetch Confluence
  pages, etc.
- **Workflow hooks**: named actions workflows call (`github.open_pr`,
  `gitlab.open_mr`, `jira.sync_status`, `confluence.publish`).
- **Importers/links**: attach external references to a card (a Jira key, a
  PR URL) and optionally pull/push card fields.
- **Instructions**: prompt snippets workflows can include ("when referencing
  tickets, use the Jira key").

Enabled and configured per product. Credentials live in the server's
secret store, never in workflow files.

### 3.6 Deployment modes and the runner split

The **server** (board, workflows, logs, plugins, DB) and the **runner**
(ACP agents + worktrees) are separated from day one. Locally they run in the
same process.

- **Shared subscription (default).** The runner runs next to the server:
  locally on one machine now, as a pod on Kubernetes later. It uses the team's
  shared login for each provider. Everyone sees everything.
- **Personal subscriptions (fallback).** If company policy forbids a shared
  login, each developer runs a runner on their own machine with their own
  logins. It connects to the central server. Board, handovers, doc
  proposals, usage and thread logs are all synced centrally. Only execution
  (agent processes, worktrees) is local, so a card's threads run on the
  runner of whoever picked it up.

Because the runner only talks to the server through a narrow protocol
(commands down; thread events and checkpoints up), switching between modes
is a deployment choice, not a rewrite.

### 3.7 Usage / cost

Per-thread accounting: turns, wall time, and tokens/cost wherever the agent
reports them via ACP. Coverage differs between adapters, so the meter must
cope with missing fields. Rolled up per card, product, provider and user.

## 4. Data model (first cut)

```
products(id, name)                     repos(id, product_id, path, default_branch)
users(id, name)                        issue_types(id, key, workflow_ref)
cards(id, product_id, type_id, title, body, column, step, assignee_id, rank)
workspaces(id, card_id, repo_id, runner_id, worktree_path, branch, status)
threads(id, card_id, step?, title, created_by)   -- step null = ad-hoc thread
runners(id, name, mode, last_seen)
plugin_configs(id, product_id, plugin, config jsonb, secret_ref)
external_links(id, card_id, plugin, kind, ref, url)
thread_events(id, thread_id, seq, kind, agent_id?, user_id?, payload jsonb, created_at)
agent_sessions(id, thread_id, agent_id, acp_session_id, cursor_seq, status)
checkpoints(id, thread_id, turn_seq, git_ref)
handovers(id, card_id, step, thread_id, content jsonb)
doc_proposals(id, card_id, repo_id, diff, status, reviewed_by)
usage(id, thread_id, agent_id, turn_seq, tokens_in, tokens_out, cost, ms)
agents(id, name, command, args, env_ref)   -- ACP agent registry
```

## 5. Proposed stack

- pnpm monorepo: `apps/server`, `apps/web`, `packages/acp-host`,
  `packages/core` (workflow engine, context builder), `packages/db`.
- Server: Node + Hono (or Fastify). Live updates to the UI over SSE.
- DB: Drizzle ORM (pg dialect) on PGlite locally, node-postgres in k8s.
- UI: React + Vite + TanStack Query; dnd-kit for the board.
- ACP: the official TypeScript SDK; adapters for Claude Code, Codex and
  Gemini CLI. Exact package names/versions get pinned in phase 1.

## 6. Phases

1. **ACP spike (CLI).** Spawn two different agents in the same worktree.
   Prove: prompt/stream, permission handling, `session/load` / resume,
   cancellation, usage reporting. Output: a capability matrix per adapter.
2. **Threads + model switch (CLI/API).** Event log, per-agent cursors, delta
   preamble, checkpoints, driver/consultant modes, rehydration. Built behind
   the runner interface from the start (in-process implementation).
   *This is the riskiest and most novel piece, so it goes first.*
3. **Workflow engine.** YAML types, step threads, transitions (incl.
   re-entry), gates, handovers, lifecycle (worktree create/delete). Run one
   bug card end to end, including a review → implement loop.
4. **Board UI.** Backlog, kanban, card view with live threads, gate approval.
5. **Docs steward.** Doc-change proposals + review queue, context selection.
6. **Plugins.** Plugin interface; first plugin = GitHub or GitLab (open PR on
   done), then Jira/Confluence.
7. **Team & ops.** Auth, multi-product views, usage dashboards, Postgres +
   k8s deployment (runner as pod, worktrees on volumes), remote runners.

## 7. Open questions

1. **Where product docs live:** `/docs` in each product repo (versioned with
   the code, lands in the same PR) or a separate docs repo/space (e.g.
   Confluence via plugin)? Leaning: in-repo by default, with a plugin that
   publishes to Confluence.
2. **Doc proposals and the PR:** does the approved doc diff get committed
   into the card's branch, so it ships in the same PR as the code? Leaning yes.
3. **Automatic compaction threshold:** when to reseed a step thread from its
   handover instead of continuing it (tokens? re-entry count?). Measure first.
4. **Auth for the team UI:** start with no auth on a trusted network, or SSO
   from the start?
