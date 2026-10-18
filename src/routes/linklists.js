const express = require('express');
const { HttpError } = require('../util');

const MAX_ITEMS = 30;

/** Itens guardados ({ product_id, name }) a partir do texto da coluna. */
function itemsOf(row) {
  try { const v = JSON.parse(row.items || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

/**
 * Listas de links: os produtos de um post (ex.: carrossel) com o nome curto de cada um, para montar
 * a mensagem "Cheguei com os links que você pediu" sem procurar produto por produto.
 */
function linkListRoutes({ pool }) {
  const r = express.Router();

  /** Confere o corpo e se os produtos são do usuário. */
  async function clean(uid, b) {
    const name = String(b?.name || '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Dê um nome para a lista (ex.: Post cozinha organizada).');
    const raw = Array.isArray(b?.items) ? b.items : [];
    if (!raw.length) throw new HttpError(400, 'Escolha pelo menos um produto.');
    if (raw.length > MAX_ITEMS) throw new HttpError(400, `No máximo ${MAX_ITEMS} produtos por lista.`);
    const items = raw.map((x) => ({ product_id: Number(x?.product_id), name: String(x?.name || '').trim().slice(0, 80) }));
    if (items.some((x) => !Number.isInteger(x.product_id) || x.product_id < 1)) throw new HttpError(400, 'Produto inválido na lista.');
    const ids = [...new Set(items.map((x) => x.product_id))];
    const own = new Set((await pool.query('select id from products where user_id = $1', [uid])).rows.map((p) => p.id));
    const mine = ids.filter((id) => own.has(id)).length;
    if (mine !== ids.length) throw new HttpError(400, 'Algum produto da lista não existe mais.');
    const text = (v) => (v == null ? null : String(v).slice(0, 500));
    return { name, items, greeting: text(b.greeting), closing: text(b.closing) };
  }

  /** Lista com o link atual de cada produto (o link de afiliado pode ter sido trocado depois). */
  async function view(uid, rows) {
    const ids = [...new Set(rows.flatMap((x) => itemsOf(x).map((i) => i.product_id)))];
    const prods = ids.length
      ? (await pool.query('select id, title, affiliate_url, product_url, image_url from products where user_id = $1', [uid])).rows.filter((p) => ids.includes(p.id))
      : [];
    const by = new Map(prods.map((p) => [p.id, p]));
    // com vitrine criada, cada lista tem a sua página (/v/endereco/p/id)
    const slug = (await pool.query('select slug from storefronts where user_id = $1', [uid])).rows[0]?.slug || null;
    return rows.map((x) => ({
      id: x.id, name: x.name, greeting: x.greeting, closing: x.closing, updated_at: x.updated_at,
      page_path: slug ? `/v/${slug}/p/${x.id}` : null,
      items: itemsOf(x).filter((i) => by.has(i.product_id)).map((i) => {
        const p = by.get(i.product_id);
        return { product_id: p.id, name: i.name || p.title, title: p.title, link: p.affiliate_url || p.product_url || null, has_affiliate: Boolean(p.affiliate_url), image_url: p.image_url };
      }),
    }));
  }

  r.get('/', async (req, res) => {
    const rows = (await pool.query('select * from link_lists where user_id = $1 order by updated_at desc, id desc', [req.uid])).rows;
    res.json({ lists: await view(req.uid, rows) });
  });

  r.post('/', async (req, res) => {
    const d = await clean(req.uid, req.body);
    const row = (await pool.query(
      'insert into link_lists (user_id, name, items, greeting, closing) values ($1,$2,$3,$4,$5) returning *',
      [req.uid, d.name, JSON.stringify(d.items), d.greeting, d.closing]
    )).rows[0];
    res.json({ list: (await view(req.uid, [row]))[0] });
  });

  r.put('/:id', async (req, res) => {
    const d = await clean(req.uid, req.body);
    const row = (await pool.query(
      'update link_lists set name = $1, items = $2, greeting = $3, closing = $4, updated_at = now() where id = $5 and user_id = $6 returning *',
      [d.name, JSON.stringify(d.items), d.greeting, d.closing, Number(req.params.id) || 0, req.uid]
    )).rows[0];
    if (!row) throw new HttpError(404, 'Lista não encontrada.');
    res.json({ list: (await view(req.uid, [row]))[0] });
  });

  r.delete('/:id', async (req, res) => {
    await pool.query('delete from link_lists where id = $1 and user_id = $2', [Number(req.params.id) || 0, req.uid]);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { linkListRoutes };
