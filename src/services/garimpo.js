const { HttpError, encrypt, decrypt } = require('../util');
const { scoreProduct } = require('./score');
const { createShopeeClient } = require('./shopee');
const { createMercadoLivreClient, mercadoLivreOAuth } = require('./mercadolivre');

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
    return createShopeeClient({ appId: conn.app_id, secret: decrypt(conn.secret_enc, cfg.encryptionKey), fetchImpl });
  }
  const token = await mercadoLivreToken({ pool, cfg, fetchImpl, conn });
  const com = conn.default_commission === null ? null : Number(conn.default_commission);
  return createMercadoLivreClient({ token, defaultCommission: com, fetchImpl });
}

const SORTERS = {
  // Ranking de mais vendidos do Mercado Livre primeiro (1º, 2º...), depois volume de vendas
  vendidos: (a, b) => (a.best_seller_rank || 1e9) - (b.best_seller_rank || 1e9) || (b.sales_k || 0) - (a.sales_k || 0),
  comissao: (a, b) => (b.commission_pct || 0) - (a.commission_pct || 0),
  preco: (a, b) => a.price - b.price,
  nota: (a, b) => b.score - a.score,
};

/**
 * Busca na loja, na hora. Calcula a nota de prioridade, aplica os filtros mínimos e marca o que já está salvo.
 * Filtros e ordenação que a loja não suporta são aplicados aqui, sobre a página recebida.
 */
async function search({ pool, cfg, fetchImpl, uid, marketplace, q, page, sort, minDiscount, minCommission, minRating }) {
  const client = await clientFor({ pool, cfg, fetchImpl, uid, marketplace });
  let out;
  try {
    out = await client.search({ q, page, sort });
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
    .filter((p) => !minRating || (p.rating || 0) >= minRating);
  if (SORTERS[sort]) items = items.sort(SORTERS[sort]);
  return { items, has_more: out.hasMore, page: Number(page) || 1 };
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

module.exports = { externalIdFrom, search, freshData, clientFor, saveMercadoLivreTokens, loadConnection, NAMES };
