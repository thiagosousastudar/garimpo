const express = require('express');
const { HttpError } = require('../util');
const postauto = require('../services/postauto');
const { createInstagramClient } = require('../services/instagram');
const { settingsOf, matches, syncUser, sendFor, autoSend, productsForMedia, buildMessage, DEFAULT_KEYWORDS, DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_M, WINDOW_MS } = require('../services/igdm');

const STATUS = ['novo', 'enviado', 'erro', 'ignorado', 'fora_do_prazo', 'enviando'];

function directRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();

  /** Cliques dos links curtos por comentário: Map(comentário -> cliques). */
  async function clicksByComment(uid) {
    const { rows } = await pool.query('select ig_comment_id, clicks from tracked_links where user_id = $1 and ig_comment_id is not null', [uid]);
    const m = new Map();
    for (const x of rows) m.set(x.ig_comment_id, (m.get(x.ig_comment_id) || 0) + Number(x.clicks || 0));
    return m;
  }

  /** Comentários recebidos (mais novos primeiro), com o produto do post e a mensagem que iria no Direct. */
  r.get('/comments', async (req, res) => {
    const filter = req.query.filter === 'pedidos' ? 'and c.matched = true' : req.query.filter === 'pendentes' ? `and c.status in ('novo','erro')` : '';
    const { rows } = await pool.query(
      `select c.*, q.permalink from ig_comments c left join queue_items q on q.id = c.queue_item_id
         where c.user_id = $1 ${filter} order by c.commented_at desc nulls last, c.id desc limit 200`, [req.uid]);
    const s = settingsOf((await pool.query('select * from users where id = $1', [req.uid])).rows[0]);
    const cache = new Map();
    const clicks = await clicksByComment(req.uid);
    const items = [];
    const autos = new Map();
    for (const c of rows) {
      if (!cache.has(c.media_id)) cache.set(c.media_id, await productsForMedia(pool, req.uid, c.media_id));
      if (!autos.has(c.media_id)) {
        const a = await postauto.automationFor(pool, req.uid, c.media_id);
        autos.set(c.media_id, a ? { a, items: await postauto.resolveItems(pool, req.uid, a) } : null);
      }
      const au = autos.get(c.media_id);
      const { products } = cache.get(c.media_id);
      const expired = c.commented_at && Date.now() - new Date(c.commented_at).getTime() > WINDOW_MS;
      items.push({
        id: c.id, username: c.username, text: c.text, commented_at: c.commented_at, matched: c.matched,
        status: expired && c.status === 'novo' ? 'fora_do_prazo' : c.status, error: c.error, sent_at: c.sent_at, reply_text: c.reply_text,
        permalink: c.permalink, clicks: clicks.get(c.id) || 0, products: au ? au.items.map((it) => ({ id: it.product_id, title: it.name })) : products.map((p) => ({ id: p.id, title: p.title })),
        automation: Boolean(au),
        preview: c.status === 'enviado' ? null : au ? postauto.buildDirect(au.a, au.items, { nome: (c.username || '').replace(/^@/, ''), voice: s.voice }).text : buildMessage(s, c, products),
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
    res.json({ settings: s, defaults: { keywords: DEFAULT_KEYWORDS, template: s.voice === 'masculino' ? DEFAULT_TEMPLATE_M : DEFAULT_TEMPLATE } });
  });

  r.put('/settings', async (req, res) => {
    const b = req.body || {};
    const kws = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[,\n]/)).map((k) => String(k).trim()).filter(Boolean).slice(0, 30);
    const template = String(b.template || '').trim();
    if (template && !template.includes('{link}')) throw new HttpError(400, 'A mensagem precisa ter {link}, onde entra o link do produto.');
    if (template.length > 900) throw new HttpError(400, 'Mensagem longa demais.');
    await pool.query('update users set dm_auto = $1, dm_keywords = $2, dm_template = $3, dm_public_reply = $4, dm_track_links = $5 where id = $6',
      [b.auto === true, kws.join(', ') || null, template || null, b.public_reply !== false, b.track_links !== false, req.uid]);
    res.json({ settings: settingsOf((await pool.query('select * from users where id = $1', [req.uid])).rows[0]) });
  });

  /* ---------- Pessoas (mini-CRM) e relatório ---------- */
  const TZ = process.env.APP_TZ || 'America/Sao_Paulo';
  const hourOf = (d) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(d)));
  const weekdayOf = (d) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, weekday: 'short' }).format(new Date(d)).replace('.', '');

  /** Comentários do período com cliques e produtos do post. */
  async function commentRows(uid, sinceIso) {
    const { rows } = await pool.query(
      `select c.id, c.username, c.text, c.matched, c.status, c.commented_at, c.created_at, c.media_id, c.sent_at, q.permalink
         from ig_comments c left join queue_items q on q.id = c.queue_item_id
        where c.user_id = $1 ${sinceIso ? 'and coalesce(c.commented_at, c.created_at) >= $2' : ''}
        order by coalesce(c.commented_at, c.created_at) desc`, sinceIso ? [uid, sinceIso] : [uid]);
    const cache = new Map();
    const clicks = await clicksByComment(uid);
    for (const r of rows) {
      if (!cache.has(r.media_id)) cache.set(r.media_id, (await productsForMedia(pool, uid, r.media_id)).products);
      r.products = cache.get(r.media_id);
      r.clicks = clicks.get(r.id) || 0;
    }
    return rows;
  }

  /** Agrupa por pessoa (@). */
  function people(rows) {
    const by = new Map();
    for (const r of rows) {
      const key = String(r.username || '').toLowerCase();
      if (!key) continue;
      const p = by.get(key) || { username: r.username, comments: 0, requests: 0, sent: 0, clicks: 0, clicked_links: 0, products: new Map(), first_at: null, last_at: null };
      const at = r.commented_at || r.created_at;
      p.comments++;
      if (r.matched) p.requests++;
      if (r.status === 'enviado') p.sent++;
      p.clicks += r.clicks;
      if (r.clicks > 0) p.clicked_links++;
      if (r.matched) for (const pr of r.products) p.products.set(pr.id, pr.title);
      if (!p.first_at || at < p.first_at) p.first_at = at;
      if (!p.last_at || at > p.last_at) p.last_at = at;
      by.set(key, p);
    }
    return [...by.values()].map((p) => ({ ...p, products: [...p.products.values()], frequent: p.requests >= 3 }))
      .sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
  }

  r.get('/people', async (req, res) => {
    const q = String(req.query.q || '').toLowerCase().replace(/^@/, '');
    const list = people(await commentRows(req.uid)).filter((p) => !q || p.username.toLowerCase().includes(q) || p.products.some((t) => t.toLowerCase().includes(q)));
    res.json({ items: list.slice(0, 500), total: list.length });
  });

  r.get('/people.csv', async (req, res) => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const fmt = (d) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: TZ }) : '');
    const lines = [['instagram', 'pedidos', 'directs_enviados', 'cliques', 'produtos', 'primeiro_contato', 'ultimo_contato', 'cliente_frequente'].join(';')];
    for (const p of people(await commentRows(req.uid))) {
      lines.push([esc('@' + p.username), p.requests, p.sent, p.clicks, esc(p.products.join(' | ')), esc(fmt(p.first_at)), esc(fmt(p.last_at)), p.frequent ? 'sim' : 'não'].join(';'));
    }
    res.set('content-type', 'text/csv; charset=utf-8');
    res.set('content-disposition', 'attachment; filename="pessoas-direct.csv"');
    res.send('﻿' + lines.join('\n'));
  });

  /** Números do período: funil comentário → pedido → Direct → clique, produtos, posts e horários. */
  r.get('/report', async (req, res) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const rows = await commentRows(req.uid, new Date(Date.now() - days * 864e5).toISOString());
    const req2 = rows.filter((x) => x.matched);
    const sent = rows.filter((x) => x.status === 'enviado');
    const clicked = sent.filter((x) => x.clicks > 0);
    const count = (list, keyFn, labelFn) => {
      const m = new Map();
      for (const x of list) for (const k of [].concat(keyFn(x))) { if (k == null) continue; const e = m.get(k) || { key: k, label: labelFn(x, k), n: 0 }; e.n++; m.set(k, e); }
      return [...m.values()].sort((a, b) => b.n - a.n);
    };
    const topProducts = count(req2, (x) => x.products.map((p) => p.id), (x, k) => (x.products.find((p) => p.id === k) || {}).title).slice(0, 10);
    const topPosts = count(req2, (x) => x.media_id, (x) => x.permalink || null).slice(0, 10)
      .map((e) => ({ ...e, title: (rows.find((x) => x.media_id === e.key)?.products || []).map((p) => p.title).join(', ') || 'Post' }));
    const hours = Array.from({ length: 24 }, () => 0);
    const weekdays = {};
    for (const x of req2) { const at = x.commented_at || x.created_at; hours[hourOf(at)]++; const w = weekdayOf(at); weekdays[w] = (weekdays[w] || 0) + 1; }
    res.json({
      days,
      totals: {
        comments: rows.length, requests: req2.length, sent: sent.length,
        clicks: rows.reduce((a, x) => a + x.clicks, 0), people_clicked: clicked.length,
        people: new Set(req2.map((x) => String(x.username || '').toLowerCase())).size,
        click_rate: sent.length ? Math.round((clicked.length / sent.length) * 100) : 0,
      },
      top_products: topProducts, top_posts: topPosts, hours, weekdays,
    });
  });

  /* ---------- automações por post ---------- */
  const MEDIA_ID = /^[A-Za-z0-9_]{2,40}$/;
  const mediaIdOf = (req) => {
    const id = String(req.params.mediaId || '');
    if (!MEDIA_ID.test(id)) throw new HttpError(400, 'Post inválido.');
    return id;
  };

  /** Todos os posts e Reels da conta, com curtidas, comentários, pedidos pendentes e a automação (se houver). */
  r.get('/posts', async (req, res) => {
    const { credentialsFor } = require('../services/publisher');
    let creds;
    try { creds = await credentialsFor(pool, cfg, req.uid); } catch (_) { throw new HttpError(400, 'Conecte o Instagram na aba Conexões.'); }
    let media;
    try { media = await createInstagramClient({ cfg, fetchImpl }).allMedia({ igUserId: creds.igUserId, token: creds.token, limit: 30 }); }
    catch (e) { throw new HttpError(e.rateLimited ? 429 : 502, `O Instagram não respondeu: ${e.message}`); }
    const autos = new Map((await pool.query('select * from post_automations where user_id = $1', [req.uid])).rows.map((x) => [x.media_id, postauto.parse(x)]));
    const pend = new Map();
    for (const x of (await pool.query(`select media_id from ig_comments where user_id = $1 and matched = true and status in ('novo','erro')`, [req.uid])).rows) {
      pend.set(x.media_id, (pend.get(x.media_id) || 0) + 1);
    }
    const posts = [];
    for (const m of media) {
      const a = autos.get(m.id);
      const { products } = await productsForMedia(pool, req.uid, m.id);
      posts.push({
        id: m.id, permalink: m.permalink || null, media_type: m.media_type || null,
        thumb: (m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url) || m.thumbnail_url || null,
        caption: String(m.caption || '').slice(0, 160), likes: Number(m.like_count) || 0, comments: Number(m.comments_count) || 0, timestamp: m.timestamp || null,
        automation: a ? { active: a.active, items: a.items.length, keywords: a.keywords } : null,
        garimpo_products: products.length, pending: pend.get(m.id) || 0,
      });
    }
    res.json({ posts });
  });

  /** Automação do post para editar; sem automação, sugestão com os produtos que o Garimpo publicou nele. */
  r.get('/automations/:mediaId', async (req, res) => {
    const id = mediaIdOf(req);
    const s = settingsOf((await pool.query('select * from users where id = $1', [req.uid])).rows[0]);
    const a = await postauto.automationFor(pool, req.uid, id, { onlyActive: false });
    const titles = new Map((await pool.query('select id, title, affiliate_url, product_url, marketplace from products where user_id = $1', [req.uid])).rows.map((p) => [p.id, p]));
    const show = (x) => {
      if (!x.product_id) return { name: x.name, link: x.link };
      const p = titles.get(x.product_id);
      return { product_id: x.product_id, name: x.name || (p && p.title) || 'Produto removido', link: p ? p.affiliate_url || p.product_url : null, missing: !p };
    };
    if (a) return res.json({ automation: { ...a, items: a.items.map(show) }, voice: s.voice });
    const { products } = await productsForMedia(pool, req.uid, id);
    res.json({
      automation: null, voice: s.voice,
      suggestion: { keywords: ['EU QUERO', 'QUERO'], replies: 'AUTO', dm_text: '', button_text: '', active: true, items: products.map((p) => show({ product_id: p.id })) },
    });
  });

  r.put('/automations/:mediaId', async (req, res) => {
    const id = mediaIdOf(req);
    const d = await postauto.cleanAutomation(pool, req.uid, req.body || {});
    const cur = (await pool.query('select id from post_automations where user_id = $1 and media_id = $2', [req.uid, id])).rows[0];
    const vals = [d.keywords, d.replies, d.dm_text, d.button_text, JSON.stringify(d.items), d.active, d.permalink, d.thumb_url, d.caption];
    if (cur) {
      await pool.query(`update post_automations set keywords = $1, replies = $2, dm_text = $3, button_text = $4, items = $5, active = $6,
          permalink = coalesce($7, permalink), thumb_url = coalesce($8, thumb_url), caption = coalesce($9, caption), updated_at = now() where id = $10`, [...vals, cur.id]);
    } else {
      await pool.query(`insert into post_automations (keywords, replies, dm_text, button_text, items, active, permalink, thumb_url, caption, user_id, media_id)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [...vals, req.uid, id]);
    }
    // comentários que ainda não foram respondidos passam a valer pela palavra do post
    const kws = d.keywords.split(',').map((k) => k.trim()).filter(Boolean);
    for (const c of (await pool.query(`select id, text from ig_comments where user_id = $1 and media_id = $2 and status = 'novo'`, [req.uid, id])).rows) {
      await pool.query('update ig_comments set matched = $1 where id = $2', [matches(c.text, kws), c.id]);
    }
    const a = await postauto.automationFor(pool, req.uid, id, { onlyActive: false });
    res.json({ automation: a });
  });

  r.delete('/automations/:mediaId', async (req, res) => {
    const id = mediaIdOf(req);
    await pool.query('delete from post_automations where user_id = $1 and media_id = $2', [req.uid, id]);
    res.json({ ok: true });
  });

  /** Como a mensagem vai chegar no Direct (com os dados da tela, antes de salvar). */
  r.post('/automations/:mediaId/preview', async (req, res) => {
    mediaIdOf(req);
    const s = settingsOf((await pool.query('select * from users where id = $1', [req.uid])).rows[0]);
    const d = await postauto.cleanAutomation(pool, req.uid, req.body || {});
    const a = postauto.parse({ ...d, items: JSON.stringify(d.items) });
    const items = await postauto.resolveItems(pool, req.uid, a);
    const built = postauto.buildDirect(a, items, { nome: 'fulano', voice: s.voice });
    const btns = built.message.attachment ? built.message.attachment.payload.buttons.map((b) => b.title) : [];
    res.json({ text: built.text, buttons: btns, public_reply: postauto.publicReply(a, s.voice) });
  });

  return r;
}

module.exports = { directRoutes, STATUS };
