# CTS VPS Environment

## Project

- Project: CadilaTradeSync / TradeSync
- GitHub: `rupeshlaad/CadilaTradeSync`
- VPS: Ubuntu 24.04 under WSL2
- Host: `DESKTOP-OO4SS86`
- Linux user: `cts_admin`
- Project path: `/home/cts_admin/CTS/app`
- Monorepo: pnpm workspace
- Branch: `main`

## Application Services

| Service | Technology | Port |
|---|---|---:|
| Web / Follower Portal | Next.js | 3000 |
| Admin / Master Portal | Next.js | 3001 |
| API | NestJS | 4000 |
| Database | PostgreSQL | local/container |
| Cache | Redis | local/container |

Start the complete development environment:

```bash
pnpm dev

Individual services:

pnpm dev:web
pnpm dev:admin
pnpm dev:api
URLs
Local
Web: http://localhost:3000
Admin: http://localhost:3001
API: http://localhost:4000
API health: http://localhost:4000/health
Permanent Public API

https://cts.investwithdimple.com

Health:

https://cts.investwithdimple.com/health

Cloudflare is in front of the public API domain.

IMPORTANT: API and Broker Callback Domain

https://cts.investwithdimple.com is the permanent API and broker OAuth callback domain.

Do not move or replace this domain.

The frontend domain is separate.

Future Frontend Domain

Planned frontend:

https://tradesync.kamalsecurities.com

Architecture:

tradesync.kamalsecurities.com
        |
        +-- Web / Follower Portal
        |
        +-- Admin / Master Portal
                    |
                    v
        cts.investwithdimple.com
                    |
                    v
                NestJS API
                    |
          +---------+---------+
          |         |         |
          v         v         v
     PostgreSQL   Redis    Brokers

Changing the frontend domain must not require changing existing broker callback registrations.

Broker Integrations

Current brokers:

Zerodha
FYERS
Shoonya
Upstox
ICICI

Current validation status:

Zerodha — validated
FYERS — validated
Shoonya — authentication/read operations validated; PlaceOrder testing ongoing
Upstox — pending live credentials

Keep broker-specific logic inside the appropriate broker adapter/mapper.

Copy-Trading Flow
Master Broker
     |
     v
Master Watcher
     |
     v
Position / Lifecycle Processing
     |
     v
CopyTradingService
     |
     v
Follower Execution
     |
     v
Instrument Translation
     |
     v
Broker-specific Translator / Adapter
     |
     v
Follower Broker

Keep the CTS canonical order representation separate from broker-native representations.

Order Types

CTS supports:

MARKET
LIMIT
SL
SL-M

Order type and relevant prices must be preserved through the copy-trading pipeline.

Broker-specific conversion must happen at the broker layer.

Do not silently change an order type to bypass a broker restriction unless explicitly requested.

Product Types

CTS supports broker/product concepts including:

CNC
INTRADAY / MIS

Product codes are broker-specific and must be mapped through the appropriate broker layer.

Instrument Translation

Master and follower brokers may use different symbol formats.

Example:

Master:
NSE:TATASTEEL-EQ

        |
        v

Instrument Translation

        |
        v

Shoonya:
TATASTEEL-EQ

Do not bypass the existing instrument translation mechanism.

Execution Lifecycle

Important CTS components include:

ExecutionEventRecorder
ExecutionHistoryService
PositionLifecycleService
ManualTradeTrace
Trade Monitor
CopyTradingService
FollowerExecutionService

Broker failures must remain distinguishable from successful executions.

Preserve broker error messages, normalized error categories, correlation IDs and relevant execution identifiers.

Git / VPS Migration

The system was migrated from the previous local Windows environment to Ubuntu/WSL2 primarily to avoid changing public-IP problems.

The migration mainly involved runtime/deployment configuration rather than application source-code changes.

Deployment-specific configuration includes:

.env files
WSL networking
port forwarding
Cloudflare configuration
public/local IP configuration
broker credentials
API credentials

These must not be committed to GitHub.

The Git repository is the source of truth for application source code.

The VPS contains deployment-specific runtime configuration.

Migration baseline

At the last verified baseline:

HEAD        = e236ec33f7d33c17e1d90afb76d28aa7d0a6f0e8
origin/main = e236ec33f7d33c17e1d90afb76d28aa7d0a6f0e8
working tree = clean

This SHA is a historical baseline only. Always verify the current Git SHA before assuming it is still current.

Development Rules
Do not redesign the existing architecture unless explicitly requested.
Do not move or replace cts.investwithdimple.com.
Preserve existing broker integrations when modifying another broker.
Keep broker-specific logic inside broker-specific adapters/mappers.
Do not commit secrets or actual .env files.
Do not hard-code deployment-specific values.
Make the smallest change required to solve the identified problem.
Do not modify unrelated components.
Preserve existing working behavior.
Before changing code, identify the exact file/function responsible for the issue.
Use actual logs, source code and tests to prove the problem before changing code.
For broker API behavior, prefer official broker documentation over assumptions.
Run relevant tests, typecheck and build after code changes.
Clearly report files changed and tests performed.
Do not silently introduce fallback behavior that changes trading semantics.
Emergent / Coding-Agent Instruction

Before making source-code changes, read:

memory/CTS_VPS_ENVIRONMENT.md
memory/PRD.md

Treat these files as project constraints.

Do not repeatedly re-investigate facts already established in these documents.

When a specific defect is identified:

Inspect
  ↓
Identify exact cause
  ↓
Make minimal change
  ↓
Run targeted test
  ↓
Run regression
  ↓
Typecheck / build

Do not redesign unrelated parts of the system while fixing a localized problem.

Security

Never commit:

API keys
broker credentials
OAuth secrets
access tokens
JWT secrets
database passwords
Redis credentials
Cloudflare tokens
private secrets
actual .env files containing secrets

Safe .env.example files may contain variable names but never real credentials.

Core Principle

Preserve what works. Change only what is necessary. Validate the change. Do not redesign the architecture unless explicitly requested.
