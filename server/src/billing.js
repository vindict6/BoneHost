import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { cfg, env, priceCents, periodMs, ledgerDir } from './config.js';
import { db, audit } from './db.js';
import { stopServer, startServer } from './docker.js';

/*
 * Billing providers
 * -----------------
 * "manual"  (default) — Venmo / Cash App. Personal accounts on those apps have
 *           no API or webhooks, so settlement detection is human: the panel
 *           opens an invoice with a unique code, the payer sends the money with
 *           that code in the note, and the admin taps Confirm when the payment
 *           notification lands. Everything around that tap — renewal invoices,
 *           reminders, the grace window, automatic suspension, automatic
 *           restart on confirmation, the ledger — is fully automated.
 * "btcpay"  — self-hosted BTCPay Server. Fully automated end to end via
 *           HMAC-verified webhooks. Kept as an option.
 */

const provider = () => cfg.billing.provider || 'manual';
const btcpayReady = () => env.btcpay.url && env.btcpay.apiKey && env.btcpay.storeId;
const manualReady = () => !!(cfg.billing.manual?.venmo_username || cfg.billing.manual?.cashapp_cashtag);
export const billingReady = () => provider() === 'btcpay' ? btcpayReady() : manualReady();

const OPEN_STATUSES = ['open', 'new', 'processing'];

