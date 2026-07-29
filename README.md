# Cadila TradeSync (CTS)

A production-ready **fintech SaaS foundation** — clean monorepo scaffold for a future multi-broker copy trading platform.

> This repository contains **only the project foundation** — no business logic, no broker integration, no payment integration, and no copy trading yet.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend (User)  | Next.js 15 + React 19 + TypeScript + Tailwind + shadcn/ui |
| Frontend (Admin) | Next.js 15 + React 19 + TypeScript + Tailwind + shadcn/ui |
| Backend          | NestJS 11 + TypeScript |
| ORM              | Prisma 6 |
| Database         | PostgreSQL 16 |
| Cache            | Redis 7 |
| Auth Skeleton    | JWT + Role-based (Admin / User) |
| Monorepo         | pnpm workspaces |
| Local Infra      | Docker Compose |

---

## Monorepo Structure

```
cadila-tradesync/
├── apps/
│   ├── web/          # User-facing Next.js app (landing, login, register, dashboard)
│   ├── admin/        # Admin Next.js app (admin dashboard layout)
│   └── api/          # NestJS backend API (auth skeleton, users, health)
├── packages/
│   ├── shared/       # Shared TS types, DTOs, enums, constants
│   └── ui/           # Shared UI primitives (future shadcn components)
├── database/
│   └── prisma/       # Prisma schema, migrations, seed
├── docker/           # Optional per-service Dockerfiles
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

---

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 9  (`npm install -g pnpm`)
- **Docker** & **Docker Compose**

---

## Quick Start (Local Development)

### 1. Clone & install

```bash
git clone <your-repo-url> cadila-tradesync
cd cadila-tradesync
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/admin/.env.example apps/admin/.env.local
cp database/prisma/.env.example database/prisma/.env
```

### 3. Start infrastructure (Postgres + Redis)

```bash
pnpm docker:up
```

Check they are healthy:

```bash
docker ps
```

### 4. Generate Prisma client & run migrations

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed        # optional — creates a default admin + user
```

### 5. Start all apps (parallel)

```bash
pnpm dev
```

Or start apps individually:

```bash
pnpm dev:api       # NestJS   → http://localhost:4000
pnpm dev:web       # User app → http://localhost:3000
pnpm dev:admin     # Admin    → http://localhost:3001
```

---

## Default Seed Credentials

After running `pnpm db:seed`:

| Role  | Email               | Password    |
|-------|---------------------|-------------|
| Admin | admin@cts.local     | Admin@123   |
| User  | user@cts.local      | User@123    |

---

## Available URLs

| App     | URL                          |
|---------|------------------------------|
| Web     | http://localhost:3000        |
| Admin   | http://localhost:3001        |
| API     | http://localhost:4000        |
| Health  | http://localhost:4000/health |

---

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev`         | Run web + admin + api in parallel |
| `pnpm build`       | Build all workspaces |
| `pnpm lint`        | Lint all workspaces |
| `pnpm typecheck`   | Type-check all workspaces |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:migrate`  | Apply migrations |
| `pnpm db:studio`   | Open Prisma Studio |
| `pnpm db:seed`     | Seed database |
| `pnpm docker:up`   | Start Postgres + Redis |
| `pnpm docker:down` | Stop containers |

---

## Feature Status

- [x] Monorepo scaffold (pnpm workspaces)
- [x] Landing / Login / Register pages
- [x] User Dashboard layout
- [x] Admin Dashboard layout
- [x] Dark / Light theme toggle
- [x] JWT auth skeleton (register/login/me)
- [x] Role-based structure (`ADMIN`, `USER`)
- [x] Prisma schema + PostgreSQL
- [x] Redis wired for API
- [x] Docker Compose infra
- [ ] Broker integrations (future)
- [ ] Copy trading engine (future)
- [ ] Payments (future)

---

## License

Proprietary — Cadila TradeSync.
