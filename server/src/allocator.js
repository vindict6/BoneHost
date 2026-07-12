import { cfg } from './config.js';
import { db } from './db.js';

/**
 * Threads, memory and ports come from a single source of truth: config.json.
 * Live servers (anything not 'deleted') hold their reservation even while
 * stopped or suspended, so a restart never lands on someone else's cores.
 */

function reservedThreads() {
  const rows = db.prepare(`SELECT cpuset FROM servers WHERE status != 'deleted'`).all();
  const used = new Set();
  for (const r of rows) r.cpuset.split(',').forEach(t => used.add(+t));
  return used;
}

export function allocateCpus(threads = cfg.cpu.threads_per_server) {
  const pool = cfg.cpu.pool;
  const used = reservedThreads();
  const free = pool.filter(t => !used.has(t));

  if (cfg.cpu.pin_sibling_pairs && threads % 2 === 0) {
    // Prefer full physical cores: pick pairs (t, t + sibling_offset) that are both free.
    const off = cfg.cpu.smt_sibling_offset;
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
  throw new Error(`Host is out of CPU threads (need ${threads}, ${free.length} free). An admin must retire a server or shrink allocations in config.json.`);
}

export function allocateMemory(mb = cfg.memory.per_server_mb) {
  const usedMb = db.prepare(`SELECT COALESCE(SUM(memory_mb),0) m FROM servers WHERE status != 'deleted'`).get().m;
  const budget = cfg.memory.total_mb - cfg.memory.host_reserved_mb;
  if (usedMb + mb > budget) {
    throw new Error(`Host is out of memory (${usedMb + mb}MB requested of ${budget}MB game budget).`);
  }
  return mb;
}

export function allocatePort() {
  const [lo, hi] = cfg.network.game_port_range;
  const used = new Set(db.prepare(`SELECT game_port FROM servers WHERE status != 'deleted'`).all().map(r => r.game_port));
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  throw new Error('No free game ports in the configured range.');
}

export function hostUsage() {
  const rows = db.prepare(`SELECT id, name, cpuset, memory_mb, status FROM servers WHERE status != 'deleted'`).all();
  const used = reservedThreads();
  return {
    cpu: {
      pool: cfg.cpu.pool,
      used: [...used].sort((a, b) => a - b),
      free: cfg.cpu.pool.filter(t => !used.has(t)),
      per_server: rows.map(r => ({ id: r.id, name: r.name, cpuset: r.cpuset, status: r.status })),
    },
    memory: {
      total_mb: cfg.memory.total_mb,
      host_reserved_mb: cfg.memory.host_reserved_mb,
      allocated_mb: rows.reduce((n, r) => n + r.memory_mb, 0),
      budget_mb: cfg.memory.total_mb - cfg.memory.host_reserved_mb,
    },
  };
}
