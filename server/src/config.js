import fs from 'node:fs';
import path from 'node:path';

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');

function load() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return raw;
}

export const cfg = load();

export const env = {
  jwtSecret: required('JWT_SECRET'),
  adminEmail: process.env.ADMIN_EMAIL || null,
  adminPassword: process.env.ADMIN_PASSWORD || null,
  btcpay: {
    url: (process.env.BTCPAY_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.BTCPAY_API_KEY || '',
    storeId: process.env.BTCPAY_STORE_ID || '',
    webhookSecret: process.env.BTCPAY_WEBHOOK_SECRET || '',
  },
  steamApiKey: process.env.STEAM_API_KEY || '',
  mariadbRootPassword: process.env.MARIADB_ROOT_PASSWORD || '',
  adminIpAllowlist: (process.env.ADMIN_IP_ALLOWLIST || '')
    .split(',').map(s => s.trim()).filter(Boolean),
};

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[config] Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

export const dataRoot = cfg.panel.data_root || '/srv/bonehost';
export const serversRoot = path.join(dataRoot, 'servers');
export const ledgerDir = path.join(dataRoot, 'ledger');

export function priceCents(slots, plan) {
  const monthly = slots * cfg.billing.price_per_slot_cents_monthly;
  if (plan === 'yearly') return monthly * cfg.billing.yearly_months_charged;
  return monthly;
}

export function periodMs(plan) {
  // Month = 30d, year = 365d. paid_until is an absolute timestamp so the
  // delinquency check is identical for both plans.
  return plan === 'yearly' ? 365 * 864e5 : 30 * 864e5;
}
