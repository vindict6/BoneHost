/*
 * Node registry + agent client
 * ----------------------------
 * The panel is a control plane: it never touches Docker or game files itself.
 * Every node in config.json runs the BoneHost agent; this module is the only
 * place that talks to it. Function names mirror the old local docker layer so
 * the rest of the panel didn't have to change shape.
 *
 * Auth: per-node bearer token from env NODE_TOKEN_<ID> (uppercased, - -> _).
 */
import { cfg, env } from './config.js';
import { db } from './db.js';

export function nodes() {
  return (cfg.nodes || []).map(n => ({ ...n, token: nodeToken(n.id) }));
}
export function getNode(id) {
  const n = nodes().find(x => x.id === id);
  if (!n) throw new Error(`Unknown node "${id}" — check config.json.`);
  return n;
}
export function nodeFor(server) { return getNode(server.node_id); }
function nodeToken(id) {
  return process.env[`NODE_TOKEN_${id.toUpperCase().replace(/-/g, '_')}`] || '';
}

const SKIP = process.env.SKIP_DOCKER === '1'; // test mode: agent calls become no-ops

async function agent(node, method, path, body) {
  if (SKIP) return { ok: true, skipped: true, exists: false, running: false, logs: '' };
  if (!node.token) throw new Error(`No token for node "${node.id}" — set NODE_TOKEN_${node.id.toUpperCase().replace(/-/g, '_')} in the panel .env.`);
  let r;
  try {
    r = await fetch(`${node.agent_url.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${node.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' ? 10000 : 120000),
    });
  } catch (e) {
    throw new Error(`Node "${node.name || node.id}" unreachable (${e.message}). Is the agent up?`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Agent ${method} ${path} -> ${r.status}`);
  return j;
}

/* Everything the agent needs to build the container, in one payload. */
export function serverSpecPayload(s, extraEnv = []) {
  return {
    id: s.id, owner_id: s.owner_id, slots: s.slots, game_port: s.game_port,
    cpuset: s.cpuset, memory_mb: s.memory_mb,
    map: s.map, game_type: s.game_type, game_mode: s.game_mode, gslt: s.gslt,
    rcon_password: s.rcon_password,
    ssh_port: s.ssh_port, ssh_password: s.ftp_password, // per-container SSH/SFTP creds
    install_metamod: !!s.install_metamod, install_cssharp: !!s.install_cssharp,
    install_fakercon: !!s.install_fakercon, install_simpleadmin: !!s.install_simpleadmin,
    image: cfg.cs2.image,
    update_on_start: !!cfg.cs2.update_on_start,
    mm_latest_index: cfg.addons.metamod.latest_index,
    css_repo: cfg.addons.counterstrikesharp.repo,
    css_asset_match: cfg.addons.counterstrikesharp.asset_match,
    plugins: cfg.addons.default_plugins,
    extra_env: extraEnv,
  };
}

/* files: {relpath: content}; action per agent contract */
export function applyServer(s, { files = {}, action = 'none', start = false, extraEnv = [] } = {}) {
  return agent(nodeFor(s), 'POST', `/servers/${s.id}/apply`, {
    server: serverSpecPayload(s, extraEnv), files, action, start,
  });
}

export const startServer = s => applyServer(s, { action: 'start' });
export const stopServer = s => applyServer(s, { action: 'stop' });
export const restartServer = s => applyServer(s, { action: 'restart' });
export const recreateServer = (s, extraEnv = [], files = {}) => applyServer(s, { action: 'recreate', files, extraEnv });
export const removeServer = s => applyServer(s, { action: 'remove' });
export const pushFiles = (s, files) => applyServer(s, { files, action: 'none' });

export async function containerState(s) {
  const r = await agent(nodeFor(s), 'GET', `/servers/${s.id}/state`);
  return SKIP ? { exists: false, running: false } : r;
}

export async function tailLogs(s, lines = 200) {
  const r = await agent(nodeFor(s), 'GET', `/servers/${s.id}/logs?lines=${lines}`);
  return r.logs || '';
}

export function rconExec(s, command) {
  return agent(nodeFor(s), 'POST', `/servers/${s.id}/rcon`, {
    port: s.game_port, password: s.rcon_password, command,
  }).then(r => r.output);
}

export function destroyOnNode(s) {
  return agent(nodeFor(s), 'POST', `/servers/${s.id}/destroy`);
}

export function provisionSimpleAdmin(s) {
  return agent(nodeFor(s), 'POST', '/simpleadmin/provision', {
    server_id: s.id, user: s.ftp_user, password: s.ftp_password,
    root_password: env.mariadbRootPassword,
  });
}

export async function nodeHealth(node) {
  try { return { ...(await agent(node, 'GET', '/health')), reachable: !SKIP }; }
  catch (e) { return { ok: false, reachable: false, error: e.message }; }
}

export function warmNodes() {
  for (const n of nodes()) {
    agent(n, 'POST', '/images/pull', { images: ['atmoz/sftp:alpine'] })
      .catch(e => console.warn(`[nodes] warm-up on ${n.id} skipped: ${e.message}`));
  }
}
