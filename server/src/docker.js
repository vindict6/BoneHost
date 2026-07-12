import Docker from 'dockerode';
import path from 'node:path';
import { cfg, serversRoot, env } from './config.js';

export const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const NAME = id => `bonehost-cs2-${id}`;
const SFTP = 'bonehost-sftp';
const NET = 'bonehost';

export function serverDir(id) { return path.join(serversRoot, id); }

function containerSpec(s) {
  const dir = serverDir(s.id);
  const memBytes = s.memory_mb * 1024 * 1024;
  return {
    name: NAME(s.id),
    Image: cfg.cs2.image,
    Hostname: NAME(s.id),
    Env: [
      `SERVER_ID=${s.id}`,
      `GAME_PORT=${s.game_port}`,
      `MAXPLAYERS=${s.slots}`,
      `MAP=${s.map}`,
      `GAME_TYPE=${s.game_type}`,
      `GAME_MODE=${s.game_mode}`,
      `GSLT=${s.gslt}`,
      `UPDATE_ON_START=${cfg.cs2.update_on_start ? '1' : '0'}`,
      `INSTALL_METAMOD=${s.install_metamod}`,
      `INSTALL_CSSHARP=${s.install_cssharp}`,
      `INSTALL_FAKERCON=${s.install_fakercon}`,
      `INSTALL_SIMPLEADMIN=${s.install_simpleadmin}`,
      `RCON_PASSWORD=${s.rcon_password}`,
      `MM_LATEST_INDEX=${cfg.addons.metamod.latest_index}`,
      `CSS_REPO=${cfg.addons.counterstrikesharp.repo}`,
      `CSS_ASSET_MATCH=${cfg.addons.counterstrikesharp.asset_match}`,
      `PLUGINS_JSON=${JSON.stringify(cfg.addons.default_plugins)}`,
      ...(s.__extraEnv || []),
    ],
    HostConfig: {
      Binds: [`${dir}:/home/steam/cs2data`],
      // Hard isolation: pinned threads, fixed memory, swap disabled.
      CpusetCpus: s.cpuset,
      Memory: memBytes,
      MemorySwap: memBytes,
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: {
        [`${s.game_port}/udp`]: [{ HostPort: String(s.game_port) }],
        [`${s.game_port}/tcp`]: [{ HostPort: String(s.game_port) }], // FakeRcon listens on TCP
      },
      NetworkMode: NET,
    },
    ExposedPorts: {
      [`${s.game_port}/udp`]: {},
      [`${s.game_port}/tcp`]: {},
    },
    Labels: { 'bonehost.server': s.id, 'bonehost.owner': String(s.owner_id) },
  };
}

async function getContainer(id) {
  const c = docker.getContainer(NAME(id));
  try { await c.inspect(); return c; } catch { return null; }
}

export async function ensureContainer(s) {
  let c = await getContainer(s.id);
  if (!c) c = await docker.createContainer(containerSpec(s));
  return c;
}

export async function startServer(s) {
  const c = await ensureContainer(s);
  const info = await c.inspect();
  if (!info.State.Running) await c.start();
}

export async function stopServer(s) {
  const c = await getContainer(s.id);
  if (c) { try { await c.stop({ t: 20 }); } catch (e) { if (e.statusCode !== 304) throw e; } }
}

export async function restartServer(s) {
  const c = await ensureContainer(s);
  await c.restart({ t: 20 });
}

// Recreate = pick up new env/cfg/limits, or run an update pass (entrypoint updates on boot).
export async function recreateServer(s) {
  const c = await getContainer(s.id);
  let wasRunning = false;
  if (c) {
    const info = await c.inspect();
    wasRunning = info.State.Running;
    if (wasRunning) await c.stop({ t: 20 });
    await c.remove();
  }
  const fresh = await docker.createContainer(containerSpec(s));
  if (wasRunning || !c) await fresh.start();
}

export async function removeServer(s) {
  const c = await getContainer(s.id);
  if (c) {
    try { await c.stop({ t: 10 }); } catch { /* already stopped */ }
    await c.remove();
  }
}

export async function containerState(s) {
  const c = await getContainer(s.id);
  if (!c) return { exists: false, running: false };
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
    } catch { /* stats are best-effort */ }
  }
  return {
    exists: true,
    running: info.State.Running,
    started_at: info.State.StartedAt,
    stats,
  };
}

export async function tailLogs(s, lines = 200) {
  const c = await getContainer(s.id);
  if (!c) return '';
  const buf = await c.logs({ stdout: true, stderr: true, tail: lines, timestamps: false });
  // demux: strip the 8-byte docker stream headers
  let out = '', i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out += buf.slice(i + 8, i + 8 + len).toString('utf8');
    i += 8 + len;
  }
  return out || buf.toString('utf8');
}

/**
 * One SFTP container serves every server: user `s.ftp_user` is chrooted with
 * the server's data dir mounted at /cs2. Adding/removing a server rebuilds
 * the container (a few seconds, no game impact).
 */
export async function syncSftp(allServers) {
  const live = allServers.filter(s => s.status !== 'deleted');
  const old = docker.getContainer(SFTP);
  try { await old.inspect(); try { await old.stop({ t: 5 }); } catch {} await old.remove(); } catch {}
  if (!live.length) return;

  await docker.createContainer({
    name: SFTP,
    Image: 'atmoz/sftp:alpine',
    Cmd: live.map(s => `${s.ftp_user}:${s.ftp_password}:1000:1000`),
    HostConfig: {
      Binds: live.map(s => `${serverDir(s.id)}:/home/${s.ftp_user}/cs2`),
      PortBindings: { '22/tcp': [{ HostPort: String(cfg.network.sftp_port) }] },
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: NET,
    },
    ExposedPorts: { '22/tcp': {} },
    Labels: { 'bonehost.role': 'sftp' },
  }).then(c => c.start());
}

export async function pullBaseImages() {
  for (const image of ['atmoz/sftp:alpine']) {
    try { await new Promise((res, rej) => docker.pull(image, (e, s) => e ? rej(e) : docker.modem.followProgress(s, err => err ? rej(err) : res()))); }
    catch (e) { console.warn(`[docker] could not pull ${image}: ${e.message}`); }
  }
}
