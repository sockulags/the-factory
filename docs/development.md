# Development

## Layout

```
apps/server      Hono API server: auth (Keycloak/OIDC), client config, update feed
apps/desktop     Electron app: main process (auth, updates, IPC) + preload bridge
packages/runner  ACP client host: spawns agents, permission policy, checkpoints, probe/chat CLI
packages/core    Threads (event log, cursors, deltas), board store, workflow engine, CLIs
workflows/       Workflow definitions and step prompts (see docs/workflows.md)
packages/ui      React UI rendered inside the desktop app
packages/protocol Shared types/schemas: API, desktop bridge, version rules
packages/db      Drizzle schema + migrations (Postgres; PGlite for dev/tests)
deploy/          Server image, compose files, dev Keycloak realm
```

Internal packages are consumed as TypeScript source; the server and the desktop
app are bundled with esbuild, so nothing needs a separate build step during dev.

## Prerequisites

Node 22 (`.nvmrc`) and pnpm (`corepack enable`).

```sh
pnpm install
pnpm test          # unit tests, all packages
pnpm lint          # biome
pnpm typecheck
```

## Run it locally

**1. Server.** Without Keycloak (static dev token):

```sh
cp apps/server/.env.example apps/server/.env   # then set AUTH_MODE=dev, DEV_TOKEN=…
pnpm dev:server                                # http://localhost:8787
```

With a real Keycloak (Docker):

```sh
docker compose -f deploy/docker-compose.dev.yml up -d    # realm "factory", user dev/dev
pnpm dev:server                                          # .env defaults point at it
```

**2. Desktop app.**

```sh
pnpm dev:desktop    # builds UI + main, launches Electron; enter http://localhost:8787
```

For UI hot reload, run `pnpm dev:ui` and start the app with
`FACTORY_UI_DEV_URL=http://localhost:5173`.

Useful env vars for the app: `FACTORY_SERVER_URL` (pre-fills the server address),
`FACTORY_USER_DATA_DIR` (separate profile, e.g. to run two users side by side).

## Agents (ACP)

```sh
pnpm probe --agents claude,codex --out docs/acp-capabilities.md   # capability matrix
pnpm chat claude --cwd ../some-repo [--read-only]                  # talk to an agent
```

Agents use the CLI logins on the machine (`claude /login`, `codex login`). See
[acp-probe.md](acp-probe.md).

### Multi-agent threads

```sh
pnpm thread --cwd ../some-repo --title "Fix login bug"
```

Inside the thread, `@claude <message>` lets Claude drive (edit files), `?codex <message>`
consults Codex read-only, and plain text goes to the last agent. `/log` shows the
canonical log, `/threads` lists threads, `--thread <id>` reopens one, and Ctrl+C cancels
a running turn. Each agent keeps its own provider session per thread. Before a turn it
receives only what it hasn't seen (others' messages and replies, plus a diffstat of
worktree changes with a `git diff <checkpoint>` hint). If its session can't be
reattached, it gets a recap instead. Data lives in `~/.factory/cli-db`.

### Cards and workflows

```sh
pnpm factory product add WEB "Web app"
pnpm factory repo add WEB ../web --branch main --checks "pnpm test"
pnpm factory card new WEB bug "Login button does nothing" --body "…"
pnpm factory card start WEB-1        # runs triage, streams it, stops at the gate
pnpm factory card approve WEB-1      # or: card changes WEB-1 --comment "…"
pnpm factory card show WEB-1         # state, handovers, history
pnpm factory cards WEB
```

Worktrees go to `~/.factory/worktrees/<card>`. `card close` removes the worktree (the
branch stays).

## Tests

- **Unit:** `pnpm test`. The desktop tests run the real OIDC flow (PKCE, loopback
  redirect, refresh, logout) against a mock Keycloak in `apps/desktop/test/support`.
- **End to end:** `pnpm build && xvfb-run -a pnpm --filter @factory/desktop test:e2e`
  (drop `xvfb-run` on Windows/macOS). Starts the built server in OIDC mode and the mock
  Keycloak, launches the real Electron app, and signs in through the UI.

## Database

Schema lives in `packages/db/src/schema.ts`. After changing it:

```sh
pnpm --filter @factory/db generate -- --name <what-changed>
```

Migrations run automatically on server start.

## Releasing

1. Merge to `main` with CI green.
2. Tag: `git tag v0.2.0 && git push origin v0.2.0` (stable), or `v0.3.0-beta.1` (beta).
3. The **Release** workflow builds the Windows installer, attaches `Factory-Setup-*.exe`,
   `.blockmap` and `latest.yml` to a GitHub Release, and pushes the server image to
   `ghcr.io/sockulags/the-factory-server:<version>`.
4. The server mirrors new releases into `/updates/<channel>` (every 10 min). Installed
   apps check hourly and on start, download in the background, and install on restart.

To force everyone onto a new version, raise `MIN_CLIENT_VERSION` on the server.
Outdated apps then see an "update required" screen.

### Code signing (Windows)

Add `WIN_CSC_LINK` (base64 .pfx or URL) and `WIN_CSC_KEY_PASSWORD` as repository
secrets. Unsigned builds still install and auto-update, but SmartScreen warns on the
first install. For Azure Trusted Signing, add `win.azureSignOptions` to
`apps/desktop/electron-builder.yml`.

## Deploying the server (VPN host)

```sh
cp deploy/.env.example deploy/.env      # fill in PUBLIC_URL, OIDC_ISSUER, passwords, token
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

### Keycloak client

Create (or import from `deploy/keycloak/factory-realm.json`) a client:

| Setting | Value |
|---|---|
| Client ID | `factory-desktop` |
| Client authentication | Off (public client) |
| Standard flow | On; direct access grants off |
| PKCE method | S256 |
| Valid redirect URIs | `http://127.0.0.1:*` (loopback, any port, per RFC 8252) |

The app sends access tokens to the server. The server accepts them when `azp` (or
`aud`) is `factory-desktop` and the issuer matches `OIDC_ISSUER`. Realm roles and the
client's roles show up as the user's roles.
