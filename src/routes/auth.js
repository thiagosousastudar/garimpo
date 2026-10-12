const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { HttpError } = require('../util');

const COOKIE = 'garimpo_session';
const WEEK = 7 * 24 * 3600 * 1000;

function requireAuth(cfg) {
  return (req, _res, next) => {
    const token = req.cookies?.[COOKIE];
    if (!token) return next(new HttpError(401, 'Entre para continuar.'));
    try {
      req.uid = jwt.verify(token, cfg.jwtSecret).uid;
      next();
    } catch (_) {
      next(new HttpError(401, 'Sessão expirada. Entre novamente.'));
    }
  };
}

function authRoutes({ pool, cfg }) {
  const r = express.Router();
  const attempts = new Map(); // limitador simples em memória: chave -> {n, reset}

  function throttle(key) {
    const now = Date.now();
    const a = attempts.get(key);
    if (!a || a.reset < now) { attempts.set(key, { n: 1, reset: now + 15 * 60 * 1000 }); return; }
    a.n += 1;
    if (a.n > 10) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  }

  function setSession(res, uid) {
    const token = jwt.sign({ uid }, cfg.jwtSecret, { expiresIn: '7d' });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure, maxAge: WEEK, path: '/' });
  }

  const clean = (u) => ({ id: u.id, email: u.email, name: u.name });

  r.get('/signup-open', (_req, res) => res.json({ signup: cfg.allowSignup }));

  r.post('/register', async (req, res) => {
    if (!cfg.allowSignup) throw new HttpError(403, 'Cadastro desativado neste servidor.');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim() || null;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'E-mail inválido.');
    if (password.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
    const exists = await pool.query('select 1 from users where email = $1', [email]);
    if (exists.rows.length) throw new HttpError(409, 'Já existe uma conta com este e-mail.');
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'insert into users (email, password_hash, name) values ($1, $2, $3) returning id, email, name',
      [email, hash, name]
    );
    setSession(res, rows[0].id);
    res.status(201).json({ user: clean(rows[0]) });
  });

  r.post('/login', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    throttle(`${req.ip}|${email}`);
    const { rows } = await pool.query('select * from users where email = $1', [email]);
    const ok = rows.length && (await bcrypt.compare(password, rows[0].password_hash));
    if (!ok) throw new HttpError(401, 'E-mail ou senha incorretos.');
    attempts.delete(`${req.ip}|${email}`);
    setSession(res, rows[0].id);
    res.json({ user: clean(rows[0]) });
  });

  r.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  r.get('/me', requireAuth(cfg), async (req, res) => {
    const { rows } = await pool.query('select id, email, name, brand_color, brand_handle from users where id = $1', [req.uid]);
    if (!rows.length) throw new HttpError(401, 'Conta não encontrada.');
    res.json({ user: clean(rows[0]), signup: cfg.allowSignup, ai: Boolean(cfg.anthropicKey),
      brand: { color: rows[0].brand_color || null, handle: rows[0].brand_handle || null } });
  });

  /** Identidade visual das capas: cor da marca (#rrggbb) e @ que aparece no rodapé. */
  r.put('/brand', requireAuth(cfg), async (req, res) => {
    const color = String(req.body?.color || '').trim();
    const handle = String(req.body?.handle || '').trim().replace(/^@+/, '');
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'Cor inválida. Use o formato #rrggbb.');
    if (handle && !/^[A-Za-z0-9._]{1,30}$/.test(handle)) throw new HttpError(400, '@ inválido. Use letras, números, ponto ou _.');
    await pool.query('update users set brand_color = $1, brand_handle = $2 where id = $3', [color || null, handle || null, req.uid]);
    res.json({ brand: { color: color || null, handle: handle || null } });
  });

  return r;
}

module.exports = { authRoutes, requireAuth };
