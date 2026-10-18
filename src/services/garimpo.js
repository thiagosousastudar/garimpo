const { HttpError, encrypt, decrypt } = require('../util');
const { scoreProduct } = require('./score');
const { createShopeeClient } = require('./shopee');
const { createMercadoLivreClient, mercadoLivreOAuth, commissionRule } = require('./mercadolivre');
const { parseExtras, mergeExtras } = require('./extras');

const NAMES = { ML: 'Mercado Livre', SH: 'Shopee' };

/**
 * Identificador do produto na loja, tirado do link. Serve para não cadastrar o mesmo produto duas vezes
 * e para buscar o preço atual depois.
 *  - Mercado Livre: MLB123... (prefere o código de catálogo /p/MLB..., que é o que dá para consultar o preço)
 *  - Shopee: "shopId.itemId" (links ...-i.SHOP.ITEM ou /product/SHOP/ITEM)
 */
function externalIdFrom(marketplace, url) {
  const s = decodeURIComponent(String(url || ''));
  if (!s) return null;
  if (marketplace === 'ML') {
    const m = s.match(/\/p\/(MLB)(\d+)/i) || s.match(/item_id[:=](MLB)-?(\d+)/i) || s.match(/(MLB)-?(\d{6,})/i);
    return m ? `MLB${m[2]}` : null;
  }
  if (marketplace === 'SH') {
    const m = s.match(/-i\.(\d+)\.(\d+)/) || s.match(/\/product\/(\d+)\/(\d+)/);
    return m ? `${m[1]}.${m[2]}` : null;
  }
  return null;
}

async function loadConnection(pool, uid, marketplace) {
  const { rows } = await pool.query('select * from marketplace_connections where user_id = $1 and marketplace = $2', [uid, marketplace]);
  return rows[0] || null;
}

/** Devolve um token válido do Mercado Livre, renovando quando falta menos de 5 minutos. */
async function mercadoLivreToken({ pool, cfg, fetchImpl, conn }) {
  if (!conn.access_token_enc) throw new HttpError(400, 'Autorize o Mercado Livre na aba Conexões.');
  const exp = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (exp - Date.now() > 5 * 60 * 1000) return decrypt(conn.access_token_enc, cfg.encryptionKey);
  if (!conn.refresh_token_enc) throw new HttpError(400, 'A autorização do Mercado Livre expirou. Autorize de novo na aba Conexões.');
  const auth = mercadoLivreOAuth({ clientId: conn.app_id, clientSecret: decrypt(conn.secret_enc, cfg.encryptionKey), fetchImpl });
  let t;
  try {
    t = await auth.refresh(decrypt(conn.refresh_token_enc, cfg.encryptionKey));
  } catch (e) {
    throw new HttpError(400, `${e.message}. Autorize de novo na aba Conexões.`);
  }
  await saveMercadoLivreTokens(pool, cfg, conn.user_id, t);
  return t.accessToken;
}

async function saveMercadoLivreTokens(pool, cfg, uid, t) {
  await pool.query(
    `update marketplace_connections set access_token_enc = $1, refresh_token_enc = coalesce($2, refresh_token_enc),
       token_expires_at = $3, updated_at = now() where user_id = $4 and marketplace = 'ML'`,
    [encrypt(t.accessToken, cfg.encryptionKey), t.refreshToken ? encrypt(t.refreshToken, cfg.encryptionKey) : null,
      new Date(Date.now() + t.expiresIn * 1000).toISOString(), uid]
  );
}

/** Cliente da loja já autenticado para o usuário. */
async function clientFor({ pool, cfg, fetchImpl, uid, marketplace }) {
  const conn = await loadConnection(pool, uid, marketplace);
  if (!conn) throw new HttpError(400, `Conecte a ${NAMES[marketplace] || 'loja'} na aba Conexões para garimpar.`);
  if (marketplace === 'SH') {
    const client = createShopeeClient({ appId: conn.app_id, secret: decrypt(conn.secret_enc, cfg.encryptionKey), fetchImpl });
    // etiqueta da conta (Sub ID) vai em todo link gerado: separa as vendas quando duas contas usam a mesma Shopee
    const tag = (await pool.query('select sh_sub_id from users where id = $1', [uid])).rows[0]?.sh_sub_id || null;
    if (tag) {
      const orig = client.shortLink.bind(client);
      client.shortLink = ({ url, subIds = [] }) => orig({ url, subIds: [tag, ...subIds.filter((x) => String(x).toLowerCase() !== tag)] });
    }
    client.subTag = tag;
    return client;
  }
  const token = await mercadoLivreToken({ pool, cfg, fetchImpl, conn });
  const com = conn.default_commission === null ? null : Number(conn.default_commission);
  const zip = (await pool.query('select ship_zip from users where id = $1', [uid])).rows[0]?.ship_zip || null;
  return createMercadoLivreClient({ token, defaultCommission: com, commissionTable: commissionTableOf(conn), zip, fetchImpl });
}

