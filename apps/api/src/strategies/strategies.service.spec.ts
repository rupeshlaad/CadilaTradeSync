/**
 * Unit tests for StrategiesService.adminUpdate — Sprint 5.0.1 regression fix.
 *
 * Prisma runtime (Postgres) is unavailable in this workspace, so the
 * PrismaService is mocked entirely.  These tests exercise the branches
 * documented in the sprint acceptance criteria.
 *
 * Runner: standalone via ts-node.  There is no jest configured for
 * @cts/api, so we implement a tiny assertion harness in-file.
 */

import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StrategiesService } from './strategies.service';

// ---------------------------------------------------------------------------
// Tiny test harness (no jest available in this workspace)
// ---------------------------------------------------------------------------
type TestFn = () => Promise<void> | void;
const results: { name: string; ok: boolean; err?: string }[] = [];

async function test(name: string, fn: TestFn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message ?? String(e) });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.stack ?? e}`);
  }
}

function expectEqual(actual: any, expected: any, msg = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} expected ${e}, got ${a}`);
}
function expectTrue(cond: any, msg = '') {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Prisma mock factory
// ---------------------------------------------------------------------------
interface MockState {
  strategy: any | null;                     // findUnique result for strategy
  tradingAccount: Record<string, any>;      // id -> TradingAccount
  strategyUpdateCalls: any[];               // captured .update() args
  strategyFindCalls: any[];
  tradingAccountFindCalls: any[];
}

function makePrisma(state: MockState) {
  return {
    strategy: {
      findUnique: async (args: any) => {
        state.strategyFindCalls.push(args);
        return state.strategy;
      },
      update: async (args: any) => {
        state.strategyUpdateCalls.push(args);
        // echo something back so callers can assert on the return
        return { id: args.where?.id, ...args.data };
      },
    },
    tradingAccount: {
      findUnique: async (args: any) => {
        state.tradingAccountFindCalls.push(args);
        const id = args?.where?.id;
        return state.tradingAccount[id] ?? null;
      },
    },
  } as any;
}

// Shared: a "current" strategy row
const EXISTING_ID = 'strategy-1';
const CURRENT_TA_ID = 'ta-current';
const OTHER_TA_ID = 'ta-other';

function baseState(): MockState {
  return {
    strategy: {
      id: EXISTING_ID,
      tradingAccountId: CURRENT_TA_ID,
      strategyName: 'Old name',
      description: 'old',
      enabled: true,
    },
    tradingAccount: {
      [CURRENT_TA_ID]: { id: CURRENT_TA_ID, nickname: 'A' },
      [OTHER_TA_ID]: { id: OTHER_TA_ID, nickname: 'B' },
    },
    strategyUpdateCalls: [],
    strategyFindCalls: [],
    tradingAccountFindCalls: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
(async () => {
  console.log('StrategiesService.adminUpdate — Sprint 5.0.1 regression tests');
  console.log('---------------------------------------------------------------');

  // (a) editing without touching the FK preserves it
  await test('omitting tradingAccountId preserves existing FK (no tradingAccount in payload)', async () => {
    const state = baseState();
    const svc = new StrategiesService(makePrisma(state));
    await svc.adminUpdate(EXISTING_ID, { strategyName: 'New name' } as any);
    expectEqual(state.strategyUpdateCalls.length, 1, 'exactly one prisma update');
    const data = state.strategyUpdateCalls[0].data;
    expectEqual(data, { strategyName: 'New name' }, 'only strategyName is written');
    expectTrue(!('tradingAccount' in data), 'no tradingAccount connect emitted');
    expectTrue(!('tradingAccountId' in data), 'no raw tradingAccountId leaked to data');
    // no lookup for the FK
    expectEqual(state.tradingAccountFindCalls.length, 0, 'no ta lookup');
  });

  // (b) empty string is silently skipped, never sent to Prisma
  await test('empty-string tradingAccountId is skipped (no FK write, no error)', async () => {
    const state = baseState();
    const svc = new StrategiesService(makePrisma(state));
    await svc.adminUpdate(EXISTING_ID, { tradingAccountId: '' } as any);
    const data = state.strategyUpdateCalls[0].data;
    expectTrue(!('tradingAccount' in data), 'no tradingAccount connect emitted');
    expectTrue(!('tradingAccountId' in data), 'raw FK not spread');
    expectEqual(state.tradingAccountFindCalls.length, 0, 'ta.findUnique NOT invoked');
  });

  // (c) whitespace-only is treated identically to empty
  await test('whitespace-only tradingAccountId is skipped', async () => {
    const state = baseState();
    const svc = new StrategiesService(makePrisma(state));
    await svc.adminUpdate(EXISTING_ID, { tradingAccountId: '   ' } as any);
    const data = state.strategyUpdateCalls[0].data;
    expectTrue(!('tradingAccount' in data), 'no FK connect emitted for whitespace');
    expectEqual(state.tradingAccountFindCalls.length, 0, 'ta.findUnique NOT invoked');
  });

  // (d) identical FK value emits no connect
  await test('tradingAccountId identical to existing is a no-op (no connect)', async () => {
    const state = baseState();
    const svc = new StrategiesService(makePrisma(state));
    await svc.adminUpdate(EXISTING_ID, { tradingAccountId: CURRENT_TA_ID } as any);
    const data = state.strategyUpdateCalls[0].data;
    expectTrue(!('tradingAccount' in data), 'no connect for identical value');
    expectEqual(state.tradingAccountFindCalls.length, 0, 'no lookup needed');
  });

  // (e) change to another valid account emits { connect: { id } }
  await test('changing to a valid different tradingAccountId emits data.tradingAccount.connect', async () => {
    const state = baseState();
    const svc = new StrategiesService(makePrisma(state));
    await svc.adminUpdate(EXISTING_ID, { tradingAccountId: OTHER_TA_ID } as any);
    const data = state.strategyUpdateCalls[0].data;
    expectEqual(data.tradingAccount, { connect: { id: OTHER_TA_ID } }, 'connect payload');
    expectTrue(!('tradingAccountId' in data), 'raw scalar FK not present');
    expectEqual(state.tradingAccountFindCalls[0]?.where?.id, OTHER_TA_ID, 'looked up target ta');
  });

  // (f) invalid FK → BadRequest, prisma.strategy.update NOT called
  await test('invalid tradingAccountId throws BadRequestException (400) and does not call strategy.update', async () => {
    const state = baseState();
    const svc = new StrategiesService(makePrisma(state));
    let thrown: any = null;
    try {
      await svc.adminUpdate(EXISTING_ID, { tradingAccountId: 'does-not-exist' } as any);
    } catch (e) {
      thrown = e;
    }
    expectTrue(thrown instanceof BadRequestException, 'must be BadRequestException');
    expectTrue(
      /Invalid tradingAccountId/.test(thrown.message),
      'error message is meaningful',
    );
    expectEqual(state.strategyUpdateCalls.length, 0, 'strategy.update NEVER called');
  });

  // (g) unknown strategy id → NotFound before touching update
  await test('unknown strategy id throws NotFoundException, no update call', async () => {
    const state = baseState();
    state.strategy = null;
    const svc = new StrategiesService(makePrisma(state));
    let thrown: any = null;
    try {
      await svc.adminUpdate('missing', { strategyName: 'x' } as any);
    } catch (e) { thrown = e; }
    expectTrue(thrown instanceof NotFoundException, 'must be NotFoundException');
    expectEqual(state.strategyUpdateCalls.length, 0, 'no update on missing');
  });

  // (h) undefined keys are not forwarded
  await test('undefined-valued keys do not appear in Prisma data', async () => {
    const state = baseState();
    const svc = new StrategiesService(makePrisma(state));
    await svc.adminUpdate(EXISTING_ID, {
      strategyName: 'only-this',
      description: undefined,
      status: undefined,
      tradingAccountId: undefined,
    } as any);
    const data = state.strategyUpdateCalls[0].data;
    expectEqual(Object.keys(data).sort(), ['strategyName']);
  });

  // (i) null tradingAccountId is treated as "unchanged"
  await test('null tradingAccountId is treated as unchanged (no FK write, no error)', async () => {
    const state = baseState();
    const svc = new StrategiesService(makePrisma(state));
    await svc.adminUpdate(EXISTING_ID, { tradingAccountId: null } as any);
    const data = state.strategyUpdateCalls[0].data;
    expectTrue(!('tradingAccount' in data), 'no connect for null');
    expectEqual(state.tradingAccountFindCalls.length, 0, 'no lookup for null');
  });

  console.log('---------------------------------------------------------------');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`RESULT: ${passed}/${results.length} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
