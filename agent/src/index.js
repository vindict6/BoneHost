/*
 * BoneHost node agent
 * -------------------
 * Runs on every game machine. The panel (head unit) never touches Docker or
 * the filesystem directly — it calls this small authenticated HTTP API instead.
 *
 * Stateless by design: every request carries everything the agent needs
 * (container spec inputs, file contents). All state lives in
 * the panel's database; the node can be rebuilt from a panel "re-apply".
 *
 * Env:
 *   AGENT_TOKEN   required — shared secret; panel sends it as a Bearer token
 *   DATA_ROOT     default /srv/bonehost — server data dirs live under $DATA_ROOT/servers
 *   PORT          default 9090
 *   BIND          default 0.0.0.0 (firewall this to the panel / use WireGuard or Tailscale)
 *   SKIP_DOCKER   test mode: no docker calls
 */
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import Docker from 'dockerode';
import mysql from 'mysql2/promise';

const TOKEN = process.env.AGENT_TOKEN;
if (!TOKEN || TOKEN.length < 24) {
  console.error('[agent] AGENT_TOKEN missing or too short (24+ chars). Refusing to start.');
  process.exit(1);
}
const DATA_ROOT = process.env.DATA_ROOT || '/srv/bonehost';
const SERVERS = path.join(DATA_ROOT, 'servers');
const SKIP = process.env.SKIP_DOCKER === '1';
const NAME = id => `bonehost-cs2-${id}`;
const NET = 'bonehost';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const docker = SKIP ? null : new Docker({ socketPath: '/var/run/docker.sock' });
fs.mkdirSync(SERVERS, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));

