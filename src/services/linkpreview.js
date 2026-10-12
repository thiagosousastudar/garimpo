/**
 * Cadastro por link: o usuário cola links de produto (inclusive links curtos de afiliado) e o app descobre
 * o produto. Sem a API da Shopee, os dados vêm da prévia de link (Open Graph), a mesma que mensageiros
 * mostram ao colar o link: nome, foto e descrição; o preço não vem e o usuário completa.
 * No Mercado Livre, com a conta conectada, os dados completos vêm da API.
 *
 * Segurança: só segue endereços da Shopee e do Mercado Livre (lista fechada, inclusive nos redirecionamentos),
 * no máximo 5 saltos, com tempo-limite. O app se identifica pelo próprio nome (GarimpoLinkPreview).
 */
const UA_PREVIEW = 'GarimpoLinkPreview/1.0 (link preview bot, like WhatsApp/Twitterbot)';
const UA_BROWSER = 'Mozilla/5.0 (compatible; GarimpoLinkPreview/1.0)';

const SHOPEE = (h) => h === 'shopee.com.br' || h.endsWith('.shopee.com.br') || h === 'shope.ee';
const ML = (h) => /(^|\.)mercadoli(vre|bre)\.com(\.br)?$/.test(h) || h === 'meli.la';

function marketplaceOf(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (SHOPEE(h)) return 'SH';
  if (ML(h)) return 'ML';
  return null;
}

/** Segue os redirecionamentos (só dentro das lojas) e devolve o endereço final. */
async function resolve(url, fetchImpl) {
  let cur = url;
  for (let i = 0; i < 5; i++) {
    const r = await fetchImpl(cur, { redirect: 'manual', headers: { 'user-agent': UA_BROWSER }, signal: AbortSignal.timeout(10000) });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      const next = new URL(loc, cur);
      if (next.protocol !== 'https:' || !marketplaceOf(next.hostname)) return cur; // não sai das lojas
      cur = next.toString();
      continue;
    }
    return cur;
  }
  return cur;
}

/** Entidades HTML das meta tags: nomeadas comuns e numéricas ("&#43;" = "+", "&#x2B;" = "+"). */
const decode = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

/** Prévia Open Graph do link: título, foto, descrição (e preço, se a página informar). */
async function openGraph(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'user-agent': UA_PREVIEW, 'accept-language': 'pt-BR' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const html = (await r.text()).slice(0, 300000);
  const meta = (p) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${p}["']`, 'i'));
    return m ? decode(m[1]).trim() : null;
  };
  const desc = meta('description') || meta('og:description') || '';
  // A Shopee corta o og:title ("...") mas põe o nome inteiro na descrição: "Compre <nome> na Shopee Brasil!"
  const full = (desc.match(/^Compre (.+?) na Shopee Brasil!/) || [])[1];
  const title = (full || meta('og:title') || '').replace(/\s*\|\s*Mercado Livre.*$/i, '').trim();
  const price = Number(meta('product:price:amount') || meta('price') || NaN);
  return {
    title: title || null,
    image_url: meta('og:image') || null,
    description: desc.replace(/^Compre .+? na Shopee Brasil!\s*/, '').slice(0, 300) || null,
    price: Number.isFinite(price) && price > 0 ? price : null,
  };
}

