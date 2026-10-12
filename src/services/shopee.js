const crypto = require('crypto');

/**
 * Cliente da API de afiliados da Shopee (GraphQL, consulta productOfferV2).
 * Credenciais: App ID e Secret liberados no portal de afiliados (Open API).
 * Assinatura: SHA256(AppId + Timestamp + Payload + Secret).
 */
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
const FIELDS = 'itemId shopId productName price priceMin priceMax priceDiscountRate commissionRate sales ratingStar imageUrl productLink offerLink shopName';
// sortType da Shopee: 1 relevância, 2 mais vendidos, 4 menor preço, 5 maior comissão
const SORT = { relevancia: 1, vendidos: 2, preco: 4, comissao: 5 };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toProduct(n) {
  const price = num(n.price) ?? num(n.priceMin);
  const rate = num(n.priceDiscountRate);
  const original = price && rate && rate > 0 && rate < 100 ? Math.round((price / (1 - rate / 100)) * 100) / 100 : null;
  const com = num(n.commissionRate);
  return {
    marketplace: 'SH',
    external_id: n.shopId && n.itemId ? `${n.shopId}.${n.itemId}` : null,
    title: String(n.productName || '').slice(0, 300),
    price,
    original_price: original,
    rating: num(n.ratingStar) ? Math.round(num(n.ratingStar) * 10) / 10 : null,
    sales_k: num(n.sales) ? Math.round((num(n.sales) / 1000) * 10) / 10 : null,
    // A Shopee devolve a taxa como fração (0.07 = 7%)
    commission_pct: com === null ? null : Math.round((com <= 1 ? com * 100 : com) * 100) / 100,
    commission_auto: com !== null,
    product_url: n.productLink || null,
    affiliate_url: n.offerLink || null,
    image_url: n.imageUrl || null,
    shop: n.shopName || null,
  };
}

function createShopeeClient({ appId, secret, fetchImpl = fetch }) {
  async function gql(query) {
    const payload = JSON.stringify({ query });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHash('sha256').update(`${appId}${ts}${payload}${secret}`).digest('hex');
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${sig}`,
      },
      body: payload,
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (data.errors && data.errors.length) {
      const e = data.errors[0];
      throw new Error(`Shopee: ${e.message || 'erro'}${e.extensions?.code ? ` (código ${e.extensions.code})` : ''}`);
    }
    if (!res.ok) throw new Error(`Shopee: erro HTTP ${res.status}`);
    return data.data || {};
  }

  return {
    async search({ q, page = 1, limit = 50, sort = 'relevancia' }) {
      const args = [`keyword: ${JSON.stringify(String(q))}`, `sortType: ${SORT[sort] || 1}`, `page: ${Number(page) || 1}`, `limit: ${limit}`];
      const out = await gql(`{ productOfferV2(${args.join(', ')}) { nodes { ${FIELDS} } pageInfo { page hasNextPage } } }`);
      const block = out.productOfferV2 || {};
      return { items: (block.nodes || []).map(toProduct), hasMore: Boolean(block.pageInfo?.hasNextPage) };
    },

    /** Busca um item pelo ID ("shopId.itemId"), para atualizar o preço. */
    async getItem(externalId) {
      const [shopId, itemId] = String(externalId).split('.');
      if (!/^\d+$/.test(shopId || '') || !/^\d+$/.test(itemId || '')) throw new Error('ID do produto da Shopee inválido.');
      const out = await gql(`{ productOfferV2(shopId: ${shopId}, itemId: ${itemId}, limit: 1) { nodes { ${FIELDS} } } }`);
      const node = (out.productOfferV2?.nodes || [])[0];
      return node ? toProduct(node) : null;
    },
  };
}

module.exports = { createShopeeClient, toShopeeProduct: toProduct };
