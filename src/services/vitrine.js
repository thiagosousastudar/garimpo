/**
 * Vitrine (mini site da bio) e páginas de post: HTML gerado no servidor, leve e sem script de terceiros.
 * Mostra só o que a dona da vitrine escolheu; o botão de cada produto passa por /v/:slug/ir/:id,
 * que conta o clique e leva ao link de afiliado.
 */
const { parseExtras } = require('./extras');

const THEMES = {
  rosa: { bg1: '#FFF1F3', bg2: '#F6E7EA', ink: '#2A1A1D', muted: '#7A5A60', accent: '#C2496A', accentInk: '#FFFFFF', soft: '#FBE3E9', card: '#FFFFFF', line: '#F0D5DC' },
  creme: { bg1: '#FBF6EE', bg2: '#EFE6D8', ink: '#2B2219', muted: '#7A6A55', accent: '#9C6B30', accentInk: '#FFFFFF', soft: '#F4E9D6', card: '#FFFFFF', line: '#E8DCC8' },
  salvia: { bg1: '#F2F6F0', bg2: '#E3ECE1', ink: '#1C2A1F', muted: '#5A6E5D', accent: '#4F7A58', accentInk: '#FFFFFF', soft: '#E1ECDF', card: '#FFFFFF', line: '#D3E0D1' },
  azul: { bg1: '#F1F5FB', bg2: '#E2EAF5', ink: '#17222E', muted: '#566577', accent: '#2F5D8E', accentInk: '#FFFFFF', soft: '#DFE9F6', card: '#FFFFFF', line: '#D2DEEC' },
  lavanda: { bg1: '#F6F2FB', bg2: '#EAE3F5', ink: '#221B2E', muted: '#665C78', accent: '#7451A8', accentInk: '#FFFFFF', soft: '#ECE3F8', card: '#FFFFFF', line: '#DDD3EC' },
  preto: { bg1: '#161616', bg2: '#0E0E0E', ink: '#F5F1EA', muted: '#B5ADA2', accent: '#D9B36C', accentInk: '#161616', soft: '#2A2620', card: '#1F1F1F', line: '#2E2E2E' },
};
const THEME_NAMES = Object.keys(THEMES);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const httpsUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');
const brl = (n) => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STORE = { SH: 'Shopee', ML: 'Mercado Livre' };

/** Dados públicos de um produto (nada de comissão ou anotações). */
function publicProduct(row, name) {
  const ex = parseExtras(row.extras) || {};
  const price = Number(row.price);
  const orig = row.original_price == null ? null : Number(row.original_price);
  return {
    id: row.id,
    name: String(name || row.title || '').trim(),
    store: STORE[row.marketplace] || 'loja',
    image: httpsUrl(row.image_url),
    price,
    priceMax: ex.price_max && ex.price_max > price ? ex.price_max : null,
    orig: orig && orig > price ? orig : null,
    off: orig && orig > price ? Math.round((1 - price / orig) * 100) : 0,
    rating: row.rating == null ? null : Number(row.rating),
    sold: row.sales_k == null ? null : Number(row.sales_k),
    hasLink: Boolean(httpsUrl(row.affiliate_url) || httpsUrl(row.product_url)),
  };
}

function soldText(k) {
  if (!k || k <= 0) return '';
  if (k >= 1) return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10).toLocaleString('pt-BR') + ' mil vendidos';
  return Math.round(k * 1000) + ' vendidos';
}

function themeCss(key) {
  const t = THEMES[key] || THEMES.rosa;
  return `:root{--bg1:${t.bg1};--bg2:${t.bg2};--ink:${t.ink};--muted:${t.muted};--accent:${t.accent};--accent-ink:${t.accentInk};--soft:${t.soft};--card:${t.card};--line:${t.line}}`;
}

