import { Router } from 'express';
import { cfg, priceCents } from '../config.js';
import { db, audit } from '../db.js';
import { requireAuth, loadOwnedServer } from '../auth.js';
import { provisionServer, sanitizeCvars, writeServerFiles, applyConfigChanges, destroyServer } from '../cs2.js';
import { startServer, stopServer, restartServer, containerState, tailLogs } from '../docker.js';
import { resolveSteamId } from '../steam.js';
import { rcon } from '../rcon.js';
import { createSubscription, createRenewalInvoice, getSubscription, declarePaid } from '../billing.js';
import { latestVersions, runUpdatePass } from '../updates.js';

export const serverRoutes = Router();
serverRoutes.use(requireAuth);

const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.message }));

// ---- listing & pricing ----
serverRoutes.get('/', (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(`SELECT * FROM servers WHERE status != 'deleted' ORDER BY created_at DESC`).all()
    : db.prepare(`SELECT * FROM servers WHERE owner_id=? AND status != 'deleted' ORDER BY created_at DESC`).all(req.user.id);
  res.json(rows.map(publicServer));
});

serverRoutes.get('/pricing', (req, res) => {
  const slots = Math.min(Math.max(parseInt(req.query.slots, 10) || 10, 2), 64);
  res.json({
    slots,
    monthly_cents: priceCents(slots, 'monthly'),
    yearly_cents: priceCents(slots, 'yearly'),
    yearly_months_charged: cfg.billing.yearly_months_charged,
    per_slot_cents: cfg.billing.price_per_slot_cents_monthly,
    currency: cfg.billing.currency,
  });
});

// ---- wizard: resolve steam ids as the user types them ----
serverRoutes.post('/resolve-steam', wrap(async (req, res) => {
  res.json(await resolveSteamId(req.body?.input));
}));

// ---- wizard submit ----
serverRoutes.post('/', wrap(async (req, res) => {
  const w = req.body || {};
  if (!w.name?.trim()) throw new Error('Give the server a name.');
  if (!w.gslt?.trim()) throw new Error('A Game Server Login Token (GSLT) is required — grab one at steamcommunity.com/dev/managegameservers (app 730).');
  const plan = w.plan === 'yearly' ? 'yearly' : 'monthly';

  const admins = [];
  for (const a of (w.admins || []).slice(0, 20)) {
    const r = await resolveSteamId(a.input);
    admins.push({ steamid64: r.steamid64, label: a.label || r.persona || r.steamid64, flags: a.flags || '@css/generic' });
  }

  const server = await provisionServer(req.user, { ...w, admins });
  const sub = createSubscription(req.user, server, plan);
  let invoice = null, billing_note = null;
  try { invoice = await createRenewalInvoice(sub); }
  catch (e) { billing_note = e.message; }

  audit(req.user.id, req.ip, 'server.created', server.id, { plan });
  res.json({ server: publicServer(server), subscription: sub, invoice, billing_note,
    note: 'The server starts automatically once the first invoice settles.' });
}));

// ---- per-server ----
serverRoutes.get('/:id', loadOwnedServer, wrap(async (req, res) => {
  const s = req.server;
  const state = await containerState(s).catch(() => ({ exists: false, running: false }));
  const sub = getSubscription(s.id);
  const schedule = db.prepare(`SELECT * FROM update_schedules WHERE server_id=?`).get(s.id);
  const admins = db.prepare(`SELECT * FROM server_admins WHERE server_id=?`).all(s.id);
  const txs = db.prepare(`SELECT id, invoice_id, checkout_url, plan, amount_cents, currency, period_start, period_end, status, created_at, settled_at
    FROM transactions WHERE server_id=? ORDER BY id DESC LIMIT 24`).all(s.id);
  res.json({
    server: { ...publicServer(s), rcon_password: s.rcon_password, cfg_overrides: JSON.parse(s.cfg_overrides), gslt_set: !!s.gslt },
    state, subscription: sub, schedule, admins, transactions: txs,
    connect: `connect ${cfg.network.public_host}:${s.game_port}${s.sv_password ? `; password ${s.sv_password}` : ''}`,
    ftp: { host: cfg.network.public_host, port: cfg.network.sftp_port, protocol: 'sftp', user: s.ftp_user, password: s.ftp_password, path: '/cs2' },
    default_cfg: cfg.cs2.default_cfg,
  });
}));

function guardPaid(s) {
  if (s.status === 'suspended') throw new Error('This server is suspended for non-payment. Settle the open invoice and it restarts automatically.');
}

