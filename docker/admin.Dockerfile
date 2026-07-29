FROM node:20-alpine AS base
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile=false

FROM deps AS builder
COPY . .
RUN pnpm --filter @cts/admin build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /repo/apps/admin/.next ./.next
COPY --from=builder /repo/apps/admin/public ./public
COPY --from=builder /repo/apps/admin/package.json ./package.json
COPY --from=builder /repo/node_modules ./node_modules
EXPOSE 3001
CMD ["node_modules/.bin/next", "start", "-p", "3001"]
