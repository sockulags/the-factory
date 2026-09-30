# The Factory — Plan

Status: draft, living document. Last updated 2026-09-30 (rev 7).

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
| Runtime | One central server on a VPN-protected cloud host: a VM with docker compose first, Kubernetes later. Agent execution lives in a separate **runner** (§3.6). |
| Client | **Desktop app per team member (Electron)**, with auto-update from the first release. It connects to the server over the VPN and can also host a local runner. |
| Auth | **Keycloak** (OIDC). The desktop app signs in via the system browser; the server validates access tokens. The VPN is the network boundary; auth provides identity and attribution. |
| Platforms | **Windows** only for now (NSIS installer, per-user install). |
| Subscriptions | Enterprise licenses; shared account per provider when hosted. |
| Language | TypeScript end to end. |
| DB | Postgres on the server. PGlite (embedded Postgres) for local dev and tests. Same schema and migrations. |
| Gates | Defined per step by the workflow. |
| Threads | **One thread per workflow step.** Going back to a step (e.g. review → implement) continues that step's thread with the new input. Extra ad-hoc threads are allowed. A thread is the unit of cost measurement. |
| Model switching | Within a thread you can switch provider per message. Each provider keeps its own native session for that thread and only receives what's new since it last spoke. |
| Worktree | **One worktree per card**, shared by all its steps. Only one step is active at a time, so there's one writer per card. Other agents can be consulted read-only. Deleted when the card is closed. |
| Delivery | Finishing a card opens a PR (through the relevant integration plugin). |
| Integrations | Jira, GitLab, GitHub, Confluence, … are **plugins**, wired in through workflows and instructions, not built into the core. |
| Docs changes | Agent proposes, human approves. Docs live in `/docs` of each product repo; the approved diff is committed to the card's branch and ships in the same PR. A plugin can publish to Confluence. |

## 3. Architecture

