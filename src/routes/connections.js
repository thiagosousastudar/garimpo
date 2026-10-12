const express = require('express');
const crypto = require('crypto');
const { HttpError, encrypt, decrypt, parseNum } = require('../util');
const { createInstagramClient } = require('../services/instagram');
const { createShopeeClient } = require('../services/shopee');
const { mercadoLivreOAuth } = require('../services/mercadolivre');
const { saveMercadoLivreTokens } = require('../services/garimpo');

function connectionRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();

  r.get('/instagram', async (req, res) => {
    const { rows } = await pool.query('select ig_user_id, ig_token_enc from connections where user_id = $1', [req.uid]);
    const c = rows[0];
    res.json({
      connected: Boolean(c && c.ig_user_id && c.ig_token_enc),
      ig_user_id: c?.ig_user_id || null,
      public_media: !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(cfg.appUrl),
    });
  });

  r.put('/instagram', async (req, res) => {
    const igUserId = String(req.body?.ig_user_id || '').trim();
    const token = String(req.body?.access_token || '').trim();
    if (!/^\d{5,25}$/.test(igUserId)) throw new HttpError(400, 'O ID da conta do Instagram deve ter apenas números.');
    if (token.length < 20) throw new HttpError(400, 'Token de acesso inválido.');
    // Confere com a Meta antes de salvar, para não guardar credencial que não funciona.
    let who;
    try {
      who = await createInstagramClient({ cfg, fetchImpl }).whoami({ igUserId, token });
    } catch (e) {
      throw new HttpError(400, `A Meta recusou as credenciais: ${e.message}`);
    }
    await pool.query(
      `insert into connections (user_id, ig_user_id, ig_token_enc, updated_at) values ($1,$2,$3, now())
         on conflict (user_id) do update set ig_user_id = excluded.ig_user_id, ig_token_enc = excluded.ig_token_enc, updated_at = now()`,
      [req.uid, igUserId, encrypt(token, cfg.encryptionKey)]
    );
    res.json({ connected: true, ig_user_id: igUserId, username: who.username || null });
  });

  r.post('/instagram/test', async (req, res) => {
    const { rows } = await pool.query('select ig_user_id, ig_token_enc from connections where user_id = $1', [req.uid]);
    if (!rows.length || !rows[0].ig_token_enc) throw new HttpError(400, 'Instagram não conectado.');
    try {
      const who = await createInstagramClient({ cfg, fetchImpl }).whoami({
        igUserId: rows[0].ig_user_id,
        token: decrypt(rows[0].ig_token_enc, cfg.encryptionKey),
      });
      res.json({ ok: true, username: who.username || null });
    } catch (e) {
      throw new HttpError(400, `A conexão falhou: ${e.message}`);
    }
  });

  r.delete('/instagram', async (req, res) => {
    await pool.query('delete from connections where user_id = $1', [req.uid]);
    res.json({ ok: true });
  });

  /* ---------- lojas (garimpo) ---------- */
  const mlRedirect = () => `${cfg.appUrl}/api/connections/mercadolivre/callback`;

  r.get('/marketplaces', async (req, res) => {
    const { rows } = await pool.query(
      'select marketplace, app_id, access_token_enc, refresh_token_enc, token_expires_at, default_commission from marketplace_connections where user_id = $1',
      [req.uid]
    );
    const by = Object.fromEntries(rows.map((x) => [x.marketplace, x]));
    const ml = by.ML;
    res.json({
      SH: { connected: Boolean(by.SH), app_id: by.SH?.app_id || null },
      ML: {
        connected: Boolean(ml),
        authorized: Boolean(ml && ml.access_token_enc && (ml.refresh_token_enc || new Date(ml.token_expires_at) > new Date())),
        app_id: ml?.app_id || null,
        default_commission: ml?.default_commission === null || ml?.default_commission === undefined ? null : Number(ml.default_commission),
        redirect_uri: mlRedirect(),
      },
    });
  });

  r.put('/shopee', async (req, res) => {
    const appId = String(req.body?.app_id || '').trim();
    const secret = String(req.body?.secret || '').trim();
    if (!/^\d{5,20}$/.test(appId)) throw new HttpError(400, 'O App ID da Shopee deve ter apenas números.');
    if (secret.length < 10) throw new HttpError(400, 'Informe a Secret da Shopee.');
    // Testa com uma busca pequena antes de salvar.
    try {
      await createShopeeClient({ appId, secret, fetchImpl }).search({ q: 'celular', limit: 1 });
    } catch (e) {
      throw new HttpError(400, `A Shopee recusou as credenciais: ${e.message}`);
    }
    await pool.query(
      `insert into marketplace_connections (user_id, marketplace, app_id, secret_enc) values ($1, 'SH', $2, $3)
         on conflict (user_id, marketplace) do update set app_id = excluded.app_id, secret_enc = excluded.secret_enc, updated_at = now()`,
      [req.uid, appId, encrypt(secret, cfg.encryptionKey)]
    );
    res.json({ connected: true, app_id: appId });
  });

  r.delete('/shopee', async (req, res) => {
    await pool.query(`delete from marketplace_connections where user_id = $1 and marketplace = 'SH'`, [req.uid]);
    res.json({ ok: true });
  });

  /** Salva Client ID/Secret e a comissão padrão. Depois o navegador vai para /authorize. */
  r.put('/mercadolivre', async (req, res) => {
    const b = req.body || {};
    const clientId = String(b.client_id || '').trim();
    const secret = String(b.client_secret || '').trim();
    const com = b.default_commission === undefined || b.default_commission === '' ? null : parseNum(b.default_commission);
    if (com !== null && (com < 0 || com > 100)) throw new HttpError(400, 'A comissão padrão deve estar entre 0 e 100%.');
    const cur = (await pool.query(`select app_id from marketplace_connections where user_id = $1 and marketplace = 'ML'`, [req.uid])).rows[0];
    if (!clientId && cur) {
      await pool.query(`update marketplace_connections set default_commission = $1, updated_at = now() where user_id = $2 and marketplace = 'ML'`, [com, req.uid]);
      return res.json({ ok: true });
    }
    if (!/^\d{5,25}$/.test(clientId)) throw new HttpError(400, 'O Client ID do Mercado Livre deve ter apenas números.');
    if (secret.length < 10) throw new HttpError(400, 'Informe a Client Secret do Mercado Livre.');
    await pool.query(
      `insert into marketplace_connections (user_id, marketplace, app_id, secret_enc, default_commission) values ($1, 'ML', $2, $3, $4)
         on conflict (user_id, marketplace) do update set app_id = excluded.app_id, secret_enc = excluded.secret_enc,
           default_commission = excluded.default_commission, access_token_enc = null, refresh_token_enc = null,
           token_expires_at = null, updated_at = now()`,
      [req.uid, clientId, encrypt(secret, cfg.encryptionKey), com]
    );
    res.json({ ok: true, authorize: '/api/connections/mercadolivre/authorize' });
  });

  const OAUTH_COOKIE = 'ml_oauth';
  const cookieOpts = { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/api/connections/mercadolivre' };

  r.get('/mercadolivre/authorize', async (req, res) => {
    const conn = (await pool.query(`select * from marketplace_connections where user_id = $1 and marketplace = 'ML'`, [req.uid])).rows[0];
    if (!conn) throw new HttpError(400, 'Salve o Client ID e a Client Secret do Mercado Livre primeiro.');
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    res.cookie(OAUTH_COOKIE, `${state}.${verifier}`, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
    const auth = mercadoLivreOAuth({ clientId: conn.app_id, clientSecret: '', fetchImpl });
    res.redirect(auth.authorizeUrl({ redirectUri: mlRedirect(), state, challenge }));
  });

  r.get('/mercadolivre/callback', async (req, res) => {
    const back = (status, msg) => res.redirect(`/?ml=${status}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}#conexoes`);
    const [state, verifier] = String(req.cookies?.[OAUTH_COOKIE] || '').split('.');
    res.clearCookie(OAUTH_COOKIE, cookieOpts);
    if (req.query.error) return back('erro', String(req.query.error_description || req.query.error).slice(0, 200));
    if (!state || !verifier || req.query.state !== state) return back('erro', 'A autorização expirou ou não confere. Tente de novo.');
    const conn = (await pool.query(`select * from marketplace_connections where user_id = $1 and marketplace = 'ML'`, [req.uid])).rows[0];
    if (!conn) return back('erro', 'Conexão do Mercado Livre não encontrada.');
    try {
      const auth = mercadoLivreOAuth({ clientId: conn.app_id, clientSecret: decrypt(conn.secret_enc, cfg.encryptionKey), fetchImpl });
      const t = await auth.exchange({ code: String(req.query.code || ''), redirectUri: mlRedirect(), verifier });
      await saveMercadoLivreTokens(pool, cfg, req.uid, t);
    } catch (e) {
      return back('erro', e.message.slice(0, 200));
    }
    back('ok');
  });

  r.delete('/mercadolivre', async (req, res) => {
    await pool.query(`delete from marketplace_connections where user_id = $1 and marketplace = 'ML'`, [req.uid]);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { connectionRoutes };
