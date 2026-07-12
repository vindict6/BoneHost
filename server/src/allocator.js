import { db } from './db.js';
import { nodes, getNode } from './nodes.js';

/**
 * Threads, memory and ports are allocated PER NODE from config.json's node
 * registry. Live servers (anything not 'deleted') hold their reservation even
 * while stopped or suspended, so a restart never lands on someone else's cores.
 */

function reservedThreads(nodeId) {
  const rows = db.prepare(`SELECT cpuset FROM servers WHERE node_id=? AND status != 'deleted'`).all(nodeId);
  const used = new Set();
  for (const r of rows) r.cpuset.split(',').forEach(t => used.add(+t));
  return used;
}

function freeThreads(node) {
  const used = reservedThreads(node.id);
  return node.cpu.pool.filter(t => !used.has(t));
}

function usedMemory(nodeId) {
  return db.prepare(`SELECT COALESCE(SUM(memory_mb),0) m FROM servers WHERE node_id=? AND status != 'deleted'`).get(nodeId).m;
}

/** Pick the node with the most free capacity that can actually fit a new server. */
export function chooseNode() {
  const ranked = nodes()
    .map(n => ({ n, free: freeThreads(n).length, memFree: (n.memory.total_mb - n.memory.host_reserved_mb) - usedMemory(n.id) }))
    .filter(x => x.free >= x.n.cpu.threads_per_server && x.memFree >= x.n.memory.per_server_mb)
    .sort((a, b) => b.free - a.free || b.memFree - a.memFree);
  if (!ranked.length) throw new Error('Every node is at capacity — an admin must retire a server or add a node in config.json.');
  return ranked[0].n;
}

export function allocateCpus(node, threads = node.cpu.threads_per_server) {
  const free = freeThreads(node);

  if (node.cpu.pin_sibling_pairs && threads % 2 === 0) {
    // Prefer full physical cores: pick pairs (t, t + sibling_offset) that are both free.
    const off = node.cpu.smt_sibling_offset;
    const picked = [];
    const freeSet = new Set(free);
    for (const t of free) {
      if (picked.length >= threads) break;
      const sib = t + off;
      if (freeSet.has(sib) && !picked.includes(t) && !picked.includes(sib)) {
        picked.push(t, sib);
        freeSet.delete(t); freeSet.delete(sib);
      }
    }
    if (picked.length >= threads) return picked.slice(0, threads);
  }
  if (free.length >= threads) return free.slice(0, threads);
  throw new Error(`Node ${node.id} is out of CPU threads (need ${threads}, ${free.length} free).`);
}

export function allocateMemory(node, mb = node.memory.per_server_mb) {
  const budget = node.memory.total_mb - node.memory.host_reserved_mb;
  if (usedMemory(node.id) + mb > budget) {
    throw new Error(`Node ${node.id} is out of memory (${usedMemory(node.id) + mb}MB requested of ${budget}MB game budget).`);
  }
  return mb;
}

export function allocatePort(node) {
  const [lo, hi] = node.game_port_range;
  const used = new Set(db.prepare(`SELECT game_port FROM servers WHERE node_id=? AND status != 'deleted'`).all(node.id).map(r => r.game_port));
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  throw new Error(`No free game ports on node ${node.id}.`);
}

export function allocateSshPort(node) {
  const [lo, hi] = node.ssh_port_range;
  const used = new Set(db.prepare(`SELECT ssh_port FROM servers WHERE node_id=? AND status != 'deleted'`).all(node.id).map(r => r.ssh_port));
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  throw new Error(`No free SSH ports on node ${node.id}.`);
}

/** Per-node resource map for the admin overview. */
export function nodeUsage(nodeId) {
  const node = getNode(nodeId);
  const rows = db.prepare(`SELECT id, name, cpuset, memory_mb, status FROM servers WHERE node_id=? AND status != 'deleted'`).all(nodeId);
  const used = reservedThreads(nodeId);
  return {
    id: node.id, name: node.name, public_host: node.public_host, agent_url: node.agent_url,
    cpu: {
      pool: node.cpu.pool,
      used: [...used].sort((a, b) => a - b),
      free: node.cpu.pool.filter(t => !used.has(t)),
      per_server: rows.map(r => ({ id: r.id, name: r.name, cpuset: r.cpuset, status: r.status })),
    },
    memory: {
      total_mb: node.memory.total_mb,
      host_reserved_mb: node.memory.host_reserved_mb,
      allocated_mb: rows.reduce((n, r) => n + r.memory_mb, 0),
      budget_mb: node.memory.total_mb - node.memory.host_reserved_mb,
    },
  };
}
