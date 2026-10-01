# The Factory runner service: agent processes + card worktrees. Context: repository root.
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @factory/runner-service build
RUN pnpm --filter @factory/runner-service deploy --legacy --prod /out && cp -r apps/runner/dist /out/dist

FROM node:22-slim
ENV NODE_ENV=production
# Agents need git; their ACP adapters are fetched with npx on first use.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data/worktrees /repos && chown -R node:node /data /repos
USER node
# Mount: /repos (product repos), /data (worktrees), /home/node (agent CLI logins).
ENV PORT=8788
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
