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
  const VOICES = ['feminino', 'masculino'];
  /** Etiqueta da Shopee (Sub ID): letras minúsculas e números, 2 a 20. */
  const cleanTag = (v) => {
    const t = String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (t && t.length < 2) throw new HttpError(400, 'A etiqueta precisa ter pelo menos 2 letras ou números.');
    return t || null;
  };
  const linkedIds = async (uid) => (await pool.query('select other_id from account_links where user_id = $1', [uid])).rows.map((r) => r.other_id);
  /** Liga as duas contas e todas as já ligadas a elas (qualquer uma troca para qualquer outra). */
  async function linkGroup(a, b) {
    const group = [...new Set([a, b, ...(await linkedIds(a)), ...(await linkedIds(b))])];
    for (const x of group) {
      for (const y of group) {
        if (x !== y) await pool.query('insert into account_links (user_id, other_id) values ($1, $2) on conflict do nothing', [x, y]);
      }
    }
  }
  /** Etiqueta não pode repetir entre contas ligadas (senão as vendas se misturam). */
  async function tagFree(uid, tag, extraIds = []) {
    if (!tag) return;
    const ids = [...new Set([...(await linkedIds(uid)), ...extraIds])].filter((x) => x !== uid);
    if (!ids.length) return;
    const { rows } = await pool.query('select id, sh_sub_id from users where sh_sub_id = $1', [tag]);
    if (rows.some((r) => ids.includes(r.id))) throw new HttpError(409, `A etiqueta "${tag}" já é de outra conta sua. Use outra.`);
  }
  async function accountsOf(uid) {
    const ids = [uid, ...(await linkedIds(uid))];
    const out = [];
    for (const id of ids) {
      const u = (await pool.query('select u.id, u.email, u.name, u.voice, u.sh_sub_id, u.sh_untagged, c.ig_username from users u left join connections c on c.user_id = u.id where u.id = $1', [id])).rows[0];
      if (u) out.push({ id: u.id, name: u.name || u.email, email: u.email, voice: u.voice, sh_sub_id: u.sh_sub_id, principal: u.sh_untagged !== false, ig_username: u.ig_username || null, current: u.id === uid });
    }
    return out;
  }

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
    const { rows } = await pool.query('select id, email, name, brand_color, brand_handle, ship_zip, voice, sh_sub_id, sh_untagged from users where id = $1', [req.uid]);
    if (!rows.length) throw new HttpError(401, 'Conta não encontrada.');
    res.json({ user: clean(rows[0]), signup: cfg.allowSignup, ai: Boolean(cfg.anthropicKey),
      brand: { color: rows[0].brand_color || null, handle: rows[0].brand_handle || null },
      ship_zip: rows[0].ship_zip || null,
      voice: rows[0].voice === 'masculino' ? 'masculino' : 'feminino', sh_sub_id: rows[0].sh_sub_id || null, principal: rows[0].sh_untagged !== false,
      accounts: await accountsOf(req.uid) });
  });

  /* ---------- contas vinculadas ---------- */
  r.get('/accounts', requireAuth(cfg), async (req, res) => res.json({ accounts: await accountsOf(req.uid) }));

  /** Cria uma conta nova já ligada a esta (ex.: perfil masculino). Pode copiar as chaves da Shopee e do Mercado Livre. */
  r.post('/accounts', requireAuth(cfg), async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'Dê um nome para a conta (ex.: Achados Masculinos).');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'E-mail inválido.');
    if (password.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
    if ((await pool.query('select 1 from users where email = $1', [email])).rows.length) throw new HttpError(409, 'Já existe uma conta com este e-mail. Use "Vincular conta existente".');
    if ((await linkedIds(req.uid)).length >= 9) throw new HttpError(400, 'No máximo 10 contas ligadas.');
    const voice = VOICES.includes(b.voice) ? b.voice : 'feminino';
    const tag = cleanTag(b.sh_sub_id) || cleanTag(name.split(/\s+/).pop());
    await tagFree(req.uid, tag, [req.uid]);
    const me = (await pool.query('select sh_sub_id from users where id = $1', [req.uid])).rows[0];
    if (me && me.sh_sub_id === tag) throw new HttpError(409, `A etiqueta "${tag}" já é desta conta. Use outra.`);
    const hash = await bcrypt.hash(password, 10);
    const u = (await pool.query(
      'insert into users (email, password_hash, name, voice, sh_sub_id, sh_untagged) values ($1, $2, $3, $4, $5, false) returning id',
      [email, hash, name, voice, tag])).rows[0];
    if (b.copy_keys) {
      // Shopee: mesmas chaves. Mercado Livre: mesmas chaves e comissões, mas precisa autorizar de novo (o token é de uma conta só).
      await pool.query(
        `insert into marketplace_connections (user_id, marketplace, app_id, secret_enc, default_commission, commission_table)
           select $1::int, marketplace, app_id, secret_enc, default_commission, commission_table from marketplace_connections where user_id = $2`,
        [u.id, req.uid]);
      await pool.query('update users set ship_zip = (select ship_zip from users where id = $2) where id = $1', [u.id, req.uid]);
    }
    await linkGroup(req.uid, u.id);
    res.status(201).json({ accounts: await accountsOf(req.uid) });
  });

  /** Liga uma conta que já existe (precisa da senha dela). */
  r.post('/accounts/link', requireAuth(cfg), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    throttle(`link|${req.ip}|${email}`);
    const { rows } = await pool.query('select * from users where email = $1', [email]);
    const ok = rows.length && (await bcrypt.compare(password, rows[0].password_hash));
    if (!ok) throw new HttpError(401, 'E-mail ou senha incorretos.');
    if (rows[0].id === req.uid) throw new HttpError(400, 'Essa já é a conta em que você está.');
    await tagFree(req.uid, rows[0].sh_sub_id, [req.uid]);
    await linkGroup(req.uid, rows[0].id);
    res.json({ accounts: await accountsOf(req.uid) });
  });

  /** Troca para uma conta ligada, sem senha. */
  r.post('/switch', requireAuth(cfg), async (req, res) => {
    const id = Number(req.body?.id) || 0;
    if (!(await linkedIds(req.uid)).includes(id)) throw new HttpError(403, 'Essa conta não está ligada a esta.');
    const u = (await pool.query('select id, email, name from users where id = $1', [id])).rows[0];
    if (!u) throw new HttpError(404, 'Conta não encontrada.');
    setSession(res, u.id);
    res.json({ user: clean(u) });
  });

  /** Desliga uma conta desta (as duas continuam existindo, só não trocam mais sem senha). */
  r.delete('/accounts/:id', requireAuth(cfg), async (req, res) => {
    const id = Number(req.params.id) || 0;
    await pool.query('delete from account_links where (user_id = $1 and other_id = $2) or (user_id = $2 and other_id = $1)', [req.uid, id]);
    res.json({ accounts: await accountsOf(req.uid) });
  });

  /** Tom da conta e etiqueta da Shopee. */
  r.put('/profile', requireAuth(cfg), async (req, res) => {
    const b = req.body || {};
    const cur = (await pool.query('select voice, sh_sub_id, sh_untagged from users where id = $1', [req.uid])).rows[0];
    const voice = b.voice === undefined ? cur.voice : VOICES.includes(b.voice) ? b.voice : 'feminino';
    const tag = b.sh_sub_id === undefined ? cur.sh_sub_id : cleanTag(b.sh_sub_id);
    await tagFree(req.uid, tag);
    const principal = b.principal === undefined ? cur.sh_untagged !== false : Boolean(b.principal);
    if (!principal && !tag) throw new HttpError(400, 'Sem etiqueta, esta conta precisa ser a principal (senão não recebe nenhuma venda).');
    await pool.query('update users set voice = $1, sh_sub_id = $2, sh_untagged = $3 where id = $4', [voice, tag, principal, req.uid]);
    // só uma principal entre as contas ligadas
    if (principal) {
      const ids = await linkedIds(req.uid);
      for (const id of ids) await pool.query('update users set sh_untagged = false where id = $1 and sh_sub_id is not null', [id]);
    }
    res.json({ voice, sh_sub_id: tag, principal, accounts: await accountsOf(req.uid) });
  });

  /** CEP de referência para estimar o frete dos produtos (o frete muda por região). Vazio = não calcula. */
  r.put('/shipping', requireAuth(cfg), async (req, res) => {
    const zip = String(req.body?.zip || '').replace(/\D/g, '');
    if (zip && zip.length !== 8) throw new HttpError(400, 'CEP inválido. Use 8 números.');
    await pool.query('update users set ship_zip = $1 where id = $2', [zip || null, req.uid]);
    res.json({ ship_zip: zip || null });
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
