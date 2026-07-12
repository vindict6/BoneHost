import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db, audit } from './db.js';
import { env } from './config.js';

const COOKIE = 'bh_session';

export function issueSession(res, user) {
  const token = jwt.sign({ uid: user.id, role: user.role }, env.jwtSecret, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 864e5, path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

export function requireAuth(req, res, next) {
  try {
    const payload = jwt.verify(req.cookies[COOKIE] || '', env.jwtSecret);
    const user = db.prepare(`SELECT id, email, role, disabled FROM users WHERE id=?`).get(payload.uid);
    if (!user || user.disabled) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sign in required.' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    audit(req.user?.id, req.ip, 'admin.denied', req.path);
    return res.status(403).json({ error: 'Admin only.' });
  }
  if (env.adminIpAllowlist.length && !ipAllowed(req.ip)) {
    audit(req.user.id, req.ip, 'admin.ip_blocked', req.path);
    return res.status(403).json({ error: 'This address is not on the admin allowlist.' });
  }
  next();
}

function ipAllowed(ip) {
  const clean = ip.replace(/^::ffff:/, '');
  return env.adminIpAllowlist.some(entry => {
    if (!entry.includes('/')) return clean === entry;
    const [net, bits] = entry.split('/');
    const toInt = a => a.split('.').reduce((n, o) => (n << 8) + (+o), 0) >>> 0;
    try {
      const mask = bits === '0' ? 0 : (~0 << (32 - +bits)) >>> 0;
      return (toInt(clean) & mask) === (toInt(net) & mask);
    } catch { return false; }
  });
}

export function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

// Ownership guard: subscribers only touch their own servers; admin touches all.
export function loadOwnedServer(req, res, next) {
  const s = db.prepare(`SELECT * FROM servers WHERE id=? AND status != 'deleted'`).get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Server not found.' });
  if (req.user.role !== 'admin' && s.owner_id !== req.user.id) {
    audit(req.user.id, req.ip, 'server.denied', s.id);
    return res.status(403).json({ error: 'Not your server.' });
  }
  req.server = s;
  next();
}
