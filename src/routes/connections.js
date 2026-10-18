const express = require('express');
const crypto = require('crypto');
const { HttpError, encrypt, decrypt, parseNum } = require('../util');
const { createInstagramClient } = require('../services/instagram');
const { createTelegramClient } = require('../services/telegram');
const { createShopeeClient } = require('../services/shopee');
const { mercadoLivreOAuth } = require('../services/mercadolivre');
const { saveMercadoLivreTokens, applyCommissionTable, commissionTableOf } = require('../services/garimpo');

function connectionRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();

  r.get('/instagram', async (req, res) => {
    const { rows } = await pool.query('select ig_user_id, ig_token_enc, ig_username from connections where user_id = $1', [req.uid]);
    const c = rows[0];
    const connected = Boolean(c && c.ig_user_id && c.ig_token_enc);
    let username = c?.ig_username || null;
    // Conexões feitas antes de guardar o @: busca uma vez na Meta e grava (falha não impede a resposta).
    if (connected && !username) {
      try {
        const who = await createInstagramClient({ cfg, fetchImpl }).whoami({ igUserId: c.ig_user_id, token: decrypt(c.ig_token_enc, cfg.encryptionKey) });
        username = who.username || null;
        if (username) await pool.query('update connections set ig_username = $1 where user_id = $2', [username, req.uid]);
      } catch (_) { /* segue sem o @ */ }
    }
    res.json({
      connected,
      ig_user_id: c?.ig_user_id || null,
      username,
      public_media: !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(cfg.appUrl),
      oauth: Boolean(cfg.igAppId && cfg.igAppSecret),
    });
  });

  /* ---------- "Entrar com Instagram" (login oficial da Meta) ---------- */
  const IG_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', 'instagram_business_manage_messages'];
  const IG_COOKIE = 'ig_oauth';
  const igCookieOpts = { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/api/connections/instagram' };
  const igRedirect = () => `${cfg.appUrl}/api/connections/instagram/callback`;

  r.get('/instagram/authorize', (req, res) => {
    if (!cfg.igAppId || !cfg.igAppSecret) throw new HttpError(400, 'O login do Instagram não está configurado neste servidor (IG_APP_ID e IG_APP_SECRET).');
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(IG_COOKIE, state, { ...igCookieOpts, maxAge: 10 * 60 * 1000 });
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('enable_fb_login', '0');
    url.searchParams.set('force_reauth', 'true');
    url.searchParams.set('client_id', cfg.igAppId);
    url.searchParams.set('redirect_uri', igRedirect());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', IG_SCOPES.join(','));
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  r.get('/instagram/callback', async (req, res) => {
    const back = (status, msg) => res.redirect(`/?ig=${status}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}#conexoes`);
    const state = String(req.cookies?.[IG_COOKIE] || '');
    res.clearCookie(IG_COOKIE, igCookieOpts);
    if (req.query.error) return back('erro', String(req.query.error_description || req.query.error_reason || req.query.error).slice(0, 200));
    if (!state || req.query.state !== state) return back('erro', 'A autorização expirou ou não confere. Tente de novo.');
    try {
      // o Instagram acrescenta "#_" ao code em alguns navegadores
      const code = String(req.query.code || '').replace(/#_$/, '');
      const ig = createInstagramClient({ cfg, fetchImpl });
      const t = await ig.exchangeCode({ code, redirectUri: igRedirect() });
      const who = await ig.me(t.token);
      const igUserId = String(who.user_id || who.id || '');
      if (!/^\d{5,25}$/.test(igUserId)) throw new Error('A Meta não devolveu o ID da conta.');
      await pool.query(
        `insert into connections (user_id, ig_user_id, ig_token_enc, ig_username, updated_at) values ($1,$2,$3,$4, now())
           on conflict (user_id) do update set ig_user_id = excluded.ig_user_id, ig_token_enc = excluded.ig_token_enc,
             ig_username = excluded.ig_username, updated_at = now()`,
        [req.uid, igUserId, encrypt(t.token, cfg.encryptionKey), who.username || null]
      );
    } catch (e) {
      return back('erro', e.message.slice(0, 200));
    }
    back('ok');
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
      `insert into connections (user_id, ig_user_id, ig_token_enc, ig_username, updated_at) values ($1,$2,$3,$4, now())
         on conflict (user_id) do update set ig_user_id = excluded.ig_user_id, ig_token_enc = excluded.ig_token_enc,
           ig_username = excluded.ig_username, updated_at = now()`,
      [req.uid, igUserId, encrypt(token, cfg.encryptionKey), who.username || null]
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
    // só os dados do Instagram (a mesma linha guarda o Telegram)
    await pool.query('update connections set ig_user_id = null, ig_token_enc = null, ig_username = null where user_id = $1', [req.uid]);
    res.json({ ok: true });
  });

  /* ---------- Telegram (bot oficial): canal automático do piloto ---------- */
  const tgRow = async (uid) => (await pool.query('select tg_token_enc, tg_chat_id, tg_chat_title, tg_alert_chat_id from connections where user_id = $1', [uid])).rows[0] || {};
  const tgClient = (row) => createTelegramClient({ token: decrypt(row.tg_token_enc, cfg.encryptionKey), fetchImpl });

  r.get('/telegram', async (req, res) => {
    const t = await tgRow(req.uid);
    res.json({ connected: Boolean(t.tg_token_enc), chat_id: t.tg_chat_id || null, chat_title: t.tg_chat_title || null, ready: Boolean(t.tg_token_enc && t.tg_chat_id), alert_chat_id: t.tg_alert_chat_id || null });
  });

  /** Salva o token do bot (testado no Telegram antes). */
  r.put('/telegram', async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new HttpError(400, 'Token inválido. Ele tem o formato 123456789:ABC... e vem do @BotFather.');
    let me;
    try { me = await createTelegramClient({ token, fetchImpl }).me(); } catch (e) { throw new HttpError(400, `O Telegram recusou o token: ${e.message}`); }
    await pool.query(
      `insert into connections (user_id, tg_token_enc, updated_at) values ($1, $2, now())
         on conflict (user_id) do update set tg_token_enc = excluded.tg_token_enc, tg_chat_id = null, tg_chat_title = null`,
      [req.uid, encrypt(token, cfg.encryptionKey)]
    );
    res.json({ connected: true, bot: me.username || null });
  });

  /** Grupos/canais em que o bot está e recebeu mensagem recente (para escolher onde postar). */
  r.get('/telegram/chats', async (req, res) => {
    const t = await tgRow(req.uid);
    if (!t.tg_token_enc) throw new HttpError(400, 'Conecte o bot do Telegram primeiro.');
    try { res.json({ chats: await tgClient(t).chats() }); } catch (e) { throw new HttpError(502, e.message); }
  });

  /** Escolhe o grupo/canal (id da lista ou @canal) e manda uma mensagem de teste. */
  r.put('/telegram/chat', async (req, res) => {
    const t = await tgRow(req.uid);
    if (!t.tg_token_enc) throw new HttpError(400, 'Conecte o bot do Telegram primeiro.');
    const chatId = String(req.body?.chat_id || '').trim();
    if (!/^(-?\d{5,}|@[A-Za-z0-9_]{5,})$/.test(chatId)) throw new HttpError(400, 'Escolha um grupo/canal da lista ou digite o @ do canal.');
    const client = tgClient(t);
    let title;
    try {
      const chat = await client.chat(chatId);
      title = chat.title || chat.username || chatId;
      await client.sendMessage(chatId, '✅ *Garimpo conectado!* As ofertas do piloto automático vão chegar aqui.');
    } catch (e) {
      throw new HttpError(400, `${e.message}. Confira se o bot é administrador do grupo/canal.`);
    }
    await pool.query('update connections set tg_chat_id = $1, tg_chat_title = $2 where user_id = $3', [String(chatId), title, req.uid]);
    res.json({ ready: true, chat_id: chatId, chat_title: title });
  });

  /** Avisos só para você (conversa privada com o bot): quem mandou /start ao bot aparece aqui. */
  r.get('/telegram/me-chats', async (req, res) => {
    const t = await tgRow(req.uid);
    if (!t.tg_token_enc) throw new HttpError(400, 'Conecte o bot do Telegram primeiro.');
    try { res.json({ chats: await tgClient(t).privateChats() }); } catch (e) { throw new HttpError(502, e.message); }
  });

  /** Liga (chat_id) ou desliga (vazio) os avisos de "pediram o link num post sem automação". */
  r.put('/telegram/alerts', async (req, res) => {
    const t = await tgRow(req.uid);
    if (!t.tg_token_enc) throw new HttpError(400, 'Conecte o bot do Telegram primeiro.');
    const chatId = String(req.body?.chat_id || '').trim();
    if (!chatId) {
      await pool.query('update connections set tg_alert_chat_id = null where user_id = $1', [req.uid]);
      return res.json({ alert_chat_id: null });
    }
    if (!/^\d{1,20}$/.test(chatId)) throw new HttpError(400, 'Escolha a sua conversa com o bot na lista.');
    try { await tgClient(t).sendMessage(chatId, '🔔 Avisos do Garimpo ligados! Quando alguém pedir o link num post sem automação, eu te aviso aqui.'); }
    catch (e) { throw new HttpError(400, `Não consegui te mandar mensagem: ${e.message}. Mande /start para o bot e tente de novo.`); }
    await pool.query('update connections set tg_alert_chat_id = $1 where user_id = $2', [chatId, req.uid]);
    res.json({ alert_chat_id: chatId });
  });

  r.delete('/telegram', async (req, res) => {
    await pool.query('update connections set tg_token_enc = null, tg_chat_id = null, tg_chat_title = null, tg_alert_chat_id = null where user_id = $1', [req.uid]);
    res.json({ ok: true });
  });

  /* ---------- lojas (garimpo) ---------- */
  const mlRedirect = () => `${cfg.appUrl}/api/connections/mercadolivre/callback`;

  r.get('/marketplaces', async (req, res) => {
    const { rows } = await pool.query(
      'select marketplace, app_id, access_token_enc, refresh_token_enc, token_expires_at, default_commission, commission_table from marketplace_connections where user_id = $1',
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
        commission_table: commissionTableOf(ml),
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
      return res.json({ ok: true, updated: await applyCommissionTable(pool, req.uid) });
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

  /**
   * Comissão de afiliado do Mercado Livre por categoria principal ({ "MLB5726": 6, ... }; vazio = usa a padrão).
   * Ao salvar, reaplica nos produtos já salvos cuja comissão foi preenchida pelo app.
   */
  r.put('/mercadolivre/commissions', async (req, res) => {
    const input = req.body?.table;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Envie a tabela de comissões.');
    const table = {};
    for (const [cat, v] of Object.entries(input)) {
      if (!/^MLB\d+$/.test(cat)) throw new HttpError(400, 'Categoria inválida na tabela.');
      if (v === '' || v === null || v === undefined) continue;
      const n = parseNum(v);
      if (n === null || n < 0 || n > 100) throw new HttpError(400, 'Cada comissão deve estar entre 0 e 100%.');
      table[cat] = n;
    }
    if (Object.keys(table).length > 200) throw new HttpError(400, 'Tabela grande demais.');
    const out = await pool.query(
      `update marketplace_connections set commission_table = $1, updated_at = now() where user_id = $2 and marketplace = 'ML' returning user_id`,
      [JSON.stringify(table), req.uid]
    );
    if (!out.rows.length) throw new HttpError(400, 'Conecte o Mercado Livre primeiro.');
    res.json({ ok: true, table, updated: await applyCommissionTable(pool, req.uid) });
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