serverRoutes.post('/:id/start', loadOwnedServer, wrap(async (req, res) => {
  guardPaid(req.server);
  const sub = getSubscription(req.server.id);
  if (!sub || sub.paid_until < Date.now()) throw new Error('Payment required before the server can start. Check the Billing tab for your invoice.');
  await startServer(req.server);
  db.prepare(`UPDATE servers SET status='running' WHERE id=?`).run(req.server.id);
  audit(req.user.id, req.ip, 'server.start', req.server.id);
  res.json({ ok: true });
}));

serverRoutes.post('/:id/stop', loadOwnedServer, wrap(async (req, res) => {
  await stopServer(req.server);
  if (req.server.status !== 'suspended') db.prepare(`UPDATE servers SET status='stopped' WHERE id=?`).run(req.server.id);
  audit(req.user.id, req.ip, 'server.stop', req.server.id);
  res.json({ ok: true });
}));

serverRoutes.post('/:id/restart', loadOwnedServer, wrap(async (req, res) => {
  guardPaid(req.server);
  await restartServer(req.server);
  db.prepare(`UPDATE servers SET status='running' WHERE id=?`).run(req.server.id);
  audit(req.user.id, req.ip, 'server.restart', req.server.id);
  res.json({ ok: true });
}));

serverRoutes.get('/:id/logs', loadOwnedServer, wrap(async (req, res) => {
  res.json({ logs: await tailLogs(req.server, Math.min(+req.query.lines || 200, 1000)) });
}));

serverRoutes.post('/:id/rcon', loadOwnedServer, wrap(async (req, res) => {
  guardPaid(req.server);
  const cmd = String(req.body?.command || '').slice(0, 300);
  if (!cmd) throw new Error('Enter a command.');
  const out = await rcon('127.0.0.1', req.server.game_port, req.server.rcon_password, cmd);
  audit(req.user.id, req.ip, 'server.rcon', req.server.id, { cmd });
  res.json({ output: out || '(no output)' });
}));

// ---- settings ----
serverRoutes.patch('/:id/settings', loadOwnedServer, wrap(async (req, res) => {
  guardPaid(req.server);
  const b = req.body || {};
  const s = req.server;
  const updates = {
    name: b.name !== undefined ? String(b.name).slice(0, 60) : s.name,
    map: b.map !== undefined ? String(b.map).replace(/[^a-z0-9_]/gi, '').slice(0, 60) || s.map : s.map,
    game_type: Number.isInteger(+b.game_type) ? +b.game_type : s.game_type,
    game_mode: Number.isInteger(+b.game_mode) ? +b.game_mode : s.game_mode,
    sv_password: b.sv_password !== undefined ? String(b.sv_password).slice(0, 60) : s.sv_password,
    gslt: b.gslt ? String(b.gslt).trim() : s.gslt,
    cfg_overrides: b.cfg_overrides !== undefined ? JSON.stringify(sanitizeCvars(b.cfg_overrides)) : s.cfg_overrides,
    install_metamod: b.install_metamod !== undefined ? (b.install_metamod ? 1 : 0) : s.install_metamod,
    install_cssharp: b.install_cssharp !== undefined ? (b.install_cssharp ? 1 : 0) : s.install_cssharp,
    install_fakercon: b.install_fakercon !== undefined ? (b.install_fakercon ? 1 : 0) : s.install_fakercon,
    install_simpleadmin: b.install_simpleadmin !== undefined ? (b.install_simpleadmin ? 1 : 0) : s.install_simpleadmin,
  };
  db.prepare(`UPDATE servers SET name=@name, map=@map, game_type=@game_type, game_mode=@game_mode,
    sv_password=@sv_password, gslt=@gslt, cfg_overrides=@cfg_overrides, install_metamod=@install_metamod,
    install_cssharp=@install_cssharp, install_fakercon=@install_fakercon, install_simpleadmin=@install_simpleadmin
    WHERE id=@id`).run({ ...updates, id: s.id });
  const fresh = db.prepare(`SELECT * FROM servers WHERE id=?`).get(s.id);
  if (b.apply_now) await applyConfigChanges(fresh); else writeServerFiles(fresh);
  audit(req.user.id, req.ip, 'server.settings', s.id, { applied: !!b.apply_now });
  res.json({ ok: true, applied: !!b.apply_now });
}));

// ---- admins (steam links or ids) ----
serverRoutes.post('/:id/admins', loadOwnedServer, wrap(async (req, res) => {
  const r = await resolveSteamId(req.body?.input);
  const flags = String(req.body?.flags || '@css/generic').slice(0, 200);
  db.prepare(`INSERT OR REPLACE INTO server_admins (server_id, steamid64, label, flags) VALUES (?,?,?,?)`)
    .run(req.server.id, r.steamid64, String(req.body?.label || r.persona || '').slice(0, 60), flags);
  writeServerFiles(db.prepare(`SELECT * FROM servers WHERE id=?`).get(req.server.id));
  audit(req.user.id, req.ip, 'server.admin_added', req.server.id, { steamid64: r.steamid64 });
  res.json({ ok: true, steamid64: r.steamid64, persona: r.persona, note: 'Applied on next map change or restart.' });
}));

