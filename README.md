# The Factory

A board-first workspace where product and dev teams run AI agents from
multiple providers (via the Agent Client Protocol) through per-issue-type
workflows, with structured handovers and human-approved product docs.

Windows desktop app (Electron) + central server on the VPN, signed in with Keycloak.

- [docs/PLAN.md](docs/PLAN.md) — vision, architecture, phases
- [docs/development.md](docs/development.md) — running, testing, releasing, deploying
- [workflows/](workflows/) — draft workflow definitions

```sh
pnpm install && pnpm test
pnpm dev:server    # then, in another terminal:
pnpm dev:desktop
```