// ── auth: constant-time bearer token check on every route ──
app.use((req, res, next) => {
  const got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Bad agent token.' });
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e => res.status(400).json({ error: e.message }));
const dir = id => { if (!ID_RE.test(id)) throw new Error('Bad server id.'); return path.join(SERVERS, id); };

/* ── container spec, built entirely from the request payload ── */
function containerSpec(s) {
  const memBytes = s.memory_mb * 1024 * 1024;
  return {
    name: NAME(s.id),
    Image: s.image,
    Hostname: NAME(s.id),
    Env: [
      `SERVER_ID=${s.id}`,
      `GAME_PORT=${s.game_port}`,
      `MAXPLAYERS=${s.slots}`,
      `MAP=${s.map}`,
      `GAME_TYPE=${s.game_type}`,
      `GAME_MODE=${s.game_mode}`,
      `GSLT=${s.gslt}`,
      `UPDATE_ON_START=${s.update_on_start ? '1' : '0'}`,
      `INSTALL_METAMOD=${s.install_metamod ? 1 : 0}`,
      `INSTALL_CSSHARP=${s.install_cssharp ? 1 : 0}`,
      `INSTALL_FAKERCON=${s.install_fakercon ? 1 : 0}`,
      `INSTALL_SIMPLEADMIN=${s.install_simpleadmin ? 1 : 0}`,
      `RCON_PASSWORD=${s.rcon_password}`,
      `SSH_PORT=${s.ssh_port || ''}`,
      `SSH_PASSWORD=${s.ssh_password || ''}`,
      `MM_LATEST_INDEX=${s.mm_latest_index || ''}`,
      `CSS_REPO=${s.css_repo || ''}`,
      `CSS_ASSET_MATCH=${s.css_asset_match || ''}`,
      `PLUGINS_JSON=${JSON.stringify(s.plugins || [])}`,
      ...(s.extra_env || []),
    ],
    HostConfig: {
      Binds: [`${dir(s.id)}:/home/steam/cs2data`],
      CpusetCpus: s.cpuset,                 // hard thread pinning
      Memory: memBytes, MemorySwap: memBytes, // fixed memory, swap off
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: {
        [`${s.game_port}/udp`]: [{ HostPort: String(s.game_port) }],
        [`${s.game_port}/tcp`]: [{ HostPort: String(s.game_port) }], // FakeRcon TCP (node-internal use)
        ...(s.ssh_port ? { [`${s.ssh_port}/tcp`]: [{ HostPort: String(s.ssh_port) }] } : {}), // per-container SSH/SFTP
      },
      NetworkMode: NET,
    },
    ExposedPorts: {
      [`${s.game_port}/udp`]: {}, [`${s.game_port}/tcp`]: {},
      ...(s.ssh_port ? { [`${s.ssh_port}/tcp`]: {} } : {}),
    },
    Labels: { 'bonehost.server': s.id, 'bonehost.owner': String(s.owner_id ?? '') },
  };
}

async function getContainer(id) {
  if (SKIP) return null;
  const c = docker.getContainer(NAME(id));
  try { await c.inspect(); return c; } catch { return null; }
}

async function ensureNetwork() {
  if (SKIP) return;
  try { await docker.getNetwork(NET).inspect(); }
  catch { await docker.createNetwork({ Name: NET }); }
}

function writeFiles(id, files) {
  const base = dir(id);
  let n = 0;
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.resolve(base, rel);
    if (!p.startsWith(base + path.sep)) throw new Error(`Refusing path escape: ${rel}`);
    if (content === null) { fs.rmSync(p, { force: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (rel.endsWith('custom.cfg') && fs.existsSync(p)) continue; // never clobber hand edits
    fs.writeFileSync(p, content);
    n++;
  }
  return n;
}

/* ── routes ── */
app.get('/health', wrap(async (req, res) => {
  let running = null, docker_ok = SKIP ? 'skipped' : false;
  if (!SKIP) {
    try {
      const list = await docker.listContainers({ filters: { label: ['bonehost.server'] } });
      running = list.length; docker_ok = true;
    } catch { /* docker down */ }
  }
  res.json({ ok: true, ts: Date.now(), docker: docker_ok, servers_running: running, data_root: DATA_ROOT });
}));

/**
 * The workhorse. Body: { server: {..spec inputs..}, files: {rel: content},
 * action: 'none'|'ensure'|'recreate'|'start'|'stop'|'restart'|'remove', start: bool }
 * Files are written first so a recreated container boots with fresh config.
 */
app.post('/servers/:id/apply', wrap(async (req, res) => {
  const { server, files, action = 'none', start = false } = req.body || {};
  const id = req.params.id;
  if (!ID_RE.test(id)) throw new Error('Bad server id.');
  fs.mkdirSync(dir(id), { recursive: true });
  const wrote = writeFiles(id, files);

  let did = 'none';
  if (!SKIP && action !== 'none') {
    await ensureNetwork();
    const c = await getContainer(id);
    if (action === 'ensure') {
      const box = c || await docker.createContainer(containerSpec({ ...server, id }));
      if (start) { const info = await box.inspect(); if (!info.State.Running) await box.start(); }
      did = c ? 'existing' : 'created';
    } else if (action === 'recreate') {
      let wasRunning = start;
      if (c) {
        const info = await c.inspect();
        wasRunning = wasRunning || info.State.Running;
        if (info.State.Running) await c.stop({ t: 20 });
        await c.remove();
      }
      const fresh = await docker.createContainer(containerSpec({ ...server, id }));
      if (wasRunning || !c) await fresh.start();
      did = 'recreated';
    } else if (action === 'start') {
      const box = c || await docker.createContainer(containerSpec({ ...server, id }));
      const info = await box.inspect();
      if (!info.State.Running) await box.start();
      did = 'started';
    } else if (action === 'stop') {
      if (c) { try { await c.stop({ t: 20 }); } catch (e) { if (e.statusCode !== 304) throw e; } }
      did = 'stopped';
    } else if (action === 'restart') {
      const box = c || await docker.createContainer(containerSpec({ ...server, id }));
      await box.restart({ t: 20 });
      did = 'restarted';
    } else if (action === 'remove') {
      if (c) { try { await c.stop({ t: 10 }); } catch {} await c.remove(); }
      did = 'removed';
    }
  }
  res.json({ ok: true, files_written: wrote, action: did });
}));

app.get('/servers/:id/state', wrap(async (req, res) => {
  const c = await getContainer(req.params.id);
  if (!c) return res.json({ exists: false, running: false });
  const info = await c.inspect();
  let stats = null;
  if (info.State.Running) {
    try {
      const raw = await c.stats({ stream: false });
      const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
      const sysDelta = raw.cpu_stats.system_cpu_usage - raw.precpu_stats.system_cpu_usage;
      const online = raw.cpu_stats.online_cpus || 1;
      stats = {
        cpu_pct: sysDelta > 0 ? +((cpuDelta / sysDelta) * online * 100).toFixed(1) : 0,
        mem_mb: Math.round((raw.memory_stats.usage || 0) / 1048576),
        mem_limit_mb: Math.round((raw.memory_stats.limit || 0) / 1048576),
      };
    } catch { /* best-effort */ }
  }
  res.json({ exists: true, running: info.State.Running, started_at: info.State.StartedAt, stats });
}));

app.get('/servers/:id/logs', wrap(async (req, res) => {
  const c = await getContainer(req.params.id);
  if (!c) return res.json({ logs: '' });
  const buf = await c.logs({ stdout: true, stderr: true, tail: Math.min(+req.query.lines || 200, 1000) });
  let out = '', i = 0; // demux docker stream headers
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out += buf.slice(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  res.json({ logs: out || buf.toString('utf8') });
}));

/* RCON proxy — the agent reaches the game container over the private docker
 * network by name, so RCON is never exposed off-box. */
app.post('/servers/:id/rcon', wrap(async (req, res) => {
  const { port, password, command } = req.body || {};
  if (!command) throw new Error('No command.');
  const host = SKIP ? '127.0.0.1' : NAME(req.params.id);
  res.json({ output: await rcon(host, port, password, String(command).slice(0, 300)) });
}));

/* Destroy: remove container, keep data 30 days under a .deleted- name. */
app.post('/servers/:id/destroy', wrap(async (req, res) => {
  const id = req.params.id;
  const c = await getContainer(id);
  if (c) { try { await c.stop({ t: 10 }); } catch {} await c.remove(); }
  const d = dir(id);
  if (fs.existsSync(d)) fs.renameSync(d, `${d}.deleted-${Date.now()}`);
  res.json({ ok: true });
}));

/* SimpleAdmin gets its DB from the node-local MariaDB (bonehost-mariadb). */
app.post('/simpleadmin/provision', wrap(async (req, res) => {
  const { server_id, user, password, root_password } = req.body || {};
  if (!ID_RE.test(server_id)) throw new Error('Bad server id.');
  if (SKIP) return res.json({ ok: true, skipped: true });
  const conn = await mysql.createConnection({
    host: 'bonehost-mariadb', user: 'root', password: root_password, connectTimeout: 5000,
  });
  const dbName = `sa_${server_id.replace(/-/g, '_')}`;
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await conn.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [user, password]);
  await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@'%'`, [user]);
  await conn.end();
  res.json({ ok: true, db: dbName });
}));

app.post('/images/pull', wrap(async (req, res) => {
  if (SKIP) return res.json({ ok: true, skipped: true });
  for (const image of req.body?.images || []) {
    try {
      await new Promise((r, j) => docker.pull(image, (e, s) => e ? j(e) : docker.modem.followProgress(s, err => err ? j(err) : r())));
    } catch (e) { console.warn(`[agent] pull ${image} failed: ${e.message}`); }
  }
  res.json({ ok: true });
}));

/* ── minimal Source RCON client (same protocol impl as the panel had) ── */
function rcon(host, port, password, command, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    let buf = Buffer.alloc(0), authed = false, out = '';
    const SENTINEL = 0x7fffffff - 1;
    const pkt = (id, type, body) => {
      const b = Buffer.from(body, 'utf8');
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8);
      b.copy(p, 12);
      return p;
    };
    const fail = e => { sock.destroy(); reject(e instanceof Error ? e : new Error(e)); };
    sock.on('error', e => fail(`RCON connection failed: ${e.message}`));
    sock.on('timeout', () => fail('RCON timed out.'));
    sock.on('connect', () => sock.write(pkt(1, 3, password)));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < 4 + size) break;
        const id = buf.readInt32LE(4), type = buf.readInt32LE(8);
        const body = buf.slice(12, 4 + size - 2).toString('utf8');
        buf = buf.slice(4 + size);
        if (!authed) {
          if (type === 2) {
            if (id === -1) return fail('RCON auth rejected (wrong password).');
            authed = true;
            sock.write(pkt(2, 2, command));
            sock.write(pkt(SENTINEL, 2, ''));
          }
        } else if (id === SENTINEL) { sock.end(); resolve(out.trim()); }
        else out += body;
      }
    });
  });
}

const port = +(process.env.PORT || 9090);
app.listen(port, process.env.BIND || '0.0.0.0', () =>
  console.log(`[agent] bonehost node agent on :${port} (data: ${DATA_ROOT}${SKIP ? ', docker: SKIPPED' : ''})`));
