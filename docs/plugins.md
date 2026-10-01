# Plugins (integrations)

The core knows nothing about GitHub, GitLab, Jira or Confluence. Integrations are
plugins, enabled and configured **per product** under *Products & repos → Integrations*
in the app (or `PUT /api/products/:id/plugins/:plugin`). A plugin can contribute:

- **Workflow hooks**: named actions workflows run on step enter/exit (`hooks.exit` in
  `workflow.yaml`). A generic name like `vcs.open_pr` resolves to whichever enabled
  plugin provides it. Prefix with the plugin id (`gitlab.vcs.open_pr`) to pick one.
- **Agent tools**: MCP servers passed to every agent session on the product's cards.
- **Instructions**: text added to the first prompt of every step.

Secrets are never stored in the database. Configs name **environment variables on the
server** (e.g. `"tokenEnv": "GITHUB_TOKEN"`). Put the values in `deploy/.env`; the
server container loads that file.

## Built-in plugins

| Plugin | Provides | Config |
|---|---|---|
| `github` | hook `vcs.open_pr`: pushes the card branch and opens (or finds) a pull request, and links it to the card | `owner`, `repo`, `tokenEnv` (default `GITHUB_TOKEN`), `apiUrl` (GitHub Enterprise), `remote`, `draft` |
| `gitlab` | hook `vcs.open_pr`: pushes and opens (or finds) a merge request | `baseUrl`, `project` (`group/repo`), `tokenEnv` (default `GITLAB_TOKEN`), `remote`, `draft` |
| `mcp` | agent tools: any MCP servers (stdio or http), e.g. Atlassian's for Jira/Confluence | `servers: [{ type: "http", name, url, headers: { Header: "ENV_VAR" } } \| { type: "stdio", name, command, args, env: { VAR: "ENV_VAR" } }]` |
| `instructions` | text for every step's first prompt | `text` |
| `webhook` | hook `notify.webhook`: posts card progress to Slack/Teams/HTTP | `urlEnv`, `format` (`slack` \| `json`) |

The shipped `bug` and `feature` workflows run `vcs.open_pr` when the docs step is
approved. By then every approved step has been committed to the card branch, so the PR
reads step by step. Its description is built from the handovers (steps, how to verify,
open questions).

Tokens need permission to push branches and create PRs/MRs on the repo
(GitHub: *contents* and *pull requests* write; GitLab: `api` scope). Pushes send the
token as an HTTP header for that one command, so it never ends up in git config or
remote URLs.

## Jira and Confluence

Use the `mcp` plugin with an Atlassian MCP server, so agents can read issues and pages
and comment on them. Use the `instructions` plugin to tell them how your team uses them
(e.g. "the Jira key is in the card title; comment on the issue when a PR opens").

## Writing a plugin

A plugin is a `FactoryPlugin` (`packages/core/src/plugins/types.ts`): an id, a zod
schema for its config, an example config for the UI, and any of `hooks`,
`mcpServers(config, env)` and `instructions(config)`. Register it in
`builtinPlugins()`. Hooks get the card, step, repo, board and runner, plus their config
and the server env. What they return is recorded in the card's history.