/**
 * Conta com etiqueta: troca o link de afiliado dos itens da Shopee (o da busca vem sem etiqueta) por um gerado
 * com a etiqueta da conta. Se a Shopee falhar, fica o link original.
 */
async function tagShopeeLinks({ pool, cfg, fetchImpl, uid, items }) {
  const sh = items.filter((it) => it && it.marketplace === 'SH' && it.product_url);
  if (!sh.length) return items;
  const tag = (await pool.query('select sh_sub_id from users where id = $1', [uid])).rows[0]?.sh_sub_id;
  if (!tag) return items;
  let client;
  try { client = await clientFor({ pool, cfg, fetchImpl, uid, marketplace: 'SH' }); } catch (_) { return items; }
  for (const it of sh) {
    try { it.affiliate_url = await client.shortLink({ url: it.product_url }); } catch (_) { /* fica o link da busca */ }
  }
  return items;
}

/** Tabela de comissão do Mercado Livre por categoria principal: { "MLB5726": 6, ... }. */
function commissionTableOf(conn) {
  if (!conn || !conn.commission_table) return {};
  try {
    const t = JSON.parse(conn.commission_table);
    return t && typeof t === 'object' ? t : {};
  } catch (_) { return {}; }
}

/**
 * Reaplica a tabela (e a comissão padrão) nos produtos do Mercado Livre já salvos.
 * Só mexe nos produtos cuja comissão foi preenchida pelo app ou está vazia; a que o usuário digitou fica.
 */
async function applyCommissionTable(pool, uid) {
  const conn = await loadConnection(pool, uid, 'ML');
  if (!conn) return 0;
  const rule = commissionRule(commissionTableOf(conn), conn.default_commission === null ? null : Number(conn.default_commission));
  const { rows } = await pool.query(`select id, commission_pct, extras from products where user_id = $1 and marketplace = 'ML'`, [uid]);
  let updated = 0;
  for (const p of rows) {
    const e = parseExtras(p.extras);
    if (p.commission_pct !== null && !e.commission_auto) continue;
    const next = rule(e.category_id ? { id: e.category_id } : null);
    const cur = p.commission_pct === null ? null : Number(p.commission_pct);
    if (next === cur) continue;
    await pool.query('update products set commission_pct = $1, extras = $2 where id = $3',
      [next, mergeExtras(p.extras, { commission_auto: next !== null }), p.id]);
    updated++;
  }
  return updated;
}

/** Frete que não pesa: até 15% do preço do produto. */
const CHEAP_SHIPPING = 0.15;

/**
 * Filtro de frete: false/'' = qualquer; 'free' (ou true) = só frete grátis; 'cheap' = grátis ou até 15% do preço.
 * Frete desconhecido (sem CEP de referência) só passa em "qualquer".
 */
function shippingOk(p, mode) {
  if (!mode) return true;
  const free = p.free_shipping || p.shipping_cost === 0;
  if (mode === true || mode === 'free') return free;
  return free || (p.shipping_cost !== null && p.shipping_cost !== undefined && p.shipping_cost <= p.price * CHEAP_SHIPPING);
}

const SORTERS = {
  // Ranking de mais vendidos do Mercado Livre primeiro (1º, 2º...), depois volume de vendas
  vendidos: (a, b) => (a.best_seller_rank || 1e9) - (b.best_seller_rank || 1e9) || (b.sales_k || 0) - (a.sales_k || 0),
  comissao: (a, b) => (b.commission_pct || 0) - (a.commission_pct || 0),
  ganho: (a, b) => (b.earn_per_sale || 0) - (a.earn_per_sale || 0),
  desconto: (a, b) => (b.desc || 0) - (a.desc || 0),
  preco: (a, b) => a.price - b.price,
  nota: (a, b) => b.score - a.score,
};

