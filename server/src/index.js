import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import { cfg } from './config.js';
import { db } from './db.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/servers.js';
import { adminRoutes } from './routes/admin.js';
import { verifyWebhook, handleWebhook, startBillingCron } from './billing.js';
import { startUpdateScheduler } from './updates.js';
import { pullBaseImages, syncSftp } from './docker.js';
import { allLiveServers } from './cs2.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // panel sits behind a reverse proxy / compose network
app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ['https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
  },
} }));
app.use(cookieParser());

// BTCPay webhook FIRST — needs the raw body for HMAC verification.
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '512kb' }), async (req, res) => {
  const sig = req.get('BTCPay-Sig');
  if (!verifyWebhook(req.body, sig)) return res.status(401).json({ error: 'bad signature' });
  try { await handleWebhook(JSON.parse(req.body.toString('utf8'))); res.json({ ok: true }); }
  catch (e) { console.error('[webhook]', e); res.status(500).json({ error: 'webhook processing failed' }); }
});

app.use(express.json({ limit: '256kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }));

// Basic CSRF hardening: state-changing API calls must be JSON from the SPA.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && req.path !== '/billing/webhook') {
    const ct = req.get('content-type') || '';
    if (!ct.includes('application/json')) return res.status(415).json({ error: 'JSON only.' });
  }
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/meta', (req, res) => res.json({
  name: cfg.panel.name,
  currency: cfg.billing.currency,
  per_slot_cents: cfg.billing.price_per_slot_cents_monthly,
  yearly_months_charged: cfg.billing.yearly_months_charged,
  grace_days: cfg.billing.grace_days,
  payment: {
    provider: cfg.billing.provider || 'manual',
    venmo: cfg.billing.manual?.venmo_username || null,
    cashapp: cfg.billing.manual?.cashapp_cashtag || null,
    note: cfg.billing.manual?.note || null,
  },
  sftp_port: cfg.network.sftp_port,
  public_host: cfg.network.public_host,
  timezone: cfg.updates.scheduler_timezone,
  default_map: cfg.cs2.default_map,
}));

// ---- static SPA ----
const webDir = fs.existsSync('/app/web') ? '/app/web' : path.resolve(process.cwd(), '../web');
app.use(express.static(webDir, { index: 'index.html', maxAge: '1h' }));
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(webDir, 'index.html')));

app.use((err, req, res, next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'Something broke on our side. It has been logged.' });
});

const port = cfg.panel.port || 8080;
app.listen(port, async () => {
  console.log(`[bonehost] panel listening on :${port}`);
  db.pragma('optimize');
  if (process.env.SKIP_DOCKER !== '1') {
    try { await pullBaseImages(); await syncSftp(allLiveServers()); }
    catch (e) { console.warn(`[bonehost] docker warm-up skipped: ${e.message}`); }
  }
  startBillingCron();
  startUpdateScheduler();
});
