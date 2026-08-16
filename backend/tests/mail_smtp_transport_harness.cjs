/**
 * Sprint 1 — SMTP transport wiring regression harness (static, no network).
 *
 * Proves, WITHOUT sending real mail or opening a socket:
 *   1. When SMTP is NOT configured, MailService.send() returns
 *      { delivered:false } and never builds a transporter (safe dev fallback).
 *   2. When SMTP IS configured, MailService builds a nodemailer transport with
 *      the Hostinger port-587 STARTTLS options (host, port 587, secure:false,
 *      requireTLS:true, auth from env) and sends from MAIL_FROM.
 *   3. A successful SMTP submission yields { delivered:true }; a failure yields
 *      { delivered:false } (auth flows stay resilient, no false success).
 *   4. Credentials/tokens are never hardcoded in the compiled source.
 *
 * nodemailer is stubbed by replacing createTransport on the shared module
 * object BEFORE MailService is required, so no real connection is attempted.
 *
 * Run: node backend/tests/mail_smtp_transport_harness.cjs   (from /app)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', '..', 'apps', 'api');
const apiPaths = [API_DIR, path.join(__dirname, '..', '..')];
const req = (m) => require(require.resolve(m, { paths: apiPaths }));

const MAIL_JS = path.join(API_DIR, 'dist', 'mail', 'mail.service.js');
assert.ok(fs.existsSync(MAIL_JS), 'compiled mail.service.js missing — run `pnpm --filter @cts/api build` first');

// ---- Stub nodemailer (shared module object; default === module for CJS) ----
const nodemailer = req('nodemailer');
let captured = null;
let sendBehavior = 'ok';
nodemailer.createTransport = (opts) => {
  captured = opts;
  return {
    sendMail: async (msg) => {
      captured.lastMessage = msg;
      if (sendBehavior === 'fail') {
        const e = new Error('boom');
        e.code = 'EAUTH';
        throw e;
      }
      return { messageId: '<test-message-id>', accepted: [msg.to], rejected: [] };
    },
    close: () => {},
  };
};

const { MailService } = require(MAIL_JS);

const makeConfig = (map) => ({ get: (k, d) => (map[k] !== undefined ? map[k] : d) });

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('unconfigured → delivered:false and no transporter built', async () => {
  captured = null;
  const svc = new MailService(makeConfig({}));
  assert.strictEqual(svc.isConfigured(), false);
  const res = await svc.sendPasswordResetEmail('user@example.com', 'http://151.242.51.203:3000/reset-password?token=T');
  assert.strictEqual(res.delivered, false);
  assert.strictEqual(captured, null, 'transporter must NOT be created when SMTP is unconfigured');
});

check('configured → Hostinger 587 STARTTLS transport options', async () => {
  captured = null;
  sendBehavior = 'ok';
  const svc = new MailService(makeConfig({
    SMTP_HOST: 'smtp.hostinger.com',
    SMTP_PORT: '587',
    SMTP_USER: 'invest@kamalsecurities.com',
    SMTP_PASS: 'runtime-only-not-committed',
    MAIL_FROM: 'no-reply@kamalsecurities.com',
  }));
  assert.strictEqual(svc.isConfigured(), true);
  const res = await svc.sendVerificationEmail('user@example.com', 'http://151.242.51.203:3000/verify-email?token=T');
  assert.strictEqual(res.delivered, true, 'delivered must be true only after a successful send');
  assert.ok(captured, 'transporter must be created');
  assert.strictEqual(captured.host, 'smtp.hostinger.com');
  assert.strictEqual(captured.port, 587);
  assert.strictEqual(captured.secure, false, 'port 587 must use STARTTLS (secure:false)');
  assert.strictEqual(captured.requireTLS, true, 'must enforce STARTTLS');
  assert.deepStrictEqual(captured.auth, { user: 'invest@kamalsecurities.com', pass: 'runtime-only-not-committed' });
  assert.strictEqual(captured.lastMessage.from, 'no-reply@kamalsecurities.com', 'sender must be MAIL_FROM');
  assert.strictEqual(captured.lastMessage.to, 'user@example.com');
});

check('port 465 → implicit TLS (secure:true, no requireTLS)', async () => {
  captured = null;
  const svc = new MailService(makeConfig({
    SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '465',
    SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'no-reply@kamalsecurities.com',
  }));
  await svc.send({ to: 'x@example.com', subject: 's', text: 't' });
  assert.strictEqual(captured.port, 465);
  assert.strictEqual(captured.secure, true);
  assert.strictEqual(captured.requireTLS, false);
});

check('send failure → delivered:false (no throw, resilient auth flow)', async () => {
  sendBehavior = 'fail';
  const svc = new MailService(makeConfig({
    SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '587',
    SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'no-reply@kamalsecurities.com',
  }));
  const res = await svc.send({ to: 'x@example.com', subject: 's', text: 't' });
  assert.strictEqual(res.delivered, false);
  sendBehavior = 'ok';
});

check('compiled source has no hardcoded secrets and no insecure TLS', () => {
  const src = fs.readFileSync(MAIL_JS, 'utf8');
  assert.ok(/nodemailer/.test(src), 'must use nodemailer');
  assert.ok(!/rejectUnauthorized/.test(src), 'must not disable certificate verification');
  assert.ok(!/smtp\.hostinger\.com/.test(src), 'SMTP host must come from env, not be hardcoded');
  assert.ok(!/kamalsecurities\.com/.test(src), 'no real addresses/credentials hardcoded');
});

(async () => {
  let passed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed += 1;
    } catch (e) {
      console.error(`FAIL: ${name}\n      ${e.message}`);
    }
  }
  console.log(`\n${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exit(1);
})();
