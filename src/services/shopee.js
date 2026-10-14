const crypto = require('crypto');

/**
 * Cliente da API de afiliados da Shopee (GraphQL).
 * Credenciais: App ID e Secret liberados no portal de afiliados (Open API).
 * Assinatura: SHA256(AppId + Timestamp + Payload + Secret).
 *
 * Recursos: busca de produtos (com comissão extra da loja e vendedores-chave), lojas com comissão,
 * ofertas/campanhas da Shopee, geração do link de afiliado de qualquer link e relatório de vendas.
 */
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
const FIELDS = 'itemId shopId productName price priceMin priceMax priceDiscountRate commissionRate sellerCommissionRate shopeeCommissionRate commission sales ratingStar imageUrl productLink offerLink shopName shopType';
// sortType da Shopee: 1 relevância, 2 mais vendidos, 4 menor preço, 5 maior comissão
const SORT = { relevancia: 1, vendidos: 2, preco: 4, comissao: 5 };
// tipo de loja: 1 oficial (Mall), 2 indicada (Preferred), 4 indicada+ (Preferred Plus)
const SHOP_TYPES = { oficial: [1], indicada: [2, 4], todas: [] };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Taxa da Shopee (fração 0.07) em % com 2 casas. */
const pct = (v) => {
  const n = num(v);
  return n === null ? null : Math.round((n <= 1 ? n * 100 : n) * 100) / 100;
};
const shopLabels = (types) => (Array.isArray(types) ? types : []).map((t) => ({ 1: 'Loja oficial', 2: 'Indicada', 4: 'Indicada+' }[t])).filter(Boolean);

