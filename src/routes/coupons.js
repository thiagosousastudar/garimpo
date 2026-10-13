const express = require('express');
const { HttpError, decrypt } = require('../util');
const { parseCoupons, cleanCoupon, roundupText, statusOf, todayLocal, MAX_COUPONS } = require('../services/coupons');
const { createTelegramClient } = require('../services/telegram');
const { followHandle, withFollow } = require('../services/copy');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function view(c, today) {
  return {
    id: c.id, marketplace: c.marketplace, code: c.code, kind: c.kind, amount: Number(c.amount),
    min_purchase: c.min_purchase === null ? null : Number(c.min_purchase),
    max_discount: c.max_discount === null ? null : Number(c.max_discount),
    expires_on: c.expires_on ? (c.expires_on instanceof Date ? c.expires_on.toISOString().slice(0, 10) : String(c.expires_on).slice(0, 10)) : null,
    link: c.link, notes: c.notes, active: c.active, status: statusOf(c, today),
  };
}

function settingsOf(u) {
  let ch = {};
  try { ch = JSON.parse(u.coupons_channels || '{}'); } catch (_) { ch = {}; }
  return { auto: Boolean(u.coupons_auto), time: u.coupons_time || '09:00', channels: { telegram: ch.telegram !== false, whatsapp: ch.whatsapp !== false } };
}

/** Envia a mensagem de cupons ao Telegram do usuário. Devolve false se não houver Telegram pronto. */
async function sendTelegram({ pool, cfg, fetchImpl, uid, text }) {
  const c = (await pool.query('select tg_token_enc, tg_chat_id from connections where user_id = $1', [uid])).rows[0];
  if (!c || !c.tg_token_enc || !c.tg_chat_id) return false;
  await createTelegramClient({ token: decrypt(c.tg_token_enc, cfg.encryptionKey), fetchImpl }).sendMessage(c.tg_chat_id, text);
  return true;
}

/** Deixa a mensagem de cupons pronta na Fila do WhatsApp. */
async function queueWhatsapp(pool, uid, text) {
  await pool.query(`insert into queue_items (user_id, channel, caption, media_type, kind) values ($1, 'whatsapp', $2, 'none', 'coupons')`, [uid, text]);
}

function couponRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();
  const all = async (uid) => (await pool.query('select * from coupons where user_id = $1 order by active desc, expires_on nulls last, id', [uid])).rows;

  r.get('/', async (req, res) => {
    const today = todayLocal();
    const u = (await pool.query('select coupons_auto, coupons_time, coupons_channels from users where id = $1', [req.uid])).rows[0];
    res.json({ items: (await all(req.uid)).map((c) => view(c, today)), settings: settingsOf(u || {}), today });
  });

  /** Lê cupons de uma mensagem colada. Não grava nada: a tela mostra para conferir. */
  r.post('/parse', async (req, res) => {
    const text = String(req.body?.text || '');
    if (text.trim().length < 3) throw new HttpError(400, 'Cole a mensagem com os cupons.');
    if (text.length > 20000) throw new HttpError(400, 'Mensagem grande demais.');
    const mk = req.body?.marketplace === 'SH' ? 'SH' : 'ML';
    res.json({ items: parseCoupons(text, mk) });
  });

  /** Cadastra um ou vários cupons. Código repetido na mesma loja atualiza o existente. */
  r.post('/', async (req, res) => {
    const list = Array.isArray(req.body?.items) ? req.body.items : [req.body];
    if (!list.length || list.length > 50) throw new HttpError(400, 'Envie de 1 a 50 cupons.');
    const clean = list.map((b) => cleanCoupon(b || {}));
    const count = (await pool.query('select count(*)::int as n from coupons where user_id = $1', [req.uid])).rows[0].n;
    let created = 0, updated = 0;
    for (const c of clean) {
      const ex = (await pool.query('select id from coupons where user_id = $1 and marketplace = $2 and code = $3', [req.uid, c.marketplace, c.code])).rows[0];
      if (ex) {
        await pool.query(
          `update coupons set kind = $1, amount = $2, min_purchase = $3, max_discount = $4, expires_on = $5, link = coalesce($6, link), notes = coalesce($7, notes), active = true where id = $8`,
          [c.kind, c.amount, c.min_purchase, c.max_discount, c.expires_on, c.link, c.notes, ex.id]);
        updated++;
      } else {
        if (count + created >= MAX_COUPONS) throw new HttpError(400, `Limite de ${MAX_COUPONS} cupons. Apague os vencidos.`);
        await pool.query(
          `insert into coupons (user_id, marketplace, code, kind, amount, min_purchase, max_discount, expires_on, link, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.uid, c.marketplace, c.code, c.kind, c.amount, c.min_purchase, c.max_discount, c.expires_on, c.link, c.notes]);
        created++;
      }
    }
    res.status(201).json({ created, updated });
  });

  r.patch('/:id', async (req, res) => {
    const cur = (await pool.query('select * from coupons where id = $1 and user_id = $2', [Number(req.params.id), req.uid])).rows[0];
    if (!cur) throw new HttpError(404, 'Cupom não encontrado.');
    const d = cleanCoupon({ kind: cur.kind, ...req.body }, true);
    delete d.marketplace; // a loja não muda
    const cols = Object.keys(d);
    if (!cols.length) throw new HttpError(400, 'Nada para atualizar.');
    await pool.query(`update coupons set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [cur.id, ...cols.map((c) => d[c])]);
    res.json({ ok: true });
  });

  r.delete('/:id', async (req, res) => {
    await pool.query('delete from coupons where id = $1 and user_id = $2', [Number(req.params.id), req.uid]);
    res.json({ ok: true });
  });

  /** Apaga os vencidos de uma vez. */
  r.post('/clean', async (req, res) => {
    const out = await pool.query('delete from coupons where user_id = $1 and expires_on < $2 returning id', [req.uid, todayLocal()]);
    res.json({ removed: out.rows.length });
  });

  /** Mensagem "cupons do dia" (só os válidos). */
  r.get('/message', async (req, res) => {
    const channel = ['whatsapp', 'instagram', 'telegram'].includes(req.query.channel) ? req.query.channel : 'whatsapp';
    const list = (await all(req.uid)).filter((c) => !req.query.marketplace || c.marketplace === req.query.marketplace);
    const text = withFollow(roundupText(list, channel), await followHandle(pool, req.uid), channel);
    res.json({ text, count: list.filter((c) => ['valido', 'hoje'].includes(statusOf(c))).length, missing_link: list.some((c) => !c.link && ['valido', 'hoje'].includes(statusOf(c))) });
  });

  r.post('/send-telegram', async (req, res) => {
    const text = withFollow(roundupText(await all(req.uid), 'telegram'), await followHandle(pool, req.uid), 'telegram');
    if (!text) throw new HttpError(400, 'Nenhum cupom válido para enviar.');
    let ok;
    try { ok = await sendTelegram({ pool, cfg, fetchImpl, uid: req.uid, text }); } catch (e) { throw new HttpError(502, e.message); }
    if (!ok) throw new HttpError(400, 'Conecte o Telegram em Conexões.');
    res.json({ ok: true });
  });

  /** Postagem automática diária dos cupons (Telegram e/ou Fila do WhatsApp). */
  r.put('/settings', async (req, res) => {
    const b = req.body || {};
    const time = HHMM.test(b.time) ? b.time : '09:00';
    const ch = { telegram: b.channels?.telegram !== false, whatsapp: b.channels?.whatsapp !== false };
    if (b.auto && !ch.telegram && !ch.whatsapp) throw new HttpError(400, 'Escolha pelo menos um canal.');
    await pool.query('update users set coupons_auto = $1, coupons_time = $2, coupons_channels = $3 where id = $4',
      [Boolean(b.auto), time, JSON.stringify(ch), req.uid]);
    res.json({ settings: { auto: Boolean(b.auto), time, channels: ch } });
  });

  return r;
}

/**
 * Agendador (a cada minuto): para quem ligou o automático, posta os cupons do dia uma vez por dia, no horário escolhido.
 * Reserva atômica por usuário (coupons_last_on), para não postar duas vezes.
 */
async function runCouponsDaily({ pool, cfg, fetchImpl, log = console, now = new Date() }) {
  const { localClock } = require('../services/automation');
  const { hhmm } = localClock(now);
  const today = todayLocal(now);
  const { rows } = await pool.query(
    `select id, coupons_time, coupons_channels from users where coupons_auto = true and (coupons_last_on is null or coupons_last_on < $1)`, [today]);
  let sent = 0;
  for (const u of rows) {
    if (hhmm < (u.coupons_time || '09:00')) continue;
    const claim = await pool.query('update users set coupons_last_on = $1 where id = $2 and (coupons_last_on is null or coupons_last_on < $1) returning id', [today, u.id]);
    if (!claim.rows.length) continue;
    const list = (await pool.query('select * from coupons where user_id = $1', [u.id])).rows;
    const s = settingsOf({ coupons_channels: u.coupons_channels });
    try {
      const handle = await followHandle(pool, u.id);
      const tg = withFollow(roundupText(list, 'telegram', today), handle, 'telegram');
      if (!tg) continue; // nenhum cupom válido hoje: não posta nada
      if (s.channels.telegram) await sendTelegram({ pool, cfg, fetchImpl, uid: u.id, text: tg }).catch((e) => log.error?.(`[cupons] telegram ${u.id}: ${e.message}`));
      if (s.channels.whatsapp) await queueWhatsapp(pool, u.id, withFollow(roundupText(list, 'whatsapp', today), handle, 'whatsapp'));
      sent++;
    } catch (e) {
      log.error?.(`[cupons] usuário ${u.id}: ${e.message}`);
    }
  }
  return sent;
}

module.exports = { couponRoutes, runCouponsDaily };
