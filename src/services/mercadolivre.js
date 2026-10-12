/**
 * Cliente da API do Mercado Livre.
 * Desde 2025 a busca exige token: o usuário cria um app no DevCenter (Client ID e Secret) e autoriza a própria conta
 * (OAuth, fluxo "authorization code" com PKCE). O token dura 6 horas e é renovado com o refresh token.
 * A API não informa a comissão de afiliado nem gera o link de afiliado: a comissão vem de um padrão configurado
 * pelo usuário e o link é colado depois (gerado no portal de Afiliados do Mercado Livre).
 */
const API = 'https://api.mercadolibre.com';
const AUTH = 'https://auth.mercadolivre.com.br/authorization';
const SORT = { relevancia: 'relevance', preco: 'price_asc' };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Imagem maior e em https (o Instagram exige URL pública segura). */
function bigImage(url) {
  if (!url) return null;
  return String(url).replace(/^http:/, 'https:').replace(/-[A-Z]\.(jpe?g|webp)$/i, '-O.$1');
}

function fromItem(it, defaultCommission) {
  return {
    marketplace: 'ML',
    external_id: it.id || null,
    title: String(it.title || '').slice(0, 300),
    price: num(it.price),
    original_price: num(it.original_price) && num(it.original_price) > num(it.price) ? num(it.original_price) : null,
    rating: null,
    sales_k: num(it.sold_quantity) ? Math.round((num(it.sold_quantity) / 1000) * 10) / 10 : null,
    commission_pct: defaultCommission ?? null,
    product_url: it.permalink || null,
    affiliate_url: null,
    image_url: bigImage(it.thumbnail || it.pictures?.[0]?.secure_url || it.pictures?.[0]?.url),
    shop: null,
  };
}

/**
 * Produto de catálogo (/products/search). A busca de catálogo não traz preço: ele vem da oferta mais barata
 * entre os vendedores do produto (/products/{id}/items). "rank" é a posição na lista de mais vendidos da categoria.
 */
/**
 * Comissão de afiliado para a categoria principal: a da tabela do usuário, senão a padrão.
 * O Mercado Livre não informa a comissão pela API; ela é por categoria, no painel de Afiliados.
 */
function commissionRule(table, fallback) {
  return (root) => {
    const v = root && table ? table[root.id] : undefined;
    return v !== undefined && v !== null && v !== '' ? Number(v) : fallback ?? null;
  };
}

function fromCatalog(p, offer, commissionFor, rank = null, root = null) {
  const commission = typeof commissionFor === 'function' ? commissionFor(root) : commissionFor ?? null;
  const price = num(offer?.price) ?? num(p.buy_box_winner?.price);
  const orig = num(offer?.original_price) ?? num(p.buy_box_winner?.original_price);
  const images = (p.pictures || []).map((x) => bigImage(x.secure_url || x.url)).filter(Boolean);
  const brand = (p.attributes || []).find((a) => a.id === 'BRAND')?.value_name || null;
  return {
    marketplace: 'ML',
    external_id: p.id || null,
    title: String(p.name || p.title || '').slice(0, 300),
    price,
    original_price: orig && orig > price ? orig : null,
    rating: null,
    sales_k: null,
    commission_pct: commission,
    commission_auto: commission !== null,
    category: root?.name || null,
    category_id: root?.id || null,
    product_url: p.permalink || (p.id ? `https://www.mercadolivre.com.br/p/${p.id}` : null),
    affiliate_url: null,
    image_url: images[0] || null,
    shop: null,
    best_seller_rank: rank,
    // detalhes da oferta e do produto (selos, galeria, características)
    images: images.slice(0, 12),
    features: (p.main_features || []).map((f) => f.text).filter(Boolean).slice(0, 6),
    brand,
    free_shipping: offer?.shipping?.free_shipping === true,
    full: offer?.shipping?.logistic_type === 'fulfillment',
    official_store: Boolean(offer?.official_store_id),
    warranty: offer?.warranty || null,
    sellers: offer?.sellers || null,
  };
}

// Categoria -> categoria principal ({ id, name }). Dado público e estável: guardado em memória.
const rootCache = new Map();

/** Executa fn em cada item com no máximo "limit" chamadas ao mesmo tempo. */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

