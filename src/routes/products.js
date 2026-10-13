const express = require('express');
const { HttpError, parseNum, parseCsv } = require('../util');
const { scoreProduct } = require('../services/score');
const { externalIdFrom, freshData } = require('../services/garimpo');
const { parseExtras, mergeExtras, serializeExtras } = require('../services/extras');
const { fromShopeeBatch, fillImages } = require('../services/linkpreview');

const MARKETS = { ml: 'ML', 'mercado livre': 'ML', mercadolivre: 'ML', sh: 'SH', shopee: 'SH' };
const HISTORY_DAYS = 90;

/** Linha do banco -> produto da API: números, detalhes extras (fotos, selos), nota e, se houver, o histórico. */
function mapProduct(row, stats) {
  const { extras, ...rest } = row;
  const p = {
    ...rest,
    price: Number(row.price),
    original_price: row.original_price === null ? null : Number(row.original_price),
    rating: row.rating === null ? null : Number(row.rating),
    sales_k: row.sales_k === null ? null : Number(row.sales_k),
    commission_pct: row.commission_pct === null ? null : Number(row.commission_pct),
    ...parseExtras(extras),
  };
  const out = { ...p, ...scoreProduct(p) };
  if (stats) out.price_stats = stats;
  return out;
}

/** Grava um ponto no histórico de preço. */
async function recordPrice(pool, productId, price, originalPrice) {
  await pool.query('insert into price_history (product_id, price, original_price) values ($1, $2, $3)', [productId, price, originalPrice ?? null]);
}

/**
 * Resumo do histórico (últimos 90 dias) de cada produto do usuário:
 * menor e maior preço, preço anterior e um alerta de "preço de" inflado
 * (a loja anuncia um preço original que o produto não teve em nenhuma conferência).
 */
async function priceStats(pool, uid, products) {
  if (!products.length) return new Map();
  const since = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString();
  const { rows } = await pool.query(
    `select h.product_id, h.price, h.checked_at from price_history h join products p on p.id = h.product_id
       where p.user_id = $1 and h.checked_at >= $2 order by h.checked_at, h.id`,
    [uid, since]
  );
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.product_id)) by.set(r.product_id, []);
    by.get(r.product_id).push({ price: Number(r.price), at: new Date(r.checked_at).getTime() });
  }
  const out = new Map();
  for (const p of products) {
    const hist = by.get(p.id) || [];
    if (!hist.length) continue;
    const list = hist.map((h) => h.price);
    const orig = p.original_price === null ? null : Number(p.original_price);
    const max = Math.max(...list);
    // Só acusa com histórico de pelo menos 7 dias e 3 conferências; antes disso é cedo para afirmar.
    const spanDays = (hist[hist.length - 1].at - hist[0].at) / 864e5;
    out.set(p.id, {
      min: Math.min(...list),
      max,
      count: list.length,
      previous: list.length > 1 ? list[list.length - 2] : null,
      inflated_original: Boolean(orig && list.length >= 3 && spanDays >= 7 && max < orig * 0.9),
    });
  }
  return out;
}

/** Atualiza um produto com os dados atuais da loja e registra o preço no histórico. */
async function refreshOne({ pool, cfg, fetchImpl, uid, cur }) {
  const fresh = await freshData({ pool, cfg, fetchImpl, uid, product: cur });
  const old = parseExtras(cur.extras);
  // Comissão: a da Shopee vem da loja; a do Mercado Livre vem da tabela por categoria. Em ambos os casos,
  // só substitui se a atual estiver vazia ou tiver sido preenchida pelo app (a digitada pelo usuário fica).
  const auto = cur.commission_pct === null || old.commission_auto;
  const takeCommission = fresh.commission_pct !== null && fresh.commission_pct !== undefined && auto;
  const { commission_auto: _ignored, ...freshExtras } = fresh;
  const sets = ['price = $3', 'original_price = $4', 'price_checked_at = now()', 'extras = $5'];
  const vals = [fresh.price, fresh.original_price,
    mergeExtras(cur.extras, { ...freshExtras, ...(takeCommission ? { commission_auto: true } : {}) })];
  for (const k of ['rating', 'sales_k']) {
    if (fresh[k] !== null && fresh[k] !== undefined) { vals.push(fresh[k]); sets.push(`${k} = $${vals.length + 2}`); }
  }
  if (takeCommission) { vals.push(fresh.commission_pct); sets.push(`commission_pct = $${vals.length + 2}`); }
  if (!cur.category && fresh.category) { vals.push(fresh.category); sets.push(`category = $${vals.length + 2}`); }
  if (!cur.image_url && fresh.image_url) { vals.push(fresh.image_url); sets.push(`image_url = $${vals.length + 2}`); }
  const { rows } = await pool.query(`update products set ${sets.join(', ')} where id = $1 and user_id = $2 returning *`, [cur.id, uid, ...vals]);
  await recordPrice(pool, cur.id, fresh.price, fresh.original_price);
  return rows[0];
}

