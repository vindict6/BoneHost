import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { dataRoot, serversRoot, ledgerDir, env } from './config.js';

for (const d of [dataRoot, serversRoot, ledgerDir]) fs.mkdirSync(d, { recursive: true });

export const db = new Database(path.join(dataRoot, 'bonehost.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'subscriber',      -- 'admin' | 'subscriber'
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES users(id),
  used_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,                          -- short slug, also docker name suffix
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  slots INTEGER NOT NULL,
  game_port INTEGER NOT NULL,
  cpuset TEXT NOT NULL,                         -- e.g. "4,20,5,21"
  memory_mb INTEGER NOT NULL,
  gslt TEXT NOT NULL DEFAULT '',
  map TEXT NOT NULL,
  game_type INTEGER NOT NULL DEFAULT 0,
  game_mode INTEGER NOT NULL DEFAULT 1,
  sv_password TEXT NOT NULL DEFAULT '',
  rcon_password TEXT NOT NULL,
  cfg_overrides TEXT NOT NULL DEFAULT '{}',     -- JSON of cvars merged over default_cfg
  install_metamod INTEGER NOT NULL DEFAULT 1,
  install_cssharp INTEGER NOT NULL DEFAULT 1,
  install_fakercon INTEGER NOT NULL DEFAULT 1,
  install_simpleadmin INTEGER NOT NULL DEFAULT 1,
  ftp_user TEXT NOT NULL,
  ftp_password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',       -- stopped|running|suspended|deleted
  suspended_reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,                           -- 'monthly' | 'yearly'
  price_cents INTEGER NOT NULL,
  paid_until INTEGER NOT NULL DEFAULT 0,        -- ms epoch; single field works for both plans
  status TEXT NOT NULL DEFAULT 'pending',       -- pending|active|past_due|canceled
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (       -- append-only ledger; no UPDATE path deletes rows
  id INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id),
  user_id INTEGER NOT NULL,
  server_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'btcpay',
  invoice_id TEXT UNIQUE,
  checkout_url TEXT,
  plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',           -- new|processing|settled|expired|invalid
  raw_json TEXT,                                -- last raw provider payload for the record
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE TABLE IF NOT EXISTS update_schedules (
  server_id TEXT PRIMARY KEY REFERENCES servers(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  day_of_week INTEGER NOT NULL DEFAULT 3,       -- 0=Sunday
  hour INTEGER NOT NULL DEFAULT 5,              -- panel timezone (config.updates.scheduler_timezone)
  include_metamod INTEGER NOT NULL DEFAULT 1,   -- bundle addon updates with the game update pass
  include_cssharp INTEGER NOT NULL DEFAULT 1,
  last_run INTEGER
);
CREATE TABLE IF NOT EXISTS server_admins (
  id INTEGER PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  steamid64 TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT '@css/generic',
  UNIQUE(server_id, steamid64)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
`);

// ---- seed admin ----
const adminCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='admin'`).get().c;
if (adminCount === 0) {
  if (!env.adminEmail || !env.adminPassword) {
    console.error('[db] No admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set. Aborting.');
    process.exit(1);
  }
  db.prepare(`INSERT INTO users (email, password_hash, role, created_at) VALUES (?,?, 'admin', ?)`)
    .run(env.adminEmail.toLowerCase(), bcrypt.hashSync(env.adminPassword, 12), Date.now());
  console.log(`[db] Seeded admin account ${env.adminEmail}`);
}

export function audit(userId, ip, action, target = null, detail = null) {
  db.prepare(`INSERT INTO audit_log (ts, user_id, ip, action, target, detail) VALUES (?,?,?,?,?,?)`)
    .run(Date.now(), userId, ip, action, target, detail ? JSON.stringify(detail) : null);
}