function oauth({ clientId, clientSecret, fetchImpl = fetch }) {
  async function token(params) {
    const res = await fetchImpl(`${API}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Mercado Livre recusou a autorização: ${data.message || data.error || `HTTP ${res.status}`}`);
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token || null, expiresIn: Number(data.expires_in) || 21600 };
  }
  return {
    authorizeUrl({ redirectUri, state, challenge }) {
      const u = new URL(AUTH);
      u.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state,
        code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      return u.toString();
    },
    exchange: ({ code, redirectUri, verifier }) =>
      token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

function createMercadoLivreClient({ token, defaultCommission = null, commissionTable = null, fetchImpl = fetch }) {
  const commissionFor = commissionRule(commissionTable, defaultCommission);
  async function get(path, params = {}) {
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    const res = await fetchImpl(u.toString(), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(`Mercado Livre: ${data.message || data.error || `HTTP ${res.status}`}`);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  /** Oferta mais barata entre os vendedores de um produto de catálogo (null se ninguém vende). */
  async function bestOffer(productId) {
    const d = await get(`/products/${productId}/items`, { limit: 10 });
    const offers = (d.results || []).filter((o) => num(o.price) > 0);
    if (!offers.length) return null;
    const best = offers.reduce((a, b) => (num(b.price) < num(a.price) ? b : a));
    return { ...best, sellers: Number(d.paging?.total) || offers.length };
  }

  /** Categoria principal de uma categoria qualquer (ex.: "De Ar" -> Eletrodomésticos). Falha vira null. */
  function rootOf(categoryId) {
    if (!categoryId) return Promise.resolve(null);
    if (!rootCache.has(categoryId)) {
      const p = get(`/categories/${categoryId}`)
        .then((c) => { const r = (c.path_from_root || [])[0]; return r ? { id: r.id, name: r.name } : null; })
        .catch(() => { rootCache.delete(categoryId); return null; });
      rootCache.set(categoryId, p);
    }
    return rootCache.get(categoryId);
  }

  /** Produto de catálogo completo: oferta + categoria principal (para a comissão). */
  async function catalogItem(prod, offer, rank = null) {
    return fromCatalog(prod, offer, commissionFor, rank, await rootOf(offer.category_id));
  }

  /** Mais vendidos de uma categoria (até 20, em ordem), já com detalhes e a oferta mais barata. */
  async function bestSellersOf(categoryId) {
    const h = await get(`/highlights/MLB/category/${categoryId}`);
    const top = (h.content || []).filter((c) => c.type === 'PRODUCT');
    const full = await mapLimit(top, 8, (c) => Promise.all([get(`/products/${c.id}`), bestOffer(c.id)])
      .then(([prod, offer]) => (offer ? catalogItem(prod, offer, Number(c.position) || null) : null))
      .catch(() => null));
    return full.filter(Boolean);
  }

  /** Mais vendidos da categoria da busca. Só entram os de tipo PRODUCT (catálogo). Falha vira lista vazia. */
  async function bestSellers(q) {
    try {
      const dd = await get('/sites/MLB/domain_discovery/search', { q, limit: 1 });
      const cat = Array.isArray(dd) ? dd[0]?.category_id : null;
      return cat ? await bestSellersOf(cat) : [];
    } catch (_) {
      return [];
    }
  }

  return {
    /** O que as pessoas estão buscando agora no Mercado Livre (geral ou de uma categoria). */
    async trends(categoryId) {
      const d = await get(categoryId ? `/trends/MLB/${categoryId}` : '/trends/MLB');
      return (Array.isArray(d) ? d : []).map((t) => String(t.keyword || '').trim()).filter(Boolean).slice(0, 20);
    },

    /** Categorias principais do Mercado Livre Brasil. */
    async categories() {
      const d = await get('/sites/MLB/categories');
      return (Array.isArray(d) ? d : []).map((c) => ({ id: c.id, name: c.name }));
    },

    /** Mais vendidos de uma categoria, sem precisar digitar nada. */
    async bestSellersOf(categoryId) {
      if (!/^MLB\d+$/.test(String(categoryId))) throw new Error('Categoria inválida.');
      return { items: await bestSellersOf(categoryId), hasMore: false };
    },

    async search({ q, page = 1, limit = 50, sort = 'relevancia' }) {
      const p = Math.max(1, Number(page) || 1);
      try {
        const offset = (p - 1) * limit;
        const data = await get('/sites/MLB/search', { q, limit, offset, sort: SORT[sort] });
        const items = (data.results || []).map((it) => fromItem(it, defaultCommission));
        const total = Number(data.paging?.total) || 0;
        return { items, hasMore: offset + items.length < Math.min(total, 1000) };
      } catch (e) {
        if (e.status !== 403) throw e;
      }
      // Muitas contas não têm acesso à busca de anúncios (403). O catálogo está liberado, mas sem preço, e muitos
      // produtos dele não têm vendedor ativo. Na 1ª página vêm primeiro os mais vendidos da categoria; depois,
      // os produtos do catálogo que têm vendedor (o preço vem de uma consulta por produto).
      const size = 50;
      const offset = (p - 1) * size;
      const [data, top] = await Promise.all([
        get('/products/search', { status: 'active', site_id: 'MLB', q, limit: size, offset }).catch((e) => {
          if (e.status === 404 || e.status === 400) return { results: [], paging: { total: 0 } };
          throw e;
        }),
        p === 1 ? bestSellers(q) : [],
      ]);
      const seen = new Set(top.map((x) => x.external_id));
      const products = (data.results || []).filter((prod) => !seen.has(prod.id));
      const offers = await mapLimit(products, 8, (prod) => bestOffer(prod.id).catch(() => null));
      const rest = (await Promise.all(products.map((prod, i) => (offers[i] ? catalogItem(prod, offers[i]) : null)))).filter(Boolean);
      const total = Number(data.paging?.total) || 0;
      return { items: [...top, ...rest], hasMore: offset + size < Math.min(total, 1000) };
    },

    /**
     * Preço atual. Para produto de catálogo (o que o garimpo salva) usa a oferta mais barata entre os vendedores.
     * Para código de anúncio, tenta /items, que nem toda conta pode consultar.
     */
    async getItem(externalId) {
      const id = String(externalId || '');
      if (!/^MLB\d+$/.test(id)) throw new Error('ID do produto do Mercado Livre inválido.');
      try {
        const [prod, offer] = await Promise.all([get(`/products/${id}`), bestOffer(id)]);
        return offer ? await catalogItem(prod, offer) : null;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      try {
        return fromItem(await get(`/items/${id}`), defaultCommission);
      } catch (e) {
        if (e.status === 403) {
          throw new Error('O Mercado Livre não libera a consulta deste anúncio para a sua conta. Use o link da página do produto (com /p/MLB...) para poder atualizar o preço.');
        }
        throw e;
      }
    },
  };
}

module.exports = { createMercadoLivreClient, mercadoLivreOAuth: oauth, bigImage, commissionRule };
