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
| Runtime | Local first (one server, team connects via browser). Kubernetes later. |
| Subscriptions | Enterprise licenses; shared account per provider when hosted. |
| Language | TypeScript end to end. |
| DB | Postgres dialect everywhere. Locally embedded (PGlite) so nothing to install; real Postgres in k8s. Same schema and migrations. |
| Gates | Defined per step by the workflow. |
| Threads | Each card can open any number of threads. A thread is also the unit of cost measurement. |
| Model switching | Within a thread you can switch provider per message. Each provider keeps its own native session for that thread and only receives what's new since it last spoke. |
| Implementation | One agent writes code per thread/turn; others can be consulted in the same thread and see the same worktree. |
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
│ ACP host   spawns & supervises agent processes (one per active   │
│            session), answers fs/terminal/permission requests     │
│ Workspaces git worktree per card, turn checkpoints as hidden refs│
│ DB         PGlite (local) → Postgres (k8s)                       │
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
- Two threads on the same card that both want to write → a per-card write
  lock, or a separate worktree per thread (decide in phase 2).

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

Moving a card to a column = entering a step. The workflow engine opens (or
reuses) the step's thread, runs it and waits on the gate.

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

### 3.5 Usage / cost

Per-thread accounting: turns, wall time, and tokens/cost wherever the agent
reports them via ACP. Coverage differs between adapters, so the meter must
cope with missing fields. Rolled up per card, product, provider and user.

## 4. Data model (first cut)

```
products(id, name)                     repos(id, product_id, path, default_branch)
users(id, name)                        issue_types(id, key, workflow_ref)
cards(id, product_id, type_id, title, body, column, step, assignee_id, rank)
workspaces(id, card_id, repo_id, worktree_path, branch)
threads(id, card_id, step, title, created_by)
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
   preamble, checkpoints, driver/consultant modes, rehydration.
   *This is the riskiest and most novel piece, so it goes first.*
3. **Workflow engine.** YAML types, steps, gates, handovers. Run one bug card
   end to end.
4. **Board UI.** Backlog, kanban, card view with live threads, gate approval.
5. **Docs steward.** Doc-change proposals + review queue, context selection.
6. **Team & ops.** Auth, multi-product views, usage dashboards, Postgres +
   k8s deployment (agents as pods, worktrees on volumes).

## 7. Open questions

1. **Team, locally:** one shared server on a machine the team reaches over the
   LAN, or each dev runs their own instance against a shared DB? (Worktrees and
   agent logins live on the machine running the server.)
2. **Where product docs live:** `/docs` in each product repo (versioned with
   the code) or a separate docs repo/space?
3. **Git integration:** when a card is done, does the factory open a PR, or
   does a human take the branch from there?
4. **Parallel writers:** per-card write lock, or a worktree per thread?
5. **Card ↔ external trackers:** needed eventually (Jira/Linear/GitHub), or is
   the factory the source of truth?
