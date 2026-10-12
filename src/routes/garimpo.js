const express = require('express');
const { HttpError, parseNum } = require('../util');
const { search, trends, categories, enrich } = require('../services/garimpo');
const { serializeExtras } = require('../services/extras');
const { parseBody, insertProduct, mapProduct } = require('./products');

const MARKETS = ['ML', 'SH'];
const SORTS = ['relevancia', 'vendidos', 'comissao', 'preco', 'nota'];
const EXTERNAL_ID = { ML: /^MLB\d+$/, SH: /^\d+\.\d+$/ };

/** Garimpo sob demanda: busca nas lojas na hora em que o usuário pede e salva só o que ele escolher. */
function garimpoRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();

  r.post('/search', async (req, res) => {
    const b = req.body || {};
    const marketplace = String(b.marketplace || '').toUpperCase();
    if (!MARKETS.includes(marketplace)) throw new HttpError(400, 'Escolha Mercado Livre ou Shopee.');
    const q = String(b.q || '').trim().slice(0, 120);
    const category = b.category ? String(b.category) : null;
    if (category && !/^MLB\d+$/.test(category)) throw new HttpError(400, 'Categoria inválida.');
    if (!category && q.length < 2) throw new HttpError(400, 'Digite o que você quer garimpar (pelo menos 2 letras).');
    const page = Math.min(Math.max(1, Number(b.page) || 1), 20);
    const sort = SORTS.includes(b.sort) ? b.sort : 'relevancia';
    const out = await search({
      pool, cfg, fetchImpl, uid: req.uid, marketplace, q, category, page, sort,
      minDiscount: parseNum(b.min_discount) || 0,
      minCommission: parseNum(b.min_commission) || 0,
      minRating: parseNum(b.min_rating) || 0,
      freeShipping: b.free_shipping === true,
    });
    res.json(out);
  });

  /** O que está em alta nas buscas do Mercado Livre (geral ou de uma categoria). */
  r.get('/trends', async (req, res) => {
    const category = req.query.category ? String(req.query.category) : null;
    if (category && !/^MLB\d+$/.test(category)) throw new HttpError(400, 'Categoria inválida.');
    res.json({ trends: await trends({ pool, cfg, fetchImpl, uid: req.uid, category }) });
  });

  r.get('/categories', async (req, res) => {
    res.json({ categories: await categories({ pool, cfg, fetchImpl, uid: req.uid }) });
  });

  /** Salva os itens escolhidos no resultado do garimpo. Duplicados são pulados. */
  r.post('/save', async (req, res) => {
    const list = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!list.length) throw new HttpError(400, 'Selecione pelo menos um produto.');
    if (list.length > 50) throw new HttpError(400, 'Salve no máximo 50 produtos por vez.');
    const saved = [];
    let skipped = 0;
    const errors = [];
    const full = await enrich({ pool, cfg, fetchImpl, uid: req.uid, items: list.filter((x) => x && typeof x === 'object') });
    for (const it of full) {
      try {
        const d = parseBody({
          title: it.title, marketplace: it.marketplace, category: it.category, price: it.price,
          original_price: it.original_price, rating: it.rating, sales_k: it.sales_k, commission_pct: it.commission_pct,
          product_url: it.product_url, affiliate_url: it.affiliate_url, image_url: it.image_url,
        });
        const ext = EXTERNAL_ID[d.marketplace]?.test(String(it.external_id || '')) ? String(it.external_id) : null;
        saved.push(mapProduct(await insertProduct(pool, req.uid, d, ext, serializeExtras(it))));
      } catch (e) {
        if (e.status === 409) skipped++;
        else errors.push({ title: String(it.title || '').slice(0, 80), error: e.message });
      }
    }
    res.json({ saved: saved.length, skipped, errors, products: saved });
  });

  return r;
}

module.exports = { garimpoRoutes };
