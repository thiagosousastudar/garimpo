const express = require('express');
const { HttpError, parseNum, parseCsv } = require('../util');
const { scoreProduct } = require('../services/score');

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

function productRoutes({ pool }) {
  const r = express.Router();

  r.get('/', async (req, res) => {
    const { rows } = await pool.query('select * from products where user_id = $1 order by created_at desc, id desc', [req.uid]);
    const items = rows.map(mapProduct).sort((a, b) => b.score - a.score);
    res.json({ products: items });
  });

  r.post('/', async (req, res) => {
    const d = parseBody(req.body || {});
    const cols = COLS.filter((c) => d[c] !== undefined);
    const vals = cols.map((c) => d[c]);
    const { rows } = await pool.query(
      `insert into products (user_id, ${cols.join(',')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(',')}) returning *`,
      [req.uid, ...vals]
    );
    res.status(201).json({ product: mapProduct(rows[0]) });
  });

  r.patch('/:id', async (req, res) => {
    const d = parseBody(req.body || {}, true);
    const cols = COLS.filter((c) => d[c] !== undefined);
    if (!cols.length) throw new HttpError(400, 'Nada para atualizar.');
    const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
    const { rows } = await pool.query(
      `update products set ${sets} where id = $1 and user_id = $2 returning *`,
      [Number(req.params.id), req.uid, ...cols.map((c) => d[c])]
    );
    if (!rows.length) throw new HttpError(404, 'Produto não encontrado.');
    res.json({ product: mapProduct(rows[0]) });
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
        const cols = COLS.filter((k) => d[k] !== undefined);
        await pool.query(
          `insert into products (user_id, ${cols.join(',')}) values ($1, ${cols.map((_, j) => `$${j + 2}`).join(',')})`,
          [req.uid, ...cols.map((k) => d[k])]
        );
        imported++;
      } catch (e) {
        errors.push({ line: i + 2, error: e.message });
      }
    }
    res.json({ imported, errors });
  });

  return r;
}

module.exports = { productRoutes, mapProduct };