function toProduct(n) {
  const price = num(n.price) ?? num(n.priceMin);
  const rate = num(n.priceDiscountRate);
  const original = price && rate && rate > 0 && rate < 100 ? Math.round((price / (1 - rate / 100)) * 100) / 100 : null;
  const com = num(n.commissionRate);
  const seller = pct(n.sellerCommissionRate);
  const types = Array.isArray(n.shopType) ? n.shopType : [];
  return {
    marketplace: 'SH',
    external_id: n.shopId && n.itemId ? `${n.shopId}.${n.itemId}` : null,
    title: String(n.productName || '').slice(0, 300),
    price,
    original_price: original,
    // variações com preços diferentes: price = menor ("a partir de"), price_max = maior
    price_max: num(n.priceMax) && price && num(n.priceMax) > price ? num(n.priceMax) : null,
    rating: num(n.ratingStar) ? Math.round(num(n.ratingStar) * 10) / 10 : null,
    sales_k: num(n.sales) ? Math.round((num(n.sales) / 1000) * 10) / 10 : null,
    // A Shopee devolve a taxa como fração (0.07 = 7%)
    commission_pct: com === null ? null : pct(com),
    commission_auto: com !== null,
    // parte da comissão paga pela própria loja (comissão extra/XTRA)
    seller_commission_pct: seller && seller > 0 ? seller : null,
    product_url: n.productLink || null,
    affiliate_url: n.offerLink || null,
    image_url: n.imageUrl || null,
    shop: n.shopName || null,
    shop_id: n.shopId ? String(n.shopId) : null,
    official_store: types.includes(1),
    shop_labels: shopLabels(types),
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
    /**
     * Produtos. Filtros do portal: palavra, loja (shopId), só com comissão extra da loja (ams),
     * só vendedores-chave (keySeller), lista "melhor desempenho" (top), ordem.
     */
    async search({ q, page = 1, limit = 50, sort = 'relevancia', ams = false, keySeller = false, shopId = null, top = false }) {
      const args = [`sortType: ${SORT[sort] || 1}`, `page: ${Number(page) || 1}`, `limit: ${limit}`];
      if (q) args.unshift(`keyword: ${JSON.stringify(String(q))}`);
      if (/^\d+$/.test(String(shopId || ''))) args.push(`shopId: ${shopId}`);
      if (ams) args.push('isAMSOffer: true');
      if (keySeller) args.push('isKeySeller: true');
      if (top && !q && !shopId) args.push('listType: 2');
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

    /** Lojas com comissão (oficiais, indicadas ou todas), por palavra ou ordem. */
    async shops({ q, type = 'todas', sort = 'comissao', page = 1, limit = 30 }) {
      const args = [`page: ${Number(page) || 1}`, `limit: ${limit}`];
      if (q) args.push(`keyword: ${JSON.stringify(String(q))}`);
      const types = SHOP_TYPES[type] || [];
      if (types.length) args.push(`shopType: [${types.join(',')}]`);
      // sortType das lojas: 1 mais recentes, 2 maior comissão, 3 mais populares
      args.push(`sortType: ${{ recentes: 1, comissao: 2, populares: 3 }[sort] || 2}`);
      const out = await gql(`{ shopOfferV2(${args.join(', ')}) { nodes { shopId shopName commissionRate ratingStar offerLink imageUrl shopType remainingBudget periodEndTime } pageInfo { hasNextPage } } }`);
      const block = out.shopOfferV2 || {};
      return {
        items: (block.nodes || []).map((n) => ({
          shop_id: String(n.shopId), name: n.shopName, commission_pct: pct(n.commissionRate), rating: num(n.ratingStar) || null,
          link: n.offerLink || null, image_url: n.imageUrl || null, labels: shopLabels(n.shopType),
        })),
        hasMore: Boolean(block.pageInfo?.hasNextPage),
      };
    },

    /** Ofertas/campanhas da própria Shopee (por categoria ou evento), com link pronto. */
    async campaigns({ q, page = 1, limit = 30 }) {
      const args = [`page: ${Number(page) || 1}`, `limit: ${limit}`, 'sortType: 2'];
      if (q) args.push(`keyword: ${JSON.stringify(String(q))}`);
      const out = await gql(`{ shopeeOfferV2(${args.join(', ')}) { nodes { offerName commissionRate offerLink imageUrl periodStartTime periodEndTime offerType } pageInfo { hasNextPage } } }`);
      const block = out.shopeeOfferV2 || {};
      const date = (s) => (num(s) && num(s) < 4102444800 ? new Date(num(s) * 1000).toISOString() : null); // "sem fim" vem como ano 3000
      return {
        items: (block.nodes || []).map((n) => ({
          name: String(n.offerName || '').replace(/^[-\s]+/, '').trim() || 'Oferta Shopee', commission_pct: pct(n.commissionRate),
          link: n.offerLink || null, image_url: n.imageUrl || null, starts_at: date(n.periodStartTime), ends_at: date(n.periodEndTime),
        })),
        hasMore: Boolean(block.pageInfo?.hasNextPage),
      };
    },

    /** Link de afiliado (s.shopee.com.br/...) de qualquer link da Shopee, com até 5 sub_ids (ex.: canal). */
    async shortLink({ url, subIds = [] }) {
      const ids = subIds.map((s) => String(s).replace(/[^A-Za-z0-9]/g, '')).filter(Boolean).slice(0, 5);
      const out = await gql(`mutation { generateShortLink(input: { originUrl: ${JSON.stringify(String(url))}${ids.length ? `, subIds: ${JSON.stringify(ids)}` : ''} }) { shortLink } }`);
      const link = out.generateShortLink?.shortLink;
      if (!link) throw new Error('Shopee: não gerou o link.');
      return link;
    },

    /** Vendas (conversões) num período (segundos), paginadas por scrollId. */
    async conversions({ start, end, scrollId = '', limit = 500 }) {
      const args = [`purchaseTimeStart: ${Math.floor(start)}`, `purchaseTimeEnd: ${Math.floor(end)}`, `limit: ${limit}`];
      if (scrollId) args.push(`scrollId: ${JSON.stringify(scrollId)}`);
      const out = await gql(`{ conversionReport(${args.join(', ')}) { nodes { purchaseTime conversionId utmContent orders { orderId orderStatus items { shopId itemId itemName itemPrice qty itemTotalCommission displayItemStatus } } } pageInfo { hasNextPage scrollId } } }`);
      const block = out.conversionReport || {};
      return { items: block.nodes || [], hasMore: Boolean(block.pageInfo?.hasNextPage), scrollId: block.pageInfo?.scrollId || '' };
    },
  };
}

module.exports = { createShopeeClient, toShopeeProduct: toProduct, SHOP_TYPES };
