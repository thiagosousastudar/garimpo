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
function fromCatalog(p, offer, defaultCommission, rank = null) {
  const price = num(offer?.price) ?? num(p.buy_box_winner?.price);
  const orig = num(offer?.original_price) ?? num(p.buy_box_winner?.original_price);
  return {
    marketplace: 'ML',
    external_id: p.id || null,
    title: String(p.name || p.title || '').slice(0, 300),
    price,
    original_price: orig && orig > price ? orig : null,
    rating: null,
    sales_k: null,
    commission_pct: defaultCommission ?? null,
    product_url: p.permalink || (p.id ? `https://www.mercadolivre.com.br/p/${p.id}` : null),
    affiliate_url: null,
    image_url: bigImage(p.pictures?.[0]?.secure_url || p.pictures?.[0]?.url),
    shop: null,
    best_seller_rank: rank,
  };
}

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

function createMercadoLivreClient({ token, defaultCommission = null, fetchImpl = fetch }) {
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
    return offers.length ? offers.reduce((a, b) => (num(b.price) < num(a.price) ? b : a)) : null;
  }

  /**
   * Os mais vendidos da categoria da busca (até 20, em ordem de ranking), já com nome, foto e a oferta mais barata.
   * Só entram os de tipo PRODUCT (catálogo), que são os que dá para consultar. Falha vira lista vazia.
   */
  async function bestSellers(q) {
    try {
      const dd = await get('/sites/MLB/domain_discovery/search', { q, limit: 1 });
      const cat = Array.isArray(dd) ? dd[0]?.category_id : null;
      if (!cat) return [];
      const h = await get(`/highlights/MLB/category/${cat}`);
      const top = (h.content || []).filter((c) => c.type === 'PRODUCT');
      const full = await mapLimit(top, 8, (c) => Promise.all([get(`/products/${c.id}`), bestOffer(c.id)])
        .then(([prod, offer]) => (offer ? fromCatalog(prod, offer, defaultCommission, Number(c.position) || null) : null))
        .catch(() => null));
      return full.filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  return {
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
      const rest = products.map((prod, i) => (offers[i] ? fromCatalog(prod, offers[i], defaultCommission) : null)).filter(Boolean);
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
        return offer ? fromCatalog(prod, offer, defaultCommission) : null;
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

module.exports = { createMercadoLivreClient, mercadoLivreOAuth: oauth, bigImage };