```
┌─────────── Desktop app (Electron) — one per team member ───────────┐
│  Renderer: React UI — backlog · board · card view (threads,        │
│            handovers, gates) · doc-change review · workflow viewer │
│  Main:     auth (OIDC), auto-updater, secure token storage,        │
│            optional embedded runner (personal-subscription mode)   │
└───────────────▲─────────────────────────────┬──────────────────────┘
                │ WebSocket (live events)     │ HTTPS API   (over VPN)
┌───────────────┴─────────────────────────────▼──────────────────────┐
│ Server (cloud, VPN only)                                            │
│  ├─ Auth                 OIDC token validation, users, roles         │
│  ├─ Board service        cards, types, columns, products             │
│  ├─ Workflow engine      per-type state machine (YAML), gates        │
│  ├─ Thread service       canonical event log, turn orchestration     │
│  │   └─ Session sync     per-(thread, agent) cursor + delta          │
│  ├─ Context builder      step prompt + handovers + doc sections      │
│  ├─ Docs steward         doc-change proposals, review queue          │
│  ├─ Plugin host          integrations (tracker, VCS, docs)           │
│  ├─ Usage meter          per-thread / per-card / per-provider        │
│  ├─ Update feed          serves desktop releases to the auto-updater │
│  └─ DB                   Postgres                                    │
└───────────────▲─────────────────────────────────────────────────────┘
                │ runner protocol (commands down, events up)
┌───────────────┴─────────────────────────────────────────────────────┐
│ Runner — server-side (shared subscriptions) or inside a desktop app │
│  ACP host    spawns & supervises agent processes, answers           │
│              fs/terminal/permission requests, enforces modes        │
│  Workspaces  git worktree per card, turn checkpoints as hidden refs │
└─────────────────────────────────────────────────────────────────────┘
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
(ACP agents + worktrees) are separated from day one. The runner is a plain
Node package, so it can run in two places without changes:

- **Server runner (default, shared subscriptions).** Runs as a process/pod
  next to the server, logged in with the team's shared account for each
  provider. Cards run there no matter who is at the keyboard.
- **Desktop runner (fallback, personal subscriptions).** The same package
  runs inside the Electron main process and uses the member's own CLI logins
  and a local clone. The board, handovers, doc proposals, usage and thread
  logs still sync to the server. Only execution is local, and a card's
  threads run on the runner of whoever picked it up.

Each card records which runner owns its workspace. The server routes turns
to that runner. The server is always the source of truth. The desktop app
is online-first and doesn't need offline sync (it's always on the VPN).

### 3.7 Desktop client, auth and updates

- **Electron over Tauri.** It keeps us TypeScript-only, and the main
  process is Node, so the runner (child processes, git, ACP over stdio)
  embeds directly. Tauri would need a Rust core plus a Node sidecar to do the
  same.
- **UI** is a normal React/Vite app, so it also builds as a plain web app
  served by the server. That helps with debugging and with anyone who can't
  install the app.
- **Auth:** OIDC Authorization Code + PKCE through the system browser with a
  loopback redirect. Tokens go in the OS keychain (Electron `safeStorage`).
  The server validates tokens and maps them to users/roles. Dev mode: a
  static dev token.
- **Auto-update:** `electron-updater` using a generic feed. CI builds and
  signs releases and publishes them to the server's update feed (reachable
  only on the VPN). Release channels: `stable` and `beta`.
- **Code signing** is required for smooth auto-update: Apple Developer ID +
  notarization on macOS, and a code-signing cert on Windows. Set it up in
  phase 0, not later.
- **Version skew:** the app sends its version on connect; the server enforces
  a minimum supported version and tells old clients to update.

### 3.8 Usage / cost

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

- pnpm monorepo: `apps/server`, `apps/desktop` (Electron shell),
  `packages/ui` (React app), `packages/runner` (ACP host + workspaces),
  `packages/core` (workflow engine, context builder), `packages/db`,
  `packages/protocol` (shared types for API, WebSocket and runner messages).
- Server: Node + Hono (or Fastify). Live updates over WebSocket.
- Desktop: Electron + electron-vite + electron-builder/electron-updater.
- DB: Drizzle ORM (pg dialect); Postgres on the server, PGlite in dev/tests.
- UI: React + Vite + TanStack Query; dnd-kit for the board.
- ACP: `@agentclientprotocol/sdk` (protocol v1). Adapters:
  `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`,
  `gemini --acp`. They authenticate with the CLI logins already on the machine.

## 6. Phases

0. **Walking skeleton, shipped.** ✅ *Built.* Monorepo, server with health +
   Keycloak auth, Electron app that signs in and shows "connected as …", CI
   that builds and publishes releases, auto-update fed by the server. From
   here on, every merged feature reaches the team automatically. Remaining:
   first real release on the VPN server, Windows signing certificate.
1. **ACP spike (CLI).** 🟡 *Harness built* (`packages/runner`, `pnpm probe`):
   ACP client host, read-only/write permission policy, and a probe covering
   prompt/stream, usage, writes, read-only enforcement, cancel, and resume
   across process restarts. Remaining: run it with real logins and record
   [acp-capabilities.md](acp-capabilities.md). See [acp-probe.md](acp-probe.md).
2. **Threads + model switch.** ✅ *Built* (`packages/core` ThreadService,
   `packages/runner` LocalRunner). Canonical event log in Postgres, per-agent
   cursors, delta preamble (only what the agent hasn't seen + worktree diffstat),
   recap when a session can't be reattached, git checkpoints as hidden refs
   (HEAD/index untouched), write vs consult (read-only) turns, serialized turns,
   live event stream. Try it with `pnpm thread` (`@claude …` / `?codex …`).
3. **Workflow engine.** ✅ *Built* (`packages/core` WorkflowEngine + Board).
   YAML workflows with prompt templates (`workflows/`, see
   [workflows.md](workflows.md)), one thread per step, re-entry continues
   the step's thread, consult/revise rounds, validated JSON handovers,
   auto/human/checks gates (failing checks loop back), hooks, per-card
   worktrees (created on demand, removed on close). Try it with
   `pnpm factory`.
4. **Board UI** (in the desktop app). Backlog, kanban, card view with live
   threads, gate approval.
5. **Docs steward.** Doc-change proposals + review queue, context selection.
6. **Plugins.** Plugin interface; first plugin = GitHub or GitLab (open PR on
   done), then Jira/Confluence.
7. **Team & ops.** Roles, multi-product views, usage dashboards, k8s
   deployment (runner as pod, worktrees on volumes), desktop runner mode.

## 7. Open questions

1. **Automatic compaction threshold:** when to reseed a step thread from its
   handover instead of continuing it (tokens? re-entry count?). Measure first.
2. **Windows code signing:** a .pfx certificate, or Azure Trusted Signing?
