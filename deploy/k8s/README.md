# Kubernetes

Two workloads: the **server** (API, board, workflows) and the **runner** (agents and
card worktrees). They talk over the runner protocol with a shared token. Postgres is
external: use your platform's managed Postgres or an operator.

```sh
kubectl create namespace factory
kubectl -n factory create configmap factory-config \
  --from-literal=PUBLIC_URL=https://factory.internal.example.com \
  --from-literal=AUTH_MODE=oidc \
  --from-literal=OIDC_ISSUER=https://sso.example.com/realms/factory \
  --from-literal=OIDC_CLIENT_ID=factory-desktop \
  --from-literal=UPDATE_MIRROR_REPO=sockulags/the-factory
kubectl -n factory create secret generic factory-secrets \
  --from-literal=DATABASE_URL=postgres://… \
  --from-literal=RUNNER_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=UPDATE_MIRROR_TOKEN=… \
  --from-literal=GITHUB_TOKEN=…            # plugin secrets, referenced by name
kubectl apply -k deploy/k8s
```

Expose `factory-server` on the VPN with your ingress of choice. Then:

- **Agent logins:** `kubectl -n factory exec -it factory-runner-0 -- npx @anthropic-ai/claude-code`
  (then `/login`), and `… npx @openai/codex login`. They persist in the `agent-home` volume.
- **Repos:** clone them into `/repos` on the runner
  (`kubectl -n factory exec factory-runner-0 -- git clone … /repos/web`) and register
  `/repos/web` under *Products & repos*.

Both workloads run one replica: the engine keeps per-card queues in memory, and
worktrees and agent sessions live on the runner's volumes.
