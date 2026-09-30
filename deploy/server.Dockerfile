# Builds the Factory server image. Context: repository root.
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @factory/server build
# Production node_modules for the server only (workspace packages are bundled into dist).
RUN pnpm --filter @factory/server deploy --legacy --prod /out && cp -r apps/server/dist /out/dist

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data /updates && chown -R node:node /data /updates
USER node
ENV PORT=8787 UPDATES_DIR=/updates
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
