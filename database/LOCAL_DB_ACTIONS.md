# LOCAL DATABASE ACTIONS — required after pulling `main`

> Sprint 6.2.8 added `InstrumentBroker.exchange` + a new composite unique key.
> These are **not** applied automatically. The instrument tables are managed by
> `prisma db push` (they are NOT in Prisma migration history), so DO NOT run
> `prisma migrate`. Run the steps below on your machine once, after pulling.

## 0. Confirm the repository actually contains the fix

The schema change lives in `database/prisma/prisma/schema.prisma`:

```prisma
model InstrumentBroker {
  ...
  exchange       String
  ...
  @@unique([broker, brokerSymbol, exchange])
  @@index([broker, brokerSymbol])
}
```

If your working copy shows `@@unique([broker, brokerSymbol])` with no `exchange`
column, your local branch is **behind** — the fix commits have not reached your
checkout yet (see "Why GitHub looked wrong" at the bottom).

## 1. Apply the schema to your local Postgres

The `exchange` column is `NOT NULL`; the instrument tables are disposable
(re-imported from the broker masters), so truncate first, then push:

```bash
# from repo root, with DATABASE_URL pointing at your local Postgres
psql "$DATABASE_URL" -c 'TRUNCATE TABLE instrument_brokers, instruments RESTART IDENTITY CASCADE;'
pnpm --filter @cts/database exec prisma db push
pnpm --filter @cts/database prisma:generate
```

## 2. Re-import the instrument masters

```bash
# with the API running locally
curl -X POST http://localhost:4000/instruments/import/icici
# repeat for the other brokers you use:
#   /instruments/import/zerodha  /instruments/import/fyers  /instruments/import/shoonya
```

## 3. Rebuild the API binary (kills the stale pre-6.2.8 build)

The "product = margin" / "user_remark = CTS Manual Trade" seen in live logs comes
from an OLD compiled binary. Rebuild so the shared mapper is what actually runs:

```bash
pnpm -r build      # or: pnpm dev:api
```

## Verify

- [ ] `SELECT broker, "brokerSymbol", exchange FROM instrument_brokers WHERE "brokerSymbol"='TCS';`
      returns **two** rows (NSE and BSE).
- [ ] Manual ICICI cash BUY → Breeze payload shows `product=cash`,
      `user_remark=CTSManualTrade` (no spaces), order accepted.
- [ ] A trade placed directly in the ICICI terminal is detected by the master
      watcher and copied to followers.

## Why GitHub looked wrong

The Sprint 6.2.8 fix was committed on local `main` (feat `2f64cc7`, merge
`530253d`) but had **not been pushed** — `origin/main` was still `0781879`.
A `git pull` therefore returned the pre-fix code. Publish the local commits via
the **Save to GitHub** action so `origin/main` carries the fix.
