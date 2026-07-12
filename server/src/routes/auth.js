import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { db, audit } from '../db.js';
import { issueSession, clearSession, requireAuth, verifyPassword, hashPassword } from '../auth.js';

export const authRoutes = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

authRoutes.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare(`SELECT * FROM users WHERE email=?`).get(String(email || '').toLowerCase());
  if (!user || user.disabled || !verifyPassword(user, String(password || ''))) {
    audit(user?.id, req.ip, 'auth.login_failed', String(email || '').slice(0, 80));
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  issueSession(res, user);
  audit(user.id, req.ip, 'auth.login');
  res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
});

// Private instance: registration requires an invite code minted by the admin.
authRoutes.post('/register', loginLimiter, (req, res) => {
  const { email, password, invite } = req.body || {};
  const code = db.prepare(`SELECT * FROM invites WHERE code=? AND used_by IS NULL`).get(String(invite || '').trim());
  if (!code) return res.status(400).json({ error: 'Invalid or already-used invite code.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) return res.status(400).json({ error: 'Enter a valid email.' });
  if (String(password || '').length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  if (db.prepare(`SELECT 1 FROM users WHERE email=?`).get(email.toLowerCase())) {
    return res.status(400).json({ error: 'That email already has an account.' });
  }
  const info = db.prepare(`INSERT INTO users (email, password_hash, role, created_at) VALUES (?,?, 'subscriber', ?)`)
    .run(email.toLowerCase(), hashPassword(password), Date.now());
  db.prepare(`UPDATE invites SET used_by=?, used_at=? WHERE code=?`).run(info.lastInsertRowid, Date.now(), code.code);
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(info.lastInsertRowid);
  issueSession(res, user);
  audit(user.id, req.ip, 'auth.registered', null, { invite: code.code });
  res.json({ ok: true, user: { id: user.id, email: user.email, role: user.role } });
});

authRoutes.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

authRoutes.get('/me', requireAuth, (req, res) => {
  const notices = db.prepare(`SELECT * FROM notices WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(req.user.id);
  res.json({ user: req.user, notices });
});

authRoutes.post('/notices/read', requireAuth, (req, res) => {
  db.prepare(`UPDATE notices SET read=1 WHERE user_id=?`).run(req.user.id);
  res.json({ ok: true });
});

authRoutes.post('/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const user = db.prepare(`SELECT * FROM users WHERE id=?`).get(req.user.id);
  if (!verifyPassword(user, String(current || ''))) return res.status(400).json({ error: 'Current password is wrong.' });
  if (String(next || '').length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hashPassword(next), user.id);
  audit(user.id, req.ip, 'auth.password_changed');
  res.json({ ok: true });
});

export function mintInvite(adminId) {
  const code = crypto.randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO invites (code, created_by, created_at) VALUES (?,?,?)`).run(code, adminId, Date.now());
  return code;
}
