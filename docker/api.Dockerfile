# ---- Base ----
FROM node:20-alpine AS base
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

# ---- Deps ----
FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY database/prisma/package.json database/prisma/package.json
COPY database/prisma/prisma database/prisma/prisma
RUN pnpm install --frozen-lockfile=false

# ---- Builder ----
FROM deps AS builder
COPY . .
RUN pnpm --filter @cts/database prisma:generate
RUN pnpm --filter @cts/api build

# ---- Runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /repo/apps/api/dist ./dist
COPY --from=builder /repo/apps/api/package.json ./package.json
COPY --from=builder /repo/node_modules ./node_modules
EXPOSE 4000
CMD ["node", "dist/main.js"]
