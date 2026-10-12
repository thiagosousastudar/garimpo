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

/** Produto de catálogo (/products/search): o preço vem do vencedor da "buy box". */
function fromCatalog(p, defaultCommission) {
  const win = p.buy_box_winner || {};
  return {
    marketplace: 'ML',
    external_id: p.id || null,
    title: String(p.name || '').slice(0, 300),
    price: num(win.price),
    original_price: num(win.original_price) && num(win.original_price) > num(win.price) ? num(win.original_price) : null,
    rating: null,
    sales_k: null,
    commission_pct: defaultCommission ?? null,
    product_url: p.permalink || (p.id ? `https://www.mercadolivre.com.br/p/${p.id}` : null),
    affiliate_url: null,
    image_url: bigImage(p.pictures?.[0]?.url),
    shop: null,
  };
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

  return {
    async search({ q, page = 1, limit = 50, sort = 'relevancia' }) {
      const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
      try {
        const data = await get('/sites/MLB/search', { q, limit, offset, sort: SORT[sort] });
        const items = (data.results || []).map((it) => fromItem(it, defaultCommission));
        const total = Number(data.paging?.total) || 0;
        return { items, hasMore: offset + items.length < Math.min(total, 1000) };
      } catch (e) {
        if (e.status !== 403) throw e;
        // Algumas contas não têm acesso à busca de anúncios; o catálogo de produtos costuma estar liberado.
        const data = await get('/products/search', { status: 'active', site_id: 'MLB', q, limit, offset });
        const items = (data.results || []).map((p) => fromCatalog(p, defaultCommission)).filter((p) => p.price);
        const total = Number(data.paging?.total) || 0;
        return { items, hasMore: offset + limit < total };
      }
    },

    /** Preço atual de um anúncio (MLB + número). Produtos de catálogo usam /products. */
    async getItem(externalId) {
      const id = String(externalId || '');
      if (!/^MLB\d+$/.test(id)) throw new Error('ID do produto do Mercado Livre inválido.');
      try {
        return fromItem(await get(`/items/${id}`), defaultCommission);
      } catch (e) {
        if (e.status !== 404 && e.status !== 403) throw e;
        return fromCatalog(await get(`/products/${id}`), defaultCommission);
      }
    },
  };
}

module.exports = { createMercadoLivreClient, mercadoLivreOAuth: oauth, bigImage };