const shopeeIds = (u) => {
  const m = String(u).match(/shopee\.com\.br\/(?:[^/?#]+\/)?(\d{3,})\/(\d{3,})/) || String(u).match(/-i\.(\d+)\.(\d+)/) || String(u).match(/\/product\/(\d+)\/(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
};

/**
 * Descobre o produto de um link. Devolve um item no formato do garimpo (sem salvar) ou { error }.
 * mlClient (opcional): cliente do Mercado Livre já autenticado, para os dados completos.
 * externalIdFrom: função do garimpo que tira o código MLB do link.
 */
async function previewLink(raw, { fetchImpl = fetch, mlClient = null, externalIdFrom }) {
  let u;
  try { u = new URL(String(raw).trim()); } catch (_) { return { link: raw, error: 'Link inválido.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { link: raw, error: 'Link inválido.' };
  if (u.protocol === 'http:') u.protocol = 'https:';
  const mk = marketplaceOf(u.hostname);
  if (!mk) return { link: raw, error: 'Só links da Shopee ou do Mercado Livre.' };
  const link = u.toString();
  let finalUrl = link;
  try { finalUrl = await resolve(link, fetchImpl); } catch (_) { /* segue com o link original */ }

  if (mk === 'ML' || marketplaceOf(new URL(finalUrl).hostname) === 'ML') {
    const id = externalIdFrom('ML', finalUrl) || externalIdFrom('ML', link);
    if (id && mlClient) {
      try {
        const full = await mlClient.getItem(id);
        if (full && full.price) return { ...full, link, affiliate_url: link, source: 'api' };
      } catch (_) { /* cai na prévia */ }
    }
    const og = await openGraph(finalUrl, fetchImpl).catch(() => null);
    if (!og || !og.title) return { link, error: 'Não consegui ler este produto do Mercado Livre. Use o link da página do produto.' };
    return { marketplace: 'ML', external_id: id, title: og.title, image_url: og.image_url, price: og.price, original_price: null,
      product_url: finalUrl.split('?')[0], affiliate_url: link, link, source: 'preview' };
  }

  const ids = shopeeIds(finalUrl) || shopeeIds(link);
  const og = await openGraph(link, fetchImpl).catch(() => null);
  if (!og || !og.title) return { link, external_id: ids, error: 'Não consegui ler a prévia deste link da Shopee.' };
  return {
    marketplace: 'SH', external_id: ids, title: og.title.slice(0, 300), image_url: og.image_url, price: og.price, original_price: null,
    product_url: ids ? `https://shopee.com.br/product/${ids.replace('.', '/')}` : finalUrl.split('?')[0],
    affiliate_url: link, link, description: og.description, source: 'preview',
  };
}

/** "10mil+" -> 10, "2,5mil" -> 2.5, "66" -> 0.066 (em milhares, como sales_k). */
function salesK(v) {
  const s = String(v || '').toLowerCase().replace(/\+/g, '').trim();
  if (!s) return null;
  const mil = /mil|k/.test(s);
  const n = Number(s.replace(/mil|k/g, '').replace(/\./g, '').replace(',', '.').trim());
  if (!Number.isFinite(n)) return null;
  return mil ? n : Math.round((n / 1000) * 1000) / 1000;
}

const brNum = (v) => {
  const s = String(v || '').replace(/R\$|%|\s/g, '');
  if (!s) return null;
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Planilha "Obter link em massa" do painel de afiliados da Shopee (BatchProductLinks*.csv):
 * Item Id, Item Name, Price, Sales, Nome da loja, Commission Rate, Commission, Product Link, Offer Link.
 * rows: saída de parseCsv (cabeçalhos em minúsculas, sem acento). Devolve null se não for esse formato.
 */
function fromShopeeBatch(rows) {
  if (!rows.length || !('offer link' in rows[0]) || !('item name' in rows[0])) return null;
  return rows.filter((r) => r['item name'] && r['offer link']).map((r) => {
    const ids = shopeeIds(r['product link']);
    return {
      marketplace: 'SH',
      external_id: ids,
      title: String(r['item name']).trim().slice(0, 300),
      price: brNum(r.price),
      original_price: null,
      commission_pct: brNum(r['commission rate']),
      commission_auto: brNum(r['commission rate']) !== null,
      sales_k: salesK(r.sales),
      shop: (r['nome da loja'] || '').trim() || null,
      product_url: ids ? `https://shopee.com.br/product/${ids.replace('.', '/')}` : r['product link'] || null,
      affiliate_url: r['offer link'],
      link: r['offer link'],
      image_url: null,
      source: 'planilha',
    };
  });
}

/** Busca a foto (prévia do link) de vários itens, 8 por vez, até o tempo-limite. Quem não der fica sem foto. */
async function fillImages(items, fetchImpl, budgetMs = 40000) {
  const deadline = Date.now() + budgetMs;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (next < items.length && Date.now() < deadline) {
      const it = items[next++];
      if (it.image_url || !it.link) continue;
      let u;
      try { u = new URL(it.link); } catch (_) { continue; }
      if (u.protocol !== 'https:' || marketplaceOf(u.hostname) !== 'SH') continue; // só busca na Shopee
      try { const og = await openGraph(u.toString(), fetchImpl); if (og?.image_url) it.image_url = og.image_url; } catch (_) { /* fica sem foto */ }
    }
  }));
  return items;
}

module.exports = { previewLink, marketplaceOf, shopeeIds, fromShopeeBatch, fillImages, salesK };
