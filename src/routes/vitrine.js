const express = require('express');
const jwt = require('jsonwebtoken');
const { HttpError } = require('../util');
const { BOTS } = require('../services/links');
const { THEME_NAMES, publicProduct, renderStore, renderPost, renderMissing, httpsUrl } = require('../services/vitrine');

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED = new Set(['api', 'r', 'v', 'admin', 'garimpo', 'login', 'www', 'app', 'vitrine', 'static', 'uploads']);
const MAX_SECTIONS = 20;
const MAX_ITEMS = 60;

const itemsOf = (row) => { try { const v = JSON.parse(row.items || '[]'); return Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []; } catch (_) { return []; } };
const text = (v, n) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n) : null; };

/** Endereço sugerido a partir do @ do Instagram ou do nome. */
function suggestSlug(s) {
  const out = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return SLUG.test(out) && !RESERVED.has(out) ? out : '';
}

function sectionView(row) {
  return { id: row.id, name: row.name, emoji: row.emoji, description: row.description, position: row.position, items: itemsOf(row) };
}

/* ---------- controle (logado) ---------- */
function vitrineRoutes({ pool, cfg }) {
  const r = express.Router();
  const urlOf = (slug) => `${cfg.appUrl}/v/${slug}`;

  async function ownIds(uid) {
    return new Set((await pool.query('select id from products where user_id = $1', [uid])).rows.map((p) => p.id));
  }
  async function cleanItems(uid, raw) {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw new HttpError(400, 'Lista de produtos inválida.');
    const ids = [...new Set(raw.map(Number))];
    if (ids.length > MAX_ITEMS) throw new HttpError(400, `No máximo ${MAX_ITEMS} produtos por categoria.`);
    const own = await ownIds(uid);
    if (ids.some((id) => !own.has(id))) throw new HttpError(400, 'Algum produto não existe mais.');
    return ids;
  }

  r.get('/', async (req, res) => {
    const s = (await pool.query('select * from storefronts where user_id = $1', [req.uid])).rows[0] || null;
    const sections = (await pool.query('select * from storefront_sections where user_id = $1 order by position, id', [req.uid])).rows.map(sectionView);
    let suggestion = '';
    if (!s) {
      const c = (await pool.query('select ig_username from connections where user_id = $1', [req.uid])).rows[0];
      const u = (await pool.query('select name from users where id = $1', [req.uid])).rows[0];
      suggestion = suggestSlug(c?.ig_username) || suggestSlug(u?.name) || '';
    }
    res.json({
      store: s && { slug: s.slug, title: s.title, bio: s.bio, theme: s.theme, avatar_url: s.avatar_url, whatsapp_url: s.whatsapp_url, telegram_url: s.telegram_url,
        instagram: s.instagram, published: s.published, views: s.views, url: urlOf(s.slug) },
      sections, suggestion, themes: THEME_NAMES,
    });
  });

  r.put('/', async (req, res) => {
    const b = req.body || {};
    const slug = String(b.slug || '').trim().toLowerCase();
    if (!SLUG.test(slug)) throw new HttpError(400, 'O endereço deve ter de 3 a 30 letras minúsculas, números ou hífen (ex.: anninha-achados).');
    if (RESERVED.has(slug)) throw new HttpError(400, 'Esse endereço é reservado. Escolha outro.');
    const taken = (await pool.query('select user_id from storefronts where slug = $1', [slug])).rows[0];
    if (taken && taken.user_id !== req.uid) throw new HttpError(409, 'Esse endereço já está em uso. Escolha outro.');
    const title = text(b.title, 60);
    if (!title) throw new HttpError(400, 'Dê um nome para a vitrine.');
    const theme = THEME_NAMES.includes(b.theme) ? b.theme : 'rosa';
    const link = (v, re, msg) => { const s = text(v, 300); if (!s) return null; if (!httpsUrl(s) || (re && !re.test(s))) throw new HttpError(400, msg); return s; };
    const avatar = link(b.avatar_url, null, 'A foto precisa ser um link que começa com https://.');
    const wa = link(b.whatsapp_url, /^https:\/\/(chat\.whatsapp\.com|wa\.me|whatsapp\.com\/channel|www\.whatsapp\.com\/channel)\//i, 'O link do WhatsApp deve ser de grupo (chat.whatsapp.com/…), canal ou wa.me.');
    const tg = link(b.telegram_url, /^https:\/\/(t\.me|telegram\.me)\//i, 'O link do Telegram deve começar com https://t.me/.');
    const ig = text(String(b.instagram || '').replace(/^@/, ''), 30);
    if (ig && !/^[A-Za-z0-9._]{1,30}$/.test(ig)) throw new HttpError(400, 'O @ do Instagram tem letras, números, ponto ou _.');
    await pool.query(
      `insert into storefronts (user_id, slug, title, bio, theme, avatar_url, whatsapp_url, telegram_url, instagram, published, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       on conflict (user_id) do update set slug = excluded.slug, title = excluded.title, bio = excluded.bio, theme = excluded.theme,
         avatar_url = excluded.avatar_url, whatsapp_url = excluded.whatsapp_url, telegram_url = excluded.telegram_url,
         instagram = excluded.instagram, published = excluded.published, updated_at = now()`,
      [req.uid, slug, title, text(b.bio, 200), theme, avatar, wa, tg, ig, Boolean(b.published)]
    );
    res.json({ ok: true, url: urlOf(slug) });
  });

  r.post('/sections', async (req, res) => {
    const name = text(req.body?.name, 40);
    if (!name) throw new HttpError(400, 'Dê um nome para a categoria.');
    const n = (await pool.query('select count(*)::int n, coalesce(max(position), 0)::int m from storefront_sections where user_id = $1', [req.uid])).rows[0];
    if (n.n >= MAX_SECTIONS) throw new HttpError(400, `No máximo ${MAX_SECTIONS} categorias.`);
    const items = (await cleanItems(req.uid, req.body?.items)) || [];
    const row = (await pool.query(
      'insert into storefront_sections (user_id, name, emoji, description, position, items) values ($1,$2,$3,$4,$5,$6) returning *',
      [req.uid, name, text(req.body?.emoji, 8), text(req.body?.description, 140), n.m + 1, JSON.stringify(items)]
    )).rows[0];
    res.json({ section: sectionView(row) });
  });

  r.put('/sections/:id', async (req, res) => {
    const cur = (await pool.query('select * from storefront_sections where id = $1 and user_id = $2', [Number(req.params.id) || 0, req.uid])).rows[0];
    if (!cur) throw new HttpError(404, 'Categoria não encontrada.');
    const b = req.body || {};
    const name = b.name === undefined ? cur.name : text(b.name, 40);
    if (!name) throw new HttpError(400, 'Dê um nome para a categoria.');
    const items = await cleanItems(req.uid, b.items);
    const row = (await pool.query(
      'update storefront_sections set name = $1, emoji = $2, description = $3, items = $4 where id = $5 returning *',
      [name, b.emoji === undefined ? cur.emoji : text(b.emoji, 8), b.description === undefined ? cur.description : text(b.description, 140),
        items === undefined ? cur.items : JSON.stringify(items), cur.id]
    )).rows[0];
    res.json({ section: sectionView(row) });
  });

  /** Nova ordem das categorias: { ids: [3, 1, 2] }. */
  r.put('/order', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    for (let i = 0; i < ids.length; i++) {
      await pool.query('update storefront_sections set position = $1 where id = $2 and user_id = $3', [i + 1, ids[i], req.uid]);
    }
    res.json({ ok: true });
  });

  r.delete('/sections/:id', async (req, res) => {
    await pool.query('delete from storefront_sections where id = $1 and user_id = $2', [Number(req.params.id) || 0, req.uid]);
    res.json({ ok: true });
  });

  return r;
}

/* ---------- páginas públicas ---------- */
function publicVitrineRoutes({ pool, cfg }) {
  const r = express.Router();

  /** Vitrine pelo endereço; não publicada só aparece para a dona (prévia). */
  async function storeFor(req) {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!SLUG.test(slug)) return {};
    const s = (await pool.query('select * from storefronts where slug = $1', [slug])).rows[0];
    if (!s) return {};
    let owner = false;
    try { owner = jwt.verify(req.cookies?.garimpo_session || '', cfg.jwtSecret).uid === s.user_id; } catch (_) { owner = false; }
    if (!s.published && !owner) return {};
    return { s, preview: !s.published };
  }
  const human = (req) => !BOTS.test(String(req.headers['user-agent'] || ''));
  const send = (res, status, html, cache) => {
    res.status(status).set('content-type', 'text/html; charset=utf-8').set('cache-control', cache ? 'public, max-age=60, s-maxage=60' : 'no-store').send(html);
  };
  const productsOf = async (uid) => new Map((await pool.query('select * from products where user_id = $1', [uid])).rows.map((p) => [p.id, p]));

  r.get('/:slug', async (req, res) => {
    const { s, preview } = await storeFor(req);
    if (!s) return send(res, 404, renderMissing('Essa vitrine não existe ou ainda não foi publicada.'));
    const prods = await productsOf(s.user_id);
    const sections = (await pool.query('select * from storefront_sections where user_id = $1 order by position, id', [s.user_id])).rows.map((x) => ({
      id: x.id, name: x.name, emoji: x.emoji, description: x.description,
      products: itemsOf(x).map((id) => prods.get(id)).filter(Boolean).map((p) => publicProduct(p)),
    }));
    const lists = (await pool.query('select id, name, items from link_lists where user_id = $1 order by updated_at desc, id desc limit 6', [s.user_id])).rows;
    const posts = lists.map((l) => {
      let ids = []; try { ids = JSON.parse(l.items || '[]').map((i) => i.product_id); } catch (_) { ids = []; }
      const ps = ids.map((id) => prods.get(id)).filter(Boolean);
      return { id: l.id, name: l.name, count: ps.length, image: httpsUrl((ps.find((p) => p.image_url) || {}).image_url) };
    }).filter((p) => p.count);
    if (!preview && human(req)) await pool.query('update storefronts set views = views + 1 where user_id = $1', [s.user_id]);
    const base = `/v/${s.slug}`;
    send(res, 200, renderStore({ store: s, sections, posts, base, url: `${cfg.appUrl}${base}`, preview }), !preview);
  });

  r.get('/:slug/p/:id', async (req, res) => {
    const { s, preview } = await storeFor(req);
    if (!s) return send(res, 404, renderMissing('Essa página não existe ou ainda não foi publicada.'));
    const list = (await pool.query('select * from link_lists where id = $1 and user_id = $2', [Number(req.params.id) || 0, s.user_id])).rows[0];
    if (!list) return send(res, 404, renderMissing('Esse post não está mais disponível.'));
    const prods = await productsOf(s.user_id);
    let items = []; try { items = JSON.parse(list.items || '[]'); } catch (_) { items = []; }
    const products = items.filter((i) => prods.has(i.product_id)).map((i) => publicProduct(prods.get(i.product_id), i.name));
    const base = `/v/${s.slug}`;
    send(res, 200, renderPost({ store: s, list, products, base, url: `${cfg.appUrl}${base}/p/${list.id}`, preview }), !preview);
  });

  /** Botão do produto: conta o clique (gente, não robô) e leva ao link de afiliado. */
  r.get('/:slug/ir/:pid', async (req, res) => {
    const { s, preview } = await storeFor(req);
    if (!s) return send(res, 404, renderMissing('Link indisponível.'));
    const p = (await pool.query('select id, affiliate_url, product_url from products where id = $1 and user_id = $2', [Number(req.params.pid) || 0, s.user_id])).rows[0];
    const target = p && (httpsUrl(p.affiliate_url) || httpsUrl(p.product_url));
    if (!target) return send(res, 404, renderMissing('Esse produto não está mais disponível.'));
    if (!preview && human(req)) await pool.query('update products set vitrine_clicks = vitrine_clicks + 1 where id = $1', [p.id]);
    res.set('cache-control', 'no-store').set('x-robots-tag', 'noindex').redirect(302, target);
  });

  return r;
}

module.exports = { vitrineRoutes, publicVitrineRoutes, suggestSlug };