/**
 * Busca na loja, na hora. Calcula a nota de prioridade, aplica os filtros mínimos e marca o que já está salvo.
 * Filtros e ordenação que a loja não suporta são aplicados aqui, sobre a página recebida.
 */
async function search({ pool, cfg, fetchImpl, uid, marketplace, q, category, page, sort, sh = {}, minDiscount, minCommission, minRating, freeShipping }) {
  const client = await clientFor({ pool, cfg, fetchImpl, uid, marketplace });
  if (category && !client.bestSellersOf) throw new HttpError(400, 'Explorar por categoria só está disponível no Mercado Livre.');
  let out;
  try {
    out = category ? await client.bestSellersOf(category) : await client.search({ q, page, sort, ...sh });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, e.message);
  }
  const ids = out.items.map((p) => p.external_id).filter(Boolean);
  const saved = new Map();
  if (ids.length) {
    const { rows } = await pool.query(
      `select id, external_id from products where user_id = $1 and marketplace = $2
         and external_id in (${ids.map((_, i) => `$${i + 3}`).join(',')})`,
      [uid, marketplace, ...ids]
    );
    for (const r of rows) saved.set(r.external_id, r.id);
  }
  let items = out.items
    .filter((p) => p.title && p.price > 0)
    .map((p) => ({ ...p, ...scoreProduct(p), saved_id: saved.get(p.external_id) || null }))
    .filter((p) => p.desc >= (minDiscount || 0))
    .filter((p) => !minCommission || (p.commission_pct || 0) >= minCommission)
    .filter((p) => !minRating || (p.rating || 0) >= minRating)
    .filter((p) => shippingOk(p, freeShipping));
  if (SORTERS[sort]) items = items.sort(SORTERS[sort]);
  return { items, has_more: out.hasMore, page: Number(page) || 1 };
}

/** Tendências de busca (só Mercado Livre). Sem conexão, devolve lista vazia em vez de erro. */
async function trends({ pool, cfg, fetchImpl, uid, category }) {
  const client = await clientFor({ pool, cfg, fetchImpl, uid, marketplace: 'ML' });
  try { return await client.trends(category); } catch (e) { throw new HttpError(502, e.message); }
}

let categoryCache = null;
async function categories({ pool, cfg, fetchImpl, uid }) {
  if (categoryCache) return categoryCache;
  const client = await clientFor({ pool, cfg, fetchImpl, uid, marketplace: 'ML' });
  try { categoryCache = await client.categories(); } catch (e) { throw new HttpError(502, e.message); }
  return categoryCache;
}

/**
 * Antes de salvar itens do Mercado Livre, busca os detalhes completos (galeria, características, selos)
 * e o preço do momento. Se a consulta falhar, salva com o que veio da busca.
 */
async function enrich({ pool, cfg, fetchImpl, uid, items }) {
  const ml = items.filter((p) => p.marketplace === 'ML' && /^MLB\d+$/.test(String(p.external_id || '')));
  if (!ml.length) return items;
  let client;
  try { client = await clientFor({ pool, cfg, fetchImpl, uid, marketplace: 'ML' }); } catch (_) { return items; }
  const fresh = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ml.length) }, async () => {
    while (next < ml.length) {
      const p = ml[next++];
      try { const f = await client.getItem(p.external_id); if (f && f.price) fresh.set(p.external_id, f); } catch (_) { /* mantém o da busca */ }
    }
  }));
  return items.map((p) => {
    const f = fresh.get(p.external_id);
    // o garimpo pode ter pegado comissão/rank que a consulta individual não traz
    return f ? { ...p, ...f, commission_pct: p.commission_pct ?? f.commission_pct, best_seller_rank: p.best_seller_rank ?? f.best_seller_rank } : p;
  });
}

/** Preço atual do produto na loja. */
async function freshData({ pool, cfg, fetchImpl, uid, product }) {
  if (!product.external_id) throw new HttpError(400, 'Este produto não tem o código da loja. Confira o link do anúncio.');
  const client = await clientFor({ pool, cfg, fetchImpl, uid, marketplace: product.marketplace });
  let item;
  try {
    item = await client.getItem(product.external_id);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, e.message);
  }
  if (!item || !item.price) throw new HttpError(404, 'A loja não encontrou este produto. Ele pode ter saído do ar.');
  return item;
}

module.exports = { tagShopeeLinks, externalIdFrom, search, trends, categories, enrich, freshData, clientFor, saveMercadoLivreTokens, loadConnection, applyCommissionTable, commissionTableOf, NAMES };