function initials(title) {
  const w = String(title || '?').trim().split(/\s+/).filter(Boolean);
  return esc(((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase());
}

function avatar(s, size = '') {
  const img = httpsUrl(s.avatar_url);
  return `<div class="av ${size}">${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : `<span>${initials(s.title)}</span>`}</div>`;
}

function head({ title, description, image, theme, url }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}<meta property="og:url" content="${esc(url)}">
<meta name="theme-color" content="${esc((THEMES[theme] || THEMES.rosa).bg1)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,500&family=Figtree:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/vitrine.css?v=1"><style>${themeCss(theme)}</style></head>`;
}

function card(p, base, big = false) {
  const price = `<div class="price"><b>${p.priceMax ? '<small>a partir de</small> ' : ''}${brl(p.price)}</b>${p.orig ? `<s>${brl(p.orig)}</s>` : ''}</div>`;
  const meta = [p.rating ? `★ ${p.rating.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}` : '', soldText(p.sold)].filter(Boolean).join(' · ');
  const cta = p.hasLink
    ? `<a class="cta" href="${esc(base)}/ir/${p.id}" target="_blank" rel="nofollow sponsored noopener">Ver na ${esc(p.store)} <span aria-hidden="true">→</span></a>`
    : '<span class="cta off">Link em breve</span>';
  return `<article class="pc${big ? ' big' : ''}" data-q="${esc((p.name + ' ' + p.store).toLowerCase())}">
<div class="ph">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="noimg"></span>'}${p.off >= 5 ? `<span class="off">−${p.off}%</span>` : ''}<span class="st">${esc(p.store)}</span></div>
<div class="pb"><h3>${esc(p.name)}</h3>${price}${meta ? `<p class="mt">${esc(meta)}</p>` : ''}${cta}</div></article>`;
}

function footer(s, base) {
  return `<footer><p class="disc">Os links desta página são de afiliado: posso ganhar uma comissão quando você compra por eles, sem nenhum custo a mais para você. Preços e estoque podem mudar; confira no site da loja antes de comprar.</p>
<p class="fine">${esc(s.title)} · <a href="${esc(base)}">Vitrine</a></p></footer>`;
}

function socials(s) {
  const out = [];
  const wa = httpsUrl(s.whatsapp_url); const tg = httpsUrl(s.telegram_url);
  const ig = String(s.instagram || '').replace(/^@/, '').trim();
  if (wa) out.push(`<a class="so wa" href="${esc(wa)}" target="_blank" rel="noopener">💬 Grupo no WhatsApp</a>`);
  if (tg) out.push(`<a class="so tg" href="${esc(tg)}" target="_blank" rel="noopener">✈️ Canal no Telegram</a>`);
  if (/^[A-Za-z0-9._]{1,30}$/.test(ig)) out.push(`<a class="so ig" href="https://www.instagram.com/${esc(ig)}/" target="_blank" rel="noopener">📸 @${esc(ig)}</a>`);
  return out.length ? `<nav class="socials">${out.join('')}</nav>` : '';
}

/** Página da vitrine. sections: [{ id, name, emoji, description, products: [publicProduct] }]; posts: [{ id, name, image, count }]. */
function renderStore({ store: s, sections, posts, base, url, preview }) {
  const filled = sections.filter((x) => x.products.length);
  const total = filled.reduce((n, x) => n + x.products.length, 0);
  const firstImg = (filled[0] && filled[0].products.find((p) => p.image)) || null;
  const chips = filled.length > 1 ? `<nav class="chips" aria-label="Categorias">${filled.map((x) => `<a href="#c${x.id}">${x.emoji ? esc(x.emoji) + ' ' : ''}${esc(x.name)}</a>`).join('')}</nav>` : '';
  const postStrip = posts.length ? `<section class="posts"><h2 class="lbl">Dos últimos posts</h2><div class="strip">${posts.map((p) => `<a class="post" href="${esc(base)}/p/${p.id}">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="noimg"></span>'}<span><b>${esc(p.name)}</b><small>${p.count} ${p.count === 1 ? 'item' : 'itens'} →</small></span></a>`).join('')}</div></section>` : '';
  const body = filled.length
    ? filled.map((x) => `<section class="cat" id="c${x.id}"><div class="ch"><h2>${x.emoji ? `<span class="em">${esc(x.emoji)}</span>` : ''}${esc(x.name)}</h2>${x.description ? `<p>${esc(x.description)}</p>` : ''}</div><div class="grid">${x.products.map((p) => card(p, base)).join('')}</div></section>`).join('')
    : '<p class="empty">Os achadinhos estão chegando. Volte daqui a pouco!</p>';
  const desc = s.bio || `Achadinhos selecionados por ${s.title}`;
  return `${head({ title: s.title, description: desc, image: httpsUrl(s.avatar_url) || (firstImg && firstImg.image), theme: s.theme, url })}
<body>${preview ? '<div class="pv">Prévia: só você vê. Publique no Garimpo para liberar a vitrine.</div>' : ''}<main>
<header class="hero">${avatar(s)}<h1>${esc(s.title)}</h1>${s.bio ? `<p class="bio">${esc(s.bio)}</p>` : ''}
<ul class="trust"><li>✅ Links verificados</li><li>🔒 Compra no site oficial</li><li>💸 Preços conferidos</li></ul>${socials(s)}</header>
${total > 3 ? '<div class="search"><input id="q" type="search" placeholder="Buscar achadinho…" aria-label="Buscar achadinho" autocomplete="off"></div>' : ''}
${chips}${postStrip}${body}<p class="none" id="none" hidden>Nada encontrado com essa busca.</p>
${footer(s, base)}</main><script src="/vitrine.js?v=1" defer></script></body></html>`;
}

/** Página de um post (lista salva na Mensagem com links). */
function renderPost({ store: s, list, products, base, url, preview }) {
  const firstImg = products.find((p) => p.image);
  return `${head({ title: `${list.name} · ${s.title}`, description: `Os ${products.length} achadinhos do post, com link direto para a loja.`, image: firstImg && firstImg.image, theme: s.theme, url })}
<body>${preview ? '<div class="pv">Prévia: só você vê. Publique a vitrine no Garimpo para liberar esta página.</div>' : ''}<main>
<header class="hero small"><a class="back" href="${esc(base)}">${avatar(s, 'sm')}<span>${esc(s.title)}</span></a>
<h1>${esc(list.name)}</h1><p class="bio">Os ${products.length} ${products.length === 1 ? 'achadinho' : 'achadinhos'} do post, com link direto para a loja 💖</p></header>
<div class="list">${products.map((p, i) => card({ ...p, name: `${i + 1}. ${p.name}` }, base, true)).join('') || '<p class="empty">Os itens deste post não estão mais disponíveis.</p>'}</div>
<a class="more" href="${esc(base)}">Ver todos os achadinhos →</a>
${footer(s, base)}</main></body></html>`;
}

function renderMissing(msg) {
  return `${head({ title: 'Vitrine', description: msg, theme: 'rosa', url: '' })}<body><main><header class="hero"><h1>Ops!</h1><p class="bio">${esc(msg)}</p></header></main></body></html>`;
}

module.exports = { THEMES, THEME_NAMES, publicProduct, renderStore, renderPost, renderMissing, httpsUrl };
