# ACP probe (phase 1)

The Factory depends on a handful of things each ACP agent may or may not do well.
The probe checks those things against the real agents, on a real machine, with the
team's real logins, and writes the results to [acp-capabilities.md](acp-capabilities.md).

## Running it

On a dev machine where the agent CLIs are signed in (the same subscriptions the
Factory will use):

```sh
# One-time logins, if not done already
npx @anthropic-ai/claude-code      # then /login
npx @openai/codex login

pnpm install
pnpm probe --agents claude,codex --out docs/acp-capabilities.md --json probe.json
```

Add `gemini` to `--agents` to include Gemini CLI. `--timeout <s>` sets the per-turn
limit (default 180). `--keep` keeps the scratch repo for inspection. `--config
agents.json` overrides or adds agents (`[{ "id", "name", "command", "args", "env" }]`),
for example to pin adapter versions.

To talk to an agent by hand through the same client code:

```sh
pnpm chat claude --cwd ../some-repo            # write mode
pnpm chat codex --cwd ../some-repo --read-only
```

The probe creates a throwaway git repo in the temp directory and only touches that.
It sends about seven short prompts per agent, so it costs a few cents of usage.

## What each check means and why it matters

| Check | What the probe does | Why the Factory needs it |
|---|---|---|
| **Starts & initializes** | Spawns the adapter, runs `initialize`, records its capabilities, modes and config options. | Baseline. The recorded modes and config options (for example model selection) show what we can steer per step. |
| **Prompt & streaming** | Sends a trivial prompt and checks the reply arrives as streamed chunks. | Live thread view in the app. |
| **Usage reporting** | Looks for token usage in the prompt response and `usage_update` notifications (context size, cost). | Per-thread cost accounting (§3.8 of the plan). If it's missing, we fall back to counting turns and time. |
| **Writes in write mode** | Asks the agent to create a file. Records whether it went through our `fs/write_text_file` or the agent's own tools, and how many permission prompts it raised. | The driver has to be able to change the worktree. Writes that go through us can be audited and checkpointed exactly. |
| **Read-only enforced** | Switches the session to read-only, where our policy rejects edit/execute permissions and client writes, then asks for another file. | Consultants must not write to the shared worktree (§3.2). If this fails, the agent writes without asking. Then we also need its own read-only mode, or an OS-level sandbox. |
| **Cancel** | Starts a long reply and sends `session/cancel` once output streams. | The Stop button, and step timeouts. |
| **Resume after restart** | Plants a codeword, kills the adapter, starts a fresh process, reattaches with `session/load` (history replay) or `session/resume`, and asks for the codeword. | The core of the thread model (§3.1): each provider keeps its own native session per thread across runner restarts, and only gets the delta. If this fails for an agent, we rehydrate from the handover instead. |

## How results feed phase 2

- **Resume works** → keep native sessions, send only deltas (the planned design).
- **Resume missing or broken** → for that agent, start a new session per turn batch,
  seeded with the step handover plus a recent tail of the thread log.
- **Read-only fails** → the runner switches agents into their own read-only mode for
  consult turns automatically: any mode whose id contains "read-only" (Codex). If the
  agent calls it something else, set it in an agents config file,
  `[{ "id": "codex", "modes": { "consult": "<mode id>" } }]`, and pass `--config`.
  The mode ids are listed under *Agent modes* in the report.
- **Writes bypass client fs** → compute "what changed" from git checkpoints only
  (planned anyway) rather than from fs callbacks.
- **No usage** → meter turns and time for that agent.

## Implementation notes

`packages/runner` holds the ACP client host (`AgentProcess`), the permission
policy, the probe and the CLI. The tests run the probe against a scripted ACP agent
(`test/fake-agent.ts`). That agent can be configured to lack load/resume, skip usage,
bypass read-only, or require auth, so the probe's verdicts are tested too, not just
the happy path.
