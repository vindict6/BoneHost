import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth.js';
import { db, audit } from '../db.js';
import { nodeUsage } from '../allocator.js';
import { nodes, nodeHealth } from '../nodes.js';
import { mintInvite } from './auth.js';
import { transactionsCsv, confirmTransaction, voidTransaction } from '../billing.js';
import { startServer, stopServer, restartServer, containerState, rconExec } from '../nodes.js';
import { allLiveServers, destroyServer } from '../cs2.js';
import { latestVersions, runUpdatePass } from '../updates.js';

export const adminRoutes = Router();
adminRoutes.use(requireAuth, requireAdmin);

const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.message }));

adminRoutes.get('/overview', wrap(async (req, res) => {
  const servers = allLiveServers();
  const states = await Promise.all(servers.map(s => containerState(s).catch(() => ({ exists: false, running: false }))));
  const subs = db.prepare(`SELECT s.*, u.email FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.status != 'canceled'`).all();
  const nodeList = nodes();
  const health = await Promise.all(nodeList.map(n => nodeHealth(n)));
  res.json({
    nodes: nodeList.map((n, i) => ({ ...nodeUsage(n.id), health: health[i] })),
    versions: await latestVersions(),
    servers: servers.map((s, i) => ({
      id: s.id, name: s.name, owner_id: s.owner_id, node_id: s.node_id, slots: s.slots, game_port: s.game_port,
      cpuset: s.cpuset, memory_mb: s.memory_mb, status: s.status, suspended_reason: s.suspended_reason,
      state: states[i],
      subscription: subs.find(x => x.server_id === s.id) || null,
    })),
    users: db.prepare(`SELECT id, email, role, disabled, created_at FROM users`).all(),
    invites: db.prepare(`SELECT * FROM invites ORDER BY created_at DESC LIMIT 50`).all(),
  });
}));

adminRoutes.post('/invites', (req, res) => {
  const code = mintInvite(req.user.id);
  audit(req.user.id, req.ip, 'admin.invite_minted', code);
  res.json({ code });
});

adminRoutes.post('/users/:id/disable', wrap(async (req, res) => {
  const target = db.prepare(`SELECT * FROM users WHERE id=?`).get(+req.params.id);
  if (!target) return res.status(404).json({ error: 'No such user.' });
  if (target.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be disabled from the panel.' });
  const disabled = req.body?.disabled ? 1 : 0;
  db.prepare(`UPDATE users SET disabled=? WHERE id=?`).run(disabled, target.id);
  if (disabled) {
    for (const s of db.prepare(`SELECT * FROM servers WHERE owner_id=? AND status='running'`).all(target.id)) {
      await stopServer(s).catch(() => {});
      db.prepare(`UPDATE servers SET status='stopped' WHERE id=?`).run(s.id);
    }
  }
  audit(req.user.id, req.ip, disabled ? 'admin.user_disabled' : 'admin.user_enabled', String(target.id));
  res.json({ ok: true });
}));

// Admin overrides on any server (suspend/unsuspend/comp time/force stop)
adminRoutes.post('/servers/:id/suspend', wrap(async (req, res) => {
  const s = db.prepare(`SELECT * FROM servers WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such server.' });
  await stopServer(s).catch(() => {});
  db.prepare(`UPDATE servers SET status='suspended', suspended_reason=? WHERE id=?`)
    .run(String(req.body?.reason || 'admin'), s.id);
  audit(req.user.id, req.ip, 'admin.suspend', s.id, { reason: req.body?.reason });
  res.json({ ok: true });
}));

adminRoutes.post('/servers/:id/unsuspend', wrap(async (req, res) => {
  const s = db.prepare(`SELECT * FROM servers WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such server.' });
  db.prepare(`UPDATE servers SET status='stopped', suspended_reason=NULL WHERE id=?`).run(s.id);
  if (req.body?.start) { await startServer(s); db.prepare(`UPDATE servers SET status='running' WHERE id=?`).run(s.id); }
  audit(req.user.id, req.ip, 'admin.unsuspend', s.id);
  res.json({ ok: true });
}));

adminRoutes.post('/servers/:id/comp', wrap(async (req, res) => {
  // Grant free days (comp time) — extends paid_until, fully audited.
  const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 0, 1), 400);
  const sub = db.prepare(`SELECT * FROM subscriptions WHERE server_id=? AND status != 'canceled' ORDER BY id DESC LIMIT 1`).get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'No subscription on that server.' });
  const base = Math.max(sub.paid_until, Date.now());
  db.prepare(`UPDATE subscriptions SET paid_until=?, status='active' WHERE id=?`).run(base + days * 864e5, sub.id);
  audit(req.user.id, req.ip, 'admin.comp_time', req.params.id, { days });
  res.json({ ok: true, paid_until: base + days * 864e5 });
}));

