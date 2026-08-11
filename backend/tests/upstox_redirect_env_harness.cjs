/**
 * Upstox UDAPI1014 fix — env-loading root-cause regression harness.
 *
 * Root cause: app.module.ts used `envFilePath: ['.env']`, a path resolved
 * relative to process.cwd(). The API is started with cwd = repo root / Docker
 * WORKDIR /app (NOT apps/api), so @nestjs/config looked for `<cwd>/.env`,
 * never loaded apps/api/.env, and process.env.UPSTOX_REDIRECT_URI stayed empty
 * → UpstoxAdapter sent redirect_uri='' → Upstox "UDAPI1014: Redirect URI is
 * required". Fix: `envFilePath: [join(__dirname,'..','.env'), '.env']` anchors
 * to apps/api/.env regardless of cwd.
 *
 * This harness spins up the REAL @nestjs/config ConfigModule against a fixture
 * env file from a FOREIGN working directory (no DB, no network, no server) and
 * proves the OLD path fails while the NEW __dirname-anchored path succeeds.
 *
 * Run: node backend/tests/upstox_redirect_env_harness.cjs   (from /app)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');
const apiPaths = [API_DIR, path.join(__dirname, '..', '..')];
const req = (m) => require(require.resolve(m, { paths: apiPaths }));
req('reflect-metadata');
const { Module } = req('@nestjs/common');
const { ConfigModule, ConfigService } = req('@nestjs/config');
const { NestFactory } = req('@nestjs/core');

const EXPECTED = 'https://cts.investwithdimple.com/brokers/upstox/callback';

// Fixture mimicking the runtime layout: <fixture>/apps/api/{dist,.env}
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-env-'));
const fApiDir = path.join(fixture, 'apps', 'api');
const fDistDir = path.join(fApiDir, 'dist');
fs.mkdirSync(fDistDir, { recursive: true });
fs.writeFileSync(
  path.join(fApiDir, '.env'),
  `UPSTOX_REDIRECT_URI=${EXPECTED}\nUPSTOX_API_KEY=fixturekey\nCORS_ORIGINS=http://localhost:3000\n`,
);

// A foreign cwd that is NOT apps/api and has NO .env (the prod/Docker case).
const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cts-cwd-'));

const results = [];
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

// The compiled RUNTIME artifact must carry the fix (this is what actually runs).
check('compiled dist/app.module.js is __dirname-anchored (not cwd-relative)', () => {
  const compiled = fs.readFileSync(
    path.join(API_DIR, 'dist', 'app.module.js'),
    'utf8',
  );
  assert.ok(
    /envFilePath:\s*\[\(0,\s*path_1\.join\)\(__dirname,\s*'\.\.',\s*'\.env'\)/.test(
      compiled,
    ) || /join\(__dirname,\s*['"]\.\.['"],\s*['"]\.env['"]\)/.test(compiled),
    'dist/app.module.js does not anchor envFilePath to __dirname/../.env',
  );
});

async function loadWithConfigModule(envFilePath) {
  // Clear any prior value so each case is independent.
  delete process.env.UPSTOX_REDIRECT_URI;
  class TestMod {}
  Module({
    imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath, ignoreEnvFile: false })],
  })(TestMod);
  const ctx = await NestFactory.createApplicationContext(TestMod, { logger: false });
  const cfg = ctx.get(ConfigService);
  const viaService = cfg.get('UPSTOX_REDIRECT_URI');
  const viaProcess = process.env.UPSTOX_REDIRECT_URI;
  await ctx.close();
  return { viaService, viaProcess };
}

// OLD behaviour: cwd-relative '.env' from a foreign cwd → NOT found → empty.
check('OLD envFilePath [".env"] from foreign cwd → UPSTOX_REDIRECT_URI empty (reproduces UDAPI1014)', async () => {
  process.chdir(foreignCwd);
  const { viaService, viaProcess } = await loadWithConfigModule(['.env']);
  assert.ok(!viaService, `expected empty via ConfigService, got: ${viaService}`);
  assert.ok(!viaProcess, `expected empty via process.env, got: ${viaProcess}`);
});

// NEW behaviour: __dirname-anchored path (simulated via fixture dist) from the
// SAME foreign cwd → apps/api/.env found → var populated everywhere.
check('NEW envFilePath [join(distDir,"..",".env")] from foreign cwd → var populated', async () => {
  process.chdir(foreignCwd);
  const anchored = path.join(fDistDir, '..', '.env'); // == fApiDir/.env
  const { viaService, viaProcess } = await loadWithConfigModule([anchored, '.env']);
  assert.strictEqual(viaService, EXPECTED, 'ConfigService must expose the redirect uri');
  assert.strictEqual(viaProcess, EXPECTED, 'process.env must be populated (adapter/controller read it directly)');
});

// The consumers read process.env directly → once populated they get the value.
check('UpstoxAdapter/Controller/BrokerService read process.env.UPSTOX_REDIRECT_URI directly', () => {
  const files = {
    'upstox.adapter.ts': "private redirectUri: string = process.env.UPSTOX_REDIRECT_URI ?? '';",
    'upstox.controller.ts': 'process.env.UPSTOX_REDIRECT_URI',
    'broker.service.ts': 'process.env.UPSTOX_REDIRECT_URI',
  };
  const map = {
    'upstox.adapter.ts': path.join(API_DIR, 'src/brokers/upstox/upstox.adapter.ts'),
    'upstox.controller.ts': path.join(API_DIR, 'src/brokers/upstox/upstox.controller.ts'),
    'broker.service.ts': path.join(API_DIR, 'src/brokers/broker.service.ts'),
  };
  for (const [name, needle] of Object.entries(files)) {
    const src = fs.readFileSync(map[name], 'utf8');
    assert.ok(src.includes(needle), `${name} no longer reads process.env.UPSTOX_REDIRECT_URI as expected`);
  }
});

(async () => {
  const repoRoot = path.join(__dirname, '..', '..');
  for (const [name, fn] of checks) {
    try {
      await fn();
      results.push([true, name]);
    } catch (e) {
      results.push([false, `${name} — ${e.message}`]);
    } finally {
      process.chdir(repoRoot); // never leave cwd changed
    }
  }
  // cleanup fixtures
  try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(foreignCwd, { recursive: true, force: true }); } catch {}

  let pass = 0;
  for (const [ok, name] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass++;
  }
  console.log(`\nRESULT: ${pass}/${results.length} ${pass === results.length ? 'ALL PASS' : 'FAILURES PRESENT'}`);
  process.exit(pass === results.length ? 0 : 1);
})();