async function btcpay(method, endpoint, body) {
  const r = await fetch(`${env.btcpay.url}/api/v1/stores/${env.btcpay.storeId}${endpoint}`, {
    method,
    headers: { Authorization: `token ${env.btcpay.apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`BTCPay ${method} ${endpoint} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export function getSubscription(serverId) {
  return db.prepare(`SELECT * FROM subscriptions WHERE server_id=? AND status != 'canceled' ORDER BY id DESC LIMIT 1`).get(serverId);
}

export function createSubscription(user, server, plan) {
  const price = priceCents(server.slots, plan);
  const info = db.prepare(`INSERT INTO subscriptions (server_id, user_id, plan, price_cents, paid_until, status, created_at)
    VALUES (?,?,?,?,0,'pending',?)`).run(server.id, user.id, plan, price, Date.now());
  return db.prepare(`SELECT * FROM subscriptions WHERE id=?`).get(info.lastInsertRowid);
}

/** Unambiguous, human-friendly invoice code (no 0/O/1/I). */
function invoiceCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = 'BH-';
    for (const b of crypto.randomBytes(6)) code += alphabet[b % alphabet.length];
    if (!db.prepare(`SELECT 1 FROM transactions WHERE invoice_id=?`).get(code)) return code;
  }
}

/** Payment is always for the period ahead (upfront). One open invoice per subscription. */
export async function createRenewalInvoice(sub, actorId = null) {
  if (!billingReady()) {
    throw new Error(provider() === 'btcpay'
      ? 'Billing is not configured yet (BTCPay env vars missing). Ask the admin.'
      : 'Billing is not configured yet (no Venmo/Cash App handle in config.json). Ask the admin.');
  }

  const open = db.prepare(`SELECT * FROM transactions WHERE subscription_id=? AND status IN ('open','new','processing')
    ORDER BY id DESC LIMIT 1`).get(sub.id);
  if (open) return open; // one open invoice at a time

  const periodStart = Math.max(sub.paid_until, Date.now());
  const periodEnd = periodStart + periodMs(sub.plan);
  const amount = (sub.price_cents / 100).toFixed(2);

  let row;
  if (provider() === 'btcpay') {
    const inv = await btcpay('POST', '/invoices', {
      amount, currency: cfg.billing.currency,
      metadata: {
        orderId: `sub-${sub.id}`,
        subscriptionId: sub.id, serverId: sub.server_id, userId: sub.user_id,
        plan: sub.plan, periodStart, periodEnd, itemDesc: `BoneHost ${sub.server_id} — ${sub.plan}`,
      },
      checkout: { expirationMinutes: 60 * 24, redirectURL: `${cfg.panel.url}/#/billing` },
    });
    db.prepare(`INSERT INTO transactions (subscription_id, user_id, server_id, provider, invoice_id, checkout_url,
        plan, amount_cents, currency, period_start, period_end, status, raw_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, 'new', ?, ?)`)
      .run(sub.id, sub.user_id, sub.server_id, 'btcpay', inv.id, inv.checkoutLink,
        sub.plan, sub.price_cents, cfg.billing.currency, periodStart, periodEnd,
        JSON.stringify(inv), Date.now());
    row = db.prepare(`SELECT * FROM transactions WHERE invoice_id=?`).get(inv.id);
    audit(actorId ?? sub.user_id, null, 'billing.invoice_created', sub.server_id, { invoice: inv.id, amount });
  } else {
    const code = invoiceCode();
    db.prepare(`INSERT INTO transactions (subscription_id, user_id, server_id, provider, invoice_id, checkout_url,
        plan, amount_cents, currency, period_start, period_end, status, raw_json, created_at)
      VALUES (?,?,?,?,?,NULL,?,?,?,?,?, 'open', ?, ?)`)
      .run(sub.id, sub.user_id, sub.server_id, 'manual', code,
        sub.plan, sub.price_cents, cfg.billing.currency, periodStart, periodEnd,
        JSON.stringify({ code, created_by: actorId ?? sub.user_id }), Date.now());
    row = db.prepare(`SELECT * FROM transactions WHERE invoice_id=?`).get(code);
    audit(actorId ?? sub.user_id, null, 'billing.invoice_created', sub.server_id, { invoice: code, amount });
    const payer = db.prepare(`SELECT email FROM users WHERE id=?`).get(sub.user_id);
    notifyAdmins('billing', `Invoice ${code} open: ${payer?.email || sub.user_id} owes $${amount} for ${sub.server_id} (${sub.plan}). Confirm it in Admin \u203a Ledger when the payment lands.`);
  }
  appendLedger({ ...row, event_type: 'invoice_created', event_at: Date.now() });
  return row;
}

/** Subscriber pressed "I've sent it" — flips an open manual invoice to processing and pings the admin. */
export function declarePaid(tx, userId) {
  if (tx.provider !== 'manual') throw new Error('Only manual invoices can be declared.');
  if (tx.status !== 'open') return tx;
  db.prepare(`UPDATE transactions SET status='processing' WHERE id=?`).run(tx.id);
  audit(userId, null, 'billing.declared_paid', tx.server_id, { invoice: tx.invoice_id });
  const payer = db.prepare(`SELECT email FROM users WHERE id=?`).get(tx.user_id);
  notifyAdmins('billing', `${payer?.email || tx.user_id} says they sent $${(tx.amount_cents / 100).toFixed(2)} for invoice ${tx.invoice_id} (${tx.server_id}). Check Venmo/Cash App and confirm in Admin \u203a Ledger.`);
  appendLedger({ ...tx, status: 'processing', event_type: 'declared_paid', event_at: Date.now() });
  return db.prepare(`SELECT * FROM transactions WHERE id=?`).get(tx.id);
}

/** Shared settle path: extends paid_until a full period and revives suspended servers. */
export async function settleTransaction(tx, meta = {}) {
  if (tx.status === 'settled') return tx;
  db.prepare(`UPDATE transactions SET status='settled', settled_at=?, raw_json=? WHERE id=?`)
    .run(Date.now(), JSON.stringify({ ...JSON.parse(tx.raw_json || '{}'), ...meta }), tx.id);
  appendLedger({ ...tx, status: 'settled', ...meta, event_type: 'settled', event_at: Date.now() });

  const sub = db.prepare(`SELECT * FROM subscriptions WHERE id=?`).get(tx.subscription_id);
  const newPaidUntil = Math.max(sub.paid_until, tx.period_start) + (tx.period_end - tx.period_start);
  db.prepare(`UPDATE subscriptions SET paid_until=?, status='active' WHERE id=?`).run(newPaidUntil, sub.id);
  audit(meta.confirmed_by ?? null, null, 'billing.settled', tx.server_id, { invoice: tx.invoice_id, paid_until: newPaidUntil });

  // Auto-unsuspend on payment.
  const server = db.prepare(`SELECT * FROM servers WHERE id=?`).get(tx.server_id);
  if (server?.status === 'suspended' && server.suspended_reason === 'past_due') {
    db.prepare(`UPDATE servers SET status='stopped', suspended_reason=NULL WHERE id=?`).run(server.id);
    try { await startServer(server); db.prepare(`UPDATE servers SET status='running' WHERE id=?`).run(server.id); }
    catch (e) { console.error(`[billing] auto-restart failed for ${server.id}: ${e.message}`); }
    notify(sub.user_id, 'billing', `Payment received — ${server.name} is back online.`);
  } else {
    notify(sub.user_id, 'billing', `Payment received. ${tx.server_id} is paid through ${new Date(newPaidUntil).toLocaleDateString()}.`);
  }
  return db.prepare(`SELECT * FROM transactions WHERE id=?`).get(tx.id);
}

/** Admin confirms a manual payment arrived in Venmo/Cash App. */
export async function confirmTransaction(tx, adminId) {
  if (!OPEN_STATUSES.includes(tx.status)) throw new Error(`Invoice is ${tx.status} — nothing to confirm.`);
  return settleTransaction(tx, { confirmed_by: adminId, confirmed_at: Date.now() });
}

/** Admin voids a mistaken/abandoned invoice; a fresh one can then be created. */
export function voidTransaction(tx, adminId) {
  if (!OPEN_STATUSES.includes(tx.status)) throw new Error(`Invoice is ${tx.status} — only open invoices can be voided.`);
  db.prepare(`UPDATE transactions SET status='void' WHERE id=?`).run(tx.id);
  audit(adminId, null, 'billing.voided', tx.server_id, { invoice: tx.invoice_id });
  appendLedger({ ...tx, status: 'void', voided_by: adminId, event_type: 'voided', event_at: Date.now() });
  notify(tx.user_id, 'billing', `Invoice ${tx.invoice_id} for ${tx.server_id} was voided by the admin.`);
  return db.prepare(`SELECT * FROM transactions WHERE id=?`).get(tx.id);
}

/* ── BTCPay webhook path (only when provider = "btcpay") ── */
export function verifyWebhook(rawBody, sigHeader) {
  if (!env.btcpay.webhookSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', env.btcpay.webhookSecret).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader || '')); }
  catch { return false; }
}

export async function handleWebhook(event) {
  const tx = db.prepare(`SELECT * FROM transactions WHERE invoice_id=?`).get(event.invoiceId);
  if (!tx) return; // not ours
  const map = { InvoiceProcessing: 'processing', InvoiceSettled: 'settled', InvoiceExpired: 'expired', InvoiceInvalid: 'invalid' };
  const next = map[event.type];
  if (!next) return;
  if (next === 'settled') return settleTransaction(tx, { webhook: event.type });
  db.prepare(`UPDATE transactions SET status=?, raw_json=? WHERE id=?`).run(next, JSON.stringify(event), tx.id);
  appendLedger({ ...tx, status: next, event_type: event.type, event_at: Date.now() });
}

/** Append-only JSONL ledger on disk, one file per month, alongside the DB rows. */
function appendLedger(record) {
  const file = path.join(ledgerDir, `ledger-${new Date().toISOString().slice(0, 7)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

export function transactionsCsv() {
  const rows = db.prepare(`SELECT t.*, u.email FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id`).all();
  const head = 'id,created_at,settled_at,email,server_id,plan,amount,currency,status,provider,invoice_id,period_start,period_end';
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [head, ...rows.map(t => [
    t.id, new Date(t.created_at).toISOString(), t.settled_at ? new Date(t.settled_at).toISOString() : '',
    t.email, t.server_id, t.plan, (t.amount_cents / 100).toFixed(2), t.currency, t.status, t.provider, t.invoice_id,
    new Date(t.period_start).toISOString(), new Date(t.period_end).toISOString(),
  ].map(esc).join(','))].join('\n');
}

function notify(userId, kind, body) {
  db.prepare(`INSERT INTO notices (user_id, ts, kind, body) VALUES (?,?,?,?)`).run(userId, Date.now(), kind, body);
}
function notifyAdmins(kind, body) {
  for (const a of db.prepare(`SELECT id FROM users WHERE role='admin' AND disabled=0`).all()) notify(a.id, kind, body);
}

/**
 * Hourly pass, and the single mechanism for monthly AND yearly plans because
 * everything reduces to the absolute `paid_until` timestamp:
 *  - inside renewal window  -> ensure an open invoice exists + notice
 *  - past due within grace  -> mark past_due + notice
 *  - past grace             -> stop container, suspend server
 * Provider-agnostic: only the settle signal differs (webhook vs admin confirm).
 */
export function startBillingCron() {
  cron.schedule('15 * * * *', async () => {  // hourly; idempotent
    const now = Date.now();
    const grace = cfg.billing.grace_days * 864e5;
    const noticeWin = cfg.billing.renewal_notice_days * 864e5;
    const subs = db.prepare(`SELECT * FROM subscriptions WHERE status IN ('active','past_due','pending')`).all();

    for (const sub of subs) {
      const server = db.prepare(`SELECT * FROM servers WHERE id=? AND status != 'deleted'`).get(sub.server_id);
      if (!server) continue;

      if (sub.status !== 'pending' && sub.paid_until - now <= noticeWin && sub.paid_until > now) {
        try {
          const hadOpen = db.prepare(`SELECT 1 FROM transactions WHERE subscription_id=? AND status IN ('open','new','processing')`).get(sub.id);
          if (!hadOpen && billingReady()) {
            const tx = await createRenewalInvoice(sub);
            notify(sub.user_id, 'billing', tx.checkout_url
              ? `Renewal for ${server.name} is due ${new Date(sub.paid_until).toLocaleDateString()}. Pay here: ${tx.checkout_url}`
              : `Renewal for ${server.name} is due ${new Date(sub.paid_until).toLocaleDateString()}. Invoice ${tx.invoice_id} — payment instructions are on the server's Billing tab.`);
          }
        } catch (e) { console.error(`[billing] renewal invoice failed for sub ${sub.id}: ${e.message}`); }
      }

      if (now > sub.paid_until && now <= sub.paid_until + grace && sub.status === 'active') {
        db.prepare(`UPDATE subscriptions SET status='past_due' WHERE id=?`).run(sub.id);
        notify(sub.user_id, 'billing', `${server.name} is past due. It will be suspended in ${cfg.billing.grace_days} days if unpaid.`);
        audit(null, null, 'billing.past_due', server.id);
      }

      if (now > sub.paid_until + grace && server.status !== 'suspended' && sub.status !== 'pending') {
        try {
          await stopServer(server);
          db.prepare(`UPDATE servers SET status='suspended', suspended_reason='past_due' WHERE id=?`).run(server.id);
          notify(sub.user_id, 'billing', `${server.name} was suspended for non-payment. Settle the open invoice to restore it automatically.`);
          audit(null, null, 'billing.suspended', server.id);
        } catch (e) { console.error(`[billing] suspend failed for ${server.id}: ${e.message}`); }
      }
    }
  });
}