adminRoutes.delete('/servers/:id', wrap(async (req, res) => {
  const s = db.prepare(`SELECT * FROM servers WHERE id=?`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such server.' });
  await destroyServer(s, req.user.id);
  res.json({ ok: true });
}));

/**
 * Fleet actions — the "manage everything from my end" endpoint.
 * body: {
 *   action: 'start'|'stop'|'restart'|'update'|'rcon',
 *   server_ids: [...] | 'all',
 *   node_id?: only servers on this node,
 *   opts?: { metamod, cssharp }   (update passes),
 *   command?: 'say hi'            (broadcast rcon),
 * }
 * Runs across the selection with per-server results, fully audited.
 */
adminRoutes.post('/fleet', wrap(async (req, res) => {
  const b = req.body || {};
  const action = String(b.action || '');
  if (!['start', 'stop', 'restart', 'update', 'rcon'].includes(action)) throw new Error('Unknown fleet action.');
  if (action === 'rcon' && !String(b.command || '').trim()) throw new Error('Broadcast needs a command.');

  let servers = allLiveServers();
  if (b.node_id) servers = servers.filter(s => s.node_id === b.node_id);
  if (Array.isArray(b.server_ids)) {
    const want = new Set(b.server_ids);
    servers = servers.filter(s => want.has(s.id));
  }
  if (!servers.length) throw new Error('Selection matched no servers.');

  audit(req.user.id, req.ip, `admin.fleet_${action}`, b.node_id || 'fleet',
    { count: servers.length, ids: servers.map(s => s.id), opts: b.opts, command: b.command });

  const results = [];
  for (const s of servers) {
    try {
      if (action === 'start') {
        if (s.status === 'suspended') throw new Error('suspended — skipped');
        await startServer(s);
        db.prepare(`UPDATE servers SET status='running' WHERE id=?`).run(s.id);
        results.push({ id: s.id, ok: true, detail: 'started' });
      } else if (action === 'stop') {
        await stopServer(s);
        if (s.status !== 'suspended') db.prepare(`UPDATE servers SET status='stopped' WHERE id=?`).run(s.id);
        results.push({ id: s.id, ok: true, detail: 'stopped' });
      } else if (action === 'restart') {
        await restartServer(s);
        results.push({ id: s.id, ok: true, detail: 'restarted' });
      } else if (action === 'update') {
        await runUpdatePass(s, { metamod: !!b.opts?.metamod, cssharp: !!b.opts?.cssharp }, req.user.id);
        db.prepare(`UPDATE servers SET status='running' WHERE id=?`).run(s.id);
        results.push({ id: s.id, ok: true, detail: 'update pass started' });
      } else if (action === 'rcon') {
        const out = await rconExec(s, String(b.command).slice(0, 300));
        results.push({ id: s.id, ok: true, detail: (out || '(no output)').slice(0, 400) });
      }
    } catch (e) { results.push({ id: s.id, ok: false, detail: e.message }); }
  }
  res.json({ ok: true, action, results });
}));

// Manual-provider settlement: admin saw the Venmo/Cash App payment land, confirm it.
adminRoutes.post('/transactions/:id/confirm', wrap(async (req, res) => {
  const tx = db.prepare(`SELECT * FROM transactions WHERE id=?`).get(+req.params.id);
  if (!tx) return res.status(404).json({ error: 'No such transaction.' });
  res.json(await confirmTransaction(tx, req.user.id));
}));

adminRoutes.post('/transactions/:id/void', wrap(async (req, res) => {
  const tx = db.prepare(`SELECT * FROM transactions WHERE id=?`).get(+req.params.id);
  if (!tx) return res.status(404).json({ error: 'No such transaction.' });
  res.json(voidTransaction(tx, req.user.id));
}));

adminRoutes.get('/transactions', (req, res) => {
  res.json(db.prepare(`SELECT t.*, u.email FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 500`).all());
});

adminRoutes.get('/transactions.csv', (req, res) => {
  audit(req.user.id, req.ip, 'admin.ledger_export');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bonehost-ledger.csv"');
  res.send(transactionsCsv());
});

adminRoutes.get('/audit', (req, res) => {
  res.json(db.prepare(`SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`).all());
});
