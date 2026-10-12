const express = require('express');
const { HttpError, parseNum, parseCsv } = require('../util');
const { scoreProduct } = require('../services/score');
const { externalIdFrom, freshData } = require('../services/garimpo');

const MARKETS = { ml: 'ML', 'mercado livre': 'ML', mercadolivre: 'ML', sh: 'SH', shopee: 'SH' };

function mapProduct(row) {
  const p = {
    ...row,
    price: Number(row.price),
    original_price: row.original_price === null ? null : Number(row.original_price),
    rating: row.rating === null ? null : Number(row.rating),
    sales_k: row.sales_k === null ? null : Number(row.sales_k),
    commission_pct: row.commission_pct === null ? null : Number(row.commission_pct),
  };
  return { ...p, ...scoreProduct(p) };
}

function cleanUrl(v, field) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.startsWith('/uploads/')) return s;
  let u;
  try { u = new URL(s); } catch (_) { throw new HttpError(400, `${field}: endereço inválido.`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, `${field}: use um endereço http(s).`);
  return u.toString();
}

/** Valida e normaliza o corpo. Em "partial" só valida os campos enviados. */
function parseBody(b, partial = false) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('title')) {
    const t = String(b.title || '').trim();
    if (!t) throw new HttpError(400, 'Informe o nome do produto.');
    out.title = t.slice(0, 300);
  }
  if (!partial || has('marketplace')) {
    const m = MARKETS[String(b.marketplace || '').trim().toLowerCase()];
    if (!m) throw new HttpError(400, 'Marketplace deve ser Mercado Livre (ML) ou Shopee (SH).');
    out.marketplace = m;
  }
  if (!partial || has('price')) {
    const n = parseNum(b.price);
    if (n === null || n <= 0) throw new HttpError(400, 'Informe um preço maior que zero.');
    out.price = n;
  }
  const nums = [
    ['original_price', 0, 1e9], ['rating', 0, 5], ['sales_k', 0, 1e6], ['commission_pct', 0, 100],
  ];
  for (const [k, min, max] of nums) {
    if (has(k)) {
      const n = parseNum(b[k]);
      if (b[k] !== '' && b[k] !== null && (n === null || n < min || n > max)) {
        throw new HttpError(400, `${k}: valor fora do intervalo ${min}-${max}.`);
      }
      out[k] = n;
    }
  }
  for (const k of ['category', 'notes']) if (has(k)) out[k] = String(b[k] ?? '').trim().slice(0, 500) || null;
  for (const k of ['product_url', 'affiliate_url', 'image_url', 'video_url']) if (has(k)) out[k] = cleanUrl(b[k], k);
  return out;
}

const COLS = ['title', 'marketplace', 'category', 'price', 'original_price', 'rating', 'sales_k',
  'commission_pct', 'product_url', 'affiliate_url', 'image_url', 'video_url', 'notes'];

const DUPLICATE = 'Este produto já está cadastrado.';

/** Procura o mesmo produto já cadastrado (mesmo código na loja ou mesmo link). */
async function findDuplicate(pool, uid, { marketplace, external_id, product_url }, exceptId = 0) {
  if (!external_id && !product_url) return null;
  const { rows } = await pool.query(
    `select id from products where user_id = $1 and id <> $2 and (
       (marketplace = $3 and external_id = $4) or product_url = $5) limit 1`,
    [uid, exceptId, marketplace, external_id || '', product_url || '']
  );
  return rows[0] ? rows[0].id : null;
}

/**
 * Cadastra um produto já validado. Calcula o código da loja pelo link (ou usa o informado pelo garimpo)
 * e recusa duplicados com 409. A data de conferência do preço começa agora.
 */
async function insertProduct(pool, uid, d, externalId) {
  const ext = externalId || externalIdFrom(d.marketplace, d.product_url) || externalIdFrom(d.marketplace, d.affiliate_url);
  const dup = await findDuplicate(pool, uid, { ...d, external_id: ext });
  if (dup) { const e = new HttpError(409, DUPLICATE); e.existingId = dup; throw e; }
  const cols = COLS.filter((c) => d[c] !== undefined);
  const vals = cols.map((c) => d[c]);
  try {
    const { rows } = await pool.query(
      `insert into products (user_id, external_id, price_checked_at, ${cols.join(',')})
         values ($1, $2, now(), ${cols.map((_, i) => `$${i + 3}`).join(',')}) returning *`,
      [uid, ext, ...vals]
    );
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, DUPLICATE);
    throw e;
  }
}

function productRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const { rows } = await pool.query('select * from products where user_id = $1 order by created_at desc, id desc', [req.uid]);
    const items = rows.map(mapProduct).sort((a, b) => b.score - a.score);
    res.json({ products: items });
  });

  r.post('/', async (req, res) => {
    const row = await insertProduct(pool, req.uid, parseBody(req.body || {}));
    res.status(201).json({ product: mapProduct(row) });
  });

  r.patch('/:id', async (req, res) => {
    const id = Number(req.params.id);
    const d = parseBody(req.body || {}, true);
    const cols = COLS.filter((c) => d[c] !== undefined);
    if (!cols.length) throw new HttpError(400, 'Nada para atualizar.');
    const cur = (await pool.query('select * from products where id = $1 and user_id = $2', [id, req.uid])).rows[0];
    if (!cur) throw new HttpError(404, 'Produto não encontrado.');
    const next = { ...cur, ...d };
    const extra = {};
    if (d.product_url !== undefined || d.affiliate_url !== undefined || d.marketplace !== undefined) {
      extra.external_id = externalIdFrom(next.marketplace, next.product_url) || externalIdFrom(next.marketplace, next.affiliate_url)
        || (d.marketplace === undefined ? cur.external_id : null);
      if (await findDuplicate(pool, req.uid, { ...next, ...extra }, id)) throw new HttpError(409, DUPLICATE);
    }
    const priceChanged = (d.price !== undefined && Number(d.price) !== Number(cur.price))
      || (d.original_price !== undefined && Number(d.original_price) !== Number(cur.original_price));
    const all = [...cols.map((c) => [c, d[c]]), ...Object.entries(extra)];
    const sets = all.map(([c], i) => `${c} = $${i + 3}`).concat(priceChanged ? ['price_checked_at = now()'] : []).join(', ');
    let rows;
    try {
      ({ rows } = await pool.query(`update products set ${sets} where id = $1 and user_id = $2 returning *`, [id, req.uid, ...all.map(([, v]) => v)]));
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, DUPLICATE);
      throw e;
    }
    res.json({ product: mapProduct(rows[0]) });
  });

  /** Busca na loja o preço atual (e o desconto) e grava, para não divulgar preço velho. */
  r.post('/:id/refresh', async (req, res) => {
    const id = Number(req.params.id);
    const cur = (await pool.query('select * from products where id = $1 and user_id = $2', [id, req.uid])).rows[0];
    if (!cur) throw new HttpError(404, 'Produto não encontrado.');
    const fresh = await freshData({ pool, cfg, fetchImpl, uid: req.uid, product: cur });
    const sets = ['price = $3', 'original_price = $4', 'price_checked_at = now()'];
    const vals = [fresh.price, fresh.original_price];
    // Só sobrescreve o que a loja informou; a comissão e a avaliação digitadas pelo usuário ficam se a loja não mandar.
    for (const k of ['rating', 'sales_k', 'commission_pct']) {
      if (fresh[k] !== null && fresh[k] !== undefined && !(k === 'commission_pct' && cur.marketplace === 'ML')) {
        vals.push(fresh[k]); sets.push(`${k} = $${vals.length + 2}`);
      }
    }
    const { rows } = await pool.query(`update products set ${sets.join(', ')} where id = $1 and user_id = $2 returning *`, [id, req.uid, ...vals]);
    res.json({ product: mapProduct(rows[0]), previous_price: Number(cur.price) });
  });

  r.delete('/:id', async (req, res) => {
    const out = await pool.query('delete from products where id = $1 and user_id = $2 returning id', [Number(req.params.id), req.uid]);
    if (!out.rows.length) throw new HttpError(404, 'Produto não encontrado.');
    res.json({ ok: true });
  });

  /**
   * Importa CSV (corpo text/csv). Colunas: titulo, marketplace, categoria, preco, preco_original,
   * avaliacao, vendas_mil, comissao, link, link_afiliado, imagem, video.
   */
  r.post('/import', async (req, res) => {
    if (typeof req.body !== 'string') throw new HttpError(400, 'Envie o conteúdo do CSV (Content-Type: text/csv).');
    const rows = parseCsv(req.body);
    if (!rows.length) throw new HttpError(400, 'O CSV está vazio.');
    let imported = 0;
    let skipped = 0;
    const errors = [];
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      try {
        const d = parseBody({
          title: c.titulo || c.produto || c.title,
          marketplace: c.marketplace || c.loja,
          category: c.categoria,
          price: c.preco,
          original_price: c.preco_original,
          rating: c.avaliacao,
          sales_k: c.vendas_mil,
          commission_pct: c.comissao,
          product_url: c.link,
          affiliate_url: c.link_afiliado,
          image_url: c.imagem,
          video_url: c.video,
        });
        await insertProduct(pool, req.uid, d);
        imported++;
      } catch (e) {
        if (e.status === 409) skipped++;
        else errors.push({ line: i + 2, error: e.message });
      }
    }
    res.json({ imported, skipped, errors });
  });

  return r;
}

module.exports = { productRoutes, mapProduct, parseBody, insertProduct };