serverRoutes.delete('/:id/admins/:steamid', loadOwnedServer, wrap(async (req, res) => {
  db.prepare(`DELETE FROM server_admins WHERE server_id=? AND steamid64=?`).run(req.server.id, req.params.steamid);
  writeServerFiles(db.prepare(`SELECT * FROM servers WHERE id=?`).get(req.server.id));
  audit(req.user.id, req.ip, 'server.admin_removed', req.server.id, { steamid64: req.params.steamid });
  res.json({ ok: true });
}));

// ---- updates ----
serverRoutes.get('/:id/updates/latest', loadOwnedServer, wrap(async (req, res) => {
  res.json(await latestVersions());
}));

serverRoutes.put('/:id/updates/schedule', loadOwnedServer, wrap(async (req, res) => {
  const b = req.body || {};
  db.prepare(`UPDATE update_schedules SET enabled=?, day_of_week=?, hour=?, include_metamod=?, include_cssharp=? WHERE server_id=?`)
    .run(b.enabled ? 1 : 0, clamp(b.day_of_week, 0, 6, 3), clamp(b.hour, 0, 23, 5),
      b.include_metamod ? 1 : 0, b.include_cssharp ? 1 : 0, req.server.id);
  audit(req.user.id, req.ip, 'server.schedule_set', req.server.id, b);
  res.json({ ok: true });
}));

serverRoutes.post('/:id/updates/run', loadOwnedServer, wrap(async (req, res) => {
  guardPaid(req.server);
  const b = req.body || {};
  // game=true -> full pass; addons only -> independent addon push
  await runUpdatePass(req.server, { metamod: !!b.metamod, cssharp: !!b.cssharp }, req.user.id);
  db.prepare(`UPDATE servers SET status='running' WHERE id=?`).run(req.server.id);
  res.json({ ok: true, note: 'Update pass started — the server restarts and comes back in a few minutes.' });
}));

// ---- billing ----
serverRoutes.post('/:id/billing/invoice', loadOwnedServer, wrap(async (req, res) => {
  let sub = getSubscription(req.server.id);
  if (!sub) sub = createSubscription(req.user, req.server, req.body?.plan === 'yearly' ? 'yearly' : 'monthly');
  res.json(await createRenewalInvoice(sub, req.user.id));
}));

// "I've sent it" — flips an open manual invoice to processing and notifies the admin.
serverRoutes.post('/:id/billing/declare', loadOwnedServer, wrap(async (req, res) => {
  const tx = db.prepare(`SELECT * FROM transactions WHERE server_id=? AND status IN ('open','processing') ORDER BY id DESC LIMIT 1`)
    .get(req.server.id);
  if (!tx) throw new Error('No open invoice on this server.');
  res.json(declarePaid(tx, req.user.id));
}));

serverRoutes.post('/:id/billing/plan', loadOwnedServer, wrap(async (req, res) => {
  // Plan change takes effect at next renewal: cancel pending, open a new sub shell.
  const plan = req.body?.plan === 'yearly' ? 'yearly' : 'monthly';
  const old = getSubscription(req.server.id);
  const carried = old?.paid_until || 0;
  if (old) db.prepare(`UPDATE subscriptions SET status='canceled' WHERE id=?`).run(old.id);
  const sub = createSubscription(req.user, req.server, plan);
  db.prepare(`UPDATE subscriptions SET paid_until=?, status=? WHERE id=?`)
    .run(carried, carried > Date.now() ? 'active' : 'pending', sub.id);
  audit(req.user.id, req.ip, 'billing.plan_changed', req.server.id, { plan });
  res.json({ ok: true, plan });
}));

serverRoutes.delete('/:id', loadOwnedServer, wrap(async (req, res) => {
  await destroyServer(req.server, req.user.id);
  res.json({ ok: true });
}));

function clamp(v, lo, hi, dflt) { const n = parseInt(v, 10); return Number.isInteger(n) ? Math.min(Math.max(n, lo), hi) : dflt; }

function publicServer(s) {
  return {
    id: s.id, name: s.name, owner_id: s.owner_id, slots: s.slots, game_port: s.game_port,
    cpuset: s.cpuset, memory_mb: s.memory_mb, map: s.map, game_type: s.game_type, game_mode: s.game_mode,
    status: s.status, suspended_reason: s.suspended_reason, created_at: s.created_at,
    install_metamod: !!s.install_metamod, install_cssharp: !!s.install_cssharp,
    install_fakercon: !!s.install_fakercon, install_simpleadmin: !!s.install_simpleadmin,
    sv_password_set: !!s.sv_password,
  };
}