/**
 * Fotos extras (galeria) coladas pelo usuário: endereços https, uma por linha ou em lista, até 12.
 * Devolve undefined se o campo não veio.
 */
function cleanImages(v) {
  if (v === undefined) return undefined;
  const list = (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  for (const raw of list) {
    let u;
    try { u = new URL(raw); } catch (_) { throw new HttpError(400, `Foto extra: endereço inválido (${raw.slice(0, 60)}).`); }
    if (u.protocol !== 'https:') throw new HttpError(400, 'Foto extra: use endereços https.');
    if (!out.includes(u.toString())) out.push(u.toString());
  }
  if (out.length > 12) throw new HttpError(400, 'No máximo 12 fotos extras.');
  return out;
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
async function insertProduct(pool, uid, d, externalId, extras = null) {
  const ext = externalId || externalIdFrom(d.marketplace, d.product_url) || externalIdFrom(d.marketplace, d.affiliate_url);
  const dup = await findDuplicate(pool, uid, { ...d, external_id: ext });
  if (dup) { const e = new HttpError(409, DUPLICATE); e.existingId = dup; throw e; }
  const cols = COLS.filter((c) => d[c] !== undefined);
  const vals = cols.map((c) => d[c]);
  try {
    const { rows } = await pool.query(
      `insert into products (user_id, external_id, extras, price_checked_at, ${cols.join(',')})
         values ($1, $2, $3, now(), ${cols.map((_, i) => `$${i + 4}`).join(',')}) returning *`,
      [uid, ext, extras, ...vals]
    );
    await recordPrice(pool, rows[0].id, rows[0].price, rows[0].original_price);
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
    const stats = await priceStats(pool, req.uid, rows);
    const items = rows.map((row) => mapProduct(row, stats.get(row.id))).sort((a, b) => b.score - a.score);
    res.json({ products: items });
  });

  /**
   * Confere o preço de todos os produtos que têm código da loja, os mais antigos primeiro.
   * Para caber no tempo de uma requisição, para em ~40 s e informa quantos ficaram para a próxima rodada.
   */
  r.post('/refresh-all', async (req, res) => {
    const { rows } = await pool.query(
      `select * from products where user_id = $1 and external_id is not null
         order by coalesce(price_checked_at, created_at), id limit 60`,
      [req.uid]
    );
    const deadline = Date.now() + 40000;
    const changed = [];
    const failed = [];
    let checked = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (next < rows.length && Date.now() < deadline) {
        const cur = rows[next++];
        try {
          const row = await refreshOne({ pool, cfg, fetchImpl, uid: req.uid, cur });
          checked++;
          if (Number(row.price) !== Number(cur.price)) changed.push({ id: cur.id, title: cur.title, from: Number(cur.price), to: Number(row.price) });
        } catch (e) {
          failed.push({ id: cur.id, title: cur.title, error: e.message });
        }
      }
    }));
    res.json({ checked, changed, failed, remaining: rows.length - checked - failed.length });
  });

  /** Histórico de preço de um produto (últimos 180 dias). */
  r.get('/:id/history', async (req, res) => {
    const id = Number(req.params.id);
    const own = await pool.query('select id from products where id = $1 and user_id = $2', [id, req.uid]);
    if (!own.rows.length) throw new HttpError(404, 'Produto não encontrado.');
    const since = new Date(Date.now() - 180 * 864e5).toISOString();
    const { rows } = await pool.query(
      'select price, original_price, checked_at from price_history where product_id = $1 and checked_at >= $2 order by checked_at, id',
      [id, since]
    );
    res.json({ history: rows.map((h) => ({ price: Number(h.price), original_price: h.original_price === null ? null : Number(h.original_price), checked_at: h.checked_at })) });
  });

  r.post('/', async (req, res) => {
    const d = parseBody(req.body || {});
    const max = req.body?.price_max === undefined || req.body.price_max === '' ? null : parseNum(req.body.price_max);
    if (max !== null && !(max > d.price)) throw new HttpError(400, 'O preço "até" (variações) precisa ser maior que o preço "a partir de". Deixe vazio se o produto tem preço único.');
    const imgs = cleanImages(req.body?.images);
    const ex = {};
    if (max !== null) ex.price_max = max;
    if (imgs && imgs.length) ex.images = [d.image_url, ...imgs].filter((u, i, a) => u && a.indexOf(u) === i);
    const row = await insertProduct(pool, req.uid, d, null, Object.keys(ex).length ? serializeExtras(ex) : null);
    res.status(201).json({ product: mapProduct(row) });
  });

  r.patch('/:id', async (req, res) => {
    const id = Number(req.params.id);
    const d = parseBody(req.body || {}, true);
    const cols = COLS.filter((c) => d[c] !== undefined);
    const hasMax = req.body && req.body.price_max !== undefined;
    const imgs = cleanImages(req.body?.images);
    if (!cols.length && !hasMax && imgs === undefined) throw new HttpError(400, 'Nada para atualizar.');
    const cur = (await pool.query('select * from products where id = $1 and user_id = $2', [id, req.uid])).rows[0];
    if (!cur) throw new HttpError(404, 'Produto não encontrado.');
    // "Até R$" (variações): vazio remove; precisa ser maior que o preço "a partir de"
    let maxExtras;
    if (hasMax) {
      const max = req.body.price_max === '' || req.body.price_max === null ? null : parseNum(req.body.price_max);
      const base = d.price !== undefined ? Number(d.price) : Number(cur.price);
      if (max !== null && !(max > base)) throw new HttpError(400, 'O preço "até" (variações) precisa ser maior que o preço "a partir de". Deixe vazio se o produto tem preço único.');
      const e = parseExtras(cur.extras);
      e.price_max = max;
      maxExtras = serializeExtras(e);
    }
    // galeria: a foto principal primeiro, depois as extras
    if (imgs !== undefined) {
      const e = parseExtras(maxExtras !== undefined ? maxExtras : cur.extras);
      const main = d.image_url !== undefined ? d.image_url : cur.image_url;
      e.images = [main, ...imgs].filter((u, i, a) => u && a.indexOf(u) === i);
      maxExtras = serializeExtras(e);
    }
    const next = { ...cur, ...d };
    const extra = {};
    if (d.product_url !== undefined || d.affiliate_url !== undefined || d.marketplace !== undefined) {
      extra.external_id = externalIdFrom(next.marketplace, next.product_url) || externalIdFrom(next.marketplace, next.affiliate_url)
        || (d.marketplace === undefined ? cur.external_id : null);
      if (await findDuplicate(pool, req.uid, { ...next, ...extra }, id)) throw new HttpError(409, DUPLICATE);
    }
    const priceChanged = (d.price !== undefined && Number(d.price) !== Number(cur.price))
      || (d.original_price !== undefined && Number(d.original_price) !== Number(cur.original_price));
    // comissão digitada pelo usuário passa a valer sobre a da tabela/loja
    const comChanged = d.commission_pct !== undefined
      && (d.commission_pct === null ? cur.commission_pct !== null : Number(d.commission_pct) !== Number(cur.commission_pct));
    if (maxExtras !== undefined) {
      cur.extras = maxExtras; // a regra da comissão abaixo parte dos detalhes já atualizados
      extra.extras = maxExtras;
    }
    if (comChanged && parseExtras(cur.extras).commission_auto) {
      extra.extras = mergeExtras(cur.extras, { commission_auto: false });
    }
    const all = [...cols.map((c) => [c, d[c]]), ...Object.entries(extra)];
    const sets = all.map(([c], i) => `${c} = $${i + 3}`).concat(priceChanged ? ['price_checked_at = now()'] : []).join(', ');
    let rows;
    try {
      ({ rows } = await pool.query(`update products set ${sets} where id = $1 and user_id = $2 returning *`, [id, req.uid, ...all.map(([, v]) => v)]));
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, DUPLICATE);
      throw e;
    }
    if (priceChanged) await recordPrice(pool, id, rows[0].price, rows[0].original_price);
    res.json({ product: mapProduct(rows[0]) });
  });

  /** Busca na loja o preço atual (e o desconto) e grava, para não divulgar preço velho. */
  r.post('/:id/refresh', async (req, res) => {
    const id = Number(req.params.id);
    const cur = (await pool.query('select * from products where id = $1 and user_id = $2', [id, req.uid])).rows[0];
    if (!cur) throw new HttpError(404, 'Produto não encontrado.');
    const row = await refreshOne({ pool, cfg, fetchImpl, uid: req.uid, cur });
    const stats = await priceStats(pool, req.uid, [row]);
    res.json({ product: mapProduct(row, stats.get(row.id)), previous_price: Number(cur.price) });
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

    // Planilha "Obter link em massa" da Shopee: formato próprio, com foto buscada na prévia de cada link.
    const batch = fromShopeeBatch(rows);
    if (batch) {
      if (batch.length > 200) throw new HttpError(400, 'Envie no máximo 200 produtos por vez.');
      await fillImages(batch, fetchImpl);
      for (let i = 0; i < batch.length; i++) {
        const it = batch[i];
        try {
          const d = parseBody({
            title: it.title, marketplace: 'SH', price: it.price, sales_k: it.sales_k, commission_pct: it.commission_pct,
            product_url: it.product_url, affiliate_url: it.affiliate_url, image_url: it.image_url, notes: it.shop ? `Loja: ${it.shop}` : undefined,
          });
          await insertProduct(pool, req.uid, d, it.external_id, serializeExtras(it));
          imported++;
        } catch (e) {
          if (e.status === 409) skipped++;
          else errors.push({ line: i + 2, error: e.message });
        }
      }
      return res.json({ imported, skipped, errors, format: 'shopee' });
    }

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

module.exports = { productRoutes, mapProduct, parseBody, insertProduct, refreshOne };
