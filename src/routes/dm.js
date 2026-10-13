const express = require('express');
const { HttpError } = require('../util');
const { settingsOf, syncUser, sendFor, autoSend, productsForMedia, buildMessage, DEFAULT_KEYWORDS, DEFAULT_TEMPLATE, WINDOW_MS } = require('../services/igdm');

const STATUS = ['novo', 'enviado', 'erro', 'ignorado', 'fora_do_prazo', 'enviando'];

function directRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();

  /** Comentários recebidos (mais novos primeiro), com o produto do post e a mensagem que iria no Direct. */
  r.get('/comments', async (req, res) => {
    const filter = req.query.filter === 'pedidos' ? 'and c.matched = true' : req.query.filter === 'pendentes' ? `and c.status in ('novo','erro')` : '';
    const { rows } = await pool.query(
      `select c.*, q.permalink from ig_comments c left join queue_items q on q.id = c.queue_item_id
         where c.user_id = $1 ${filter} order by c.commented_at desc nulls last, c.id desc limit 200`, [req.uid]);
    const s = settingsOf((await pool.query('select * from users where id = $1', [req.uid])).rows[0]);
    const cache = new Map();
    const items = [];
    for (const c of rows) {
      if (!cache.has(c.media_id)) cache.set(c.media_id, await productsForMedia(pool, req.uid, c.media_id));
      const { products } = cache.get(c.media_id);
      const expired = c.commented_at && Date.now() - new Date(c.commented_at).getTime() > WINDOW_MS;
      items.push({
        id: c.id, username: c.username, text: c.text, commented_at: c.commented_at, matched: c.matched,
        status: expired && c.status === 'novo' ? 'fora_do_prazo' : c.status, error: c.error, sent_at: c.sent_at, reply_text: c.reply_text,
        permalink: c.permalink, products: products.map((p) => ({ id: p.id, title: p.title })),
        preview: c.status === 'enviado' ? null : buildMessage(s, c, products),
      });
    }
    const u = (await pool.query('select dm_synced_at from users where id = $1', [req.uid])).rows[0];
    res.json({ items, synced_at: u?.dm_synced_at || null });
  });

  /** Busca agora os comentários novos (e, no automático, já responde). */
  r.post('/sync', async (req, res) => {
    let fresh;
    try { fresh = await syncUser({ pool, cfg, fetchImpl, uid: req.uid }); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(e.rateLimited ? 429 : 502, `Não consegui ler os comentários: ${e.message}`);
    }
    const s = settingsOf((await pool.query('select * from users where id = $1', [req.uid])).rows[0]);
    const sent = s.auto ? await autoSend({ pool, cfg, fetchImpl, uid: req.uid, log: { error() {} } }) : 0;
    res.json({ fresh, sent });
  });

  /** Envia o link no Direct (mensagem pronta ou editada). */
  r.post('/comments/:id/send', async (req, res) => {
    const row = await sendFor({ pool, cfg, fetchImpl, uid: req.uid, commentRowId: Number(req.params.id), text: req.body?.text });
    res.json({ ok: true, status: row.status });
  });

  r.post('/comments/:id/ignore', async (req, res) => {
    const out = await pool.query(`update ig_comments set status = 'ignorado' where id = $1 and user_id = $2 and status <> 'enviado' returning id`, [Number(req.params.id), req.uid]);
    if (!out.rows.length) throw new HttpError(404, 'Comentário não encontrado.');
    res.json({ ok: true });
  });

  r.get('/settings', async (req, res) => {
    const s = settingsOf((await pool.query('select * from users where id = $1', [req.uid])).rows[0]);
    res.json({ settings: s, defaults: { keywords: DEFAULT_KEYWORDS, template: DEFAULT_TEMPLATE } });
  });

  r.put('/settings', async (req, res) => {
    const b = req.body || {};
    const kws = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[,\n]/)).map((k) => String(k).trim()).filter(Boolean).slice(0, 30);
    const template = String(b.template || '').trim();
    if (template && !template.includes('{link}')) throw new HttpError(400, 'A mensagem precisa ter {link}, onde entra o link do produto.');
    if (template.length > 900) throw new HttpError(400, 'Mensagem longa demais.');
    await pool.query('update users set dm_auto = $1, dm_keywords = $2, dm_template = $3, dm_public_reply = $4 where id = $5',
      [b.auto === true, kws.join(', ') || null, template || null, b.public_reply !== false, req.uid]);
    res.json({ settings: settingsOf((await pool.query('select * from users where id = $1', [req.uid])).rows[0]) });
  });

  return r;
}

module.exports = { directRoutes, STATUS };
