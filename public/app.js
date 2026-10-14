(function () {
  'use strict';

  /* ---------- utilidades ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var app = $('#app');
  var dlg = $('#dlg');

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(function () { t.hidden = true; }, Math.max(2400, String(msg).length * 60));
  }
  function mktTag(m) { return m === 'ML' ? '<span class="tag ml">Mercado Livre</span>' : '<span class="tag sh">Shopee</span>'; }
  function safeUrl(u) { return /^(https?:\/\/|\/uploads\/)/i.test(u || '') ? u : ''; }
  function localInput(iso) {
    if (!iso) return '';
    var d = new Date(iso); var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtWhen(iso) {
    return iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  }

  function api(method, url, body, raw) {
    var opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (raw instanceof FormData) opts.body = raw;
    else if (typeof raw === 'string') { opts.headers['content-type'] = 'text/csv'; opts.body = raw; }
    else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && state.user && url.indexOf('/auth/') === -1) { state.user = null; render(); }
        if (!res.ok) { var e = new Error(data.error || 'Erro ' + res.status); e.status = res.status; throw e; }
        return data;
      });
    });
  }
  function guard(fn) {
    return function () {
      var args = arguments;
      return Promise.resolve().then(function () { return fn.apply(null, args); }).catch(function (e) { toast(e.message); });
    };
  }

  /* ---------- estado ---------- */
  var state = {
    user: null, loading: true, tab: 'garimpar', signup: false, ai: false,
    products: [], queue: [], summary: null, earnings: [], conn: null, mkts: null,
    mkt: 'todos', cat: 'todas', comMin: 0, ordem: prefGet('ordem', 'recentes'), days: 14, authMode: 'login',
    // garimpo sob demanda: filtros, resultados da última busca e itens marcados
    g: { mkt: 'ML', q: '', category: '', ship: '', sort: 'relevancia', onlyCom: false, sheetBusy: false,
      shview: 'produtos', ams: false, keySeller: false, top: false, shopId: null, shopName: null, shops: null, shopsQ: '', shopsType: 'todas', shopsSort: 'comissao', camps: null, linkOut: null, minDesc: 0, minCom: 0, minRat: 0, results: [], page: 1, more: false, busy: false, done: false, sel: {}, trends: null, cats: null },
    shipFilter: '', // filtro de frete na aba Produtos ('', 'free', 'cheap')
    shipZip: null, // CEP de referência do frete
    psel: {}, // produtos marcados para postar juntos (carrossel)
    brand: { color: null, handle: null }, // identidade das capas (cor e @)
    autos: [], // pilotos automáticos
    tg: null, // conexão do Telegram
    tgChats: null, // grupos/canais encontrados pelo bot
    pq: '', pflag: '', plimit: 24, pexp: {}, // Produtos: busca, situação, quantos mostrar, cards abertos na lista
    pview: prefGet('pview', 'lista'), // Produtos: 'lista' (compacta) ou 'cards'
    gview: prefGet('gview', 'produtos'), // Garimpar: 'produtos' ou 'cupons'
    cp: { items: [], settings: null, loaded: false, parsed: null, text: '', mk: 'ML', link: '', msgChannel: 'whatsapp', msg: null },
    dm: { items: [], loaded: false, filter: 'pedidos', settings: null, defaults: null, syncedAt: null }, // Direct
    qfilter: '', // filtro da Fila ('', 'wa' = WhatsApp a enviar, 'piloto')
  };

  var ICONS = {
    'Casa e cozinha': '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    'Eletrônicos': '<path d="M4 15v-3a8 8 0 0116 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
    'Beleza': '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/>',
    'Acessórios': '<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 016 0v2"/>',
  };
  var CLASSE = { 'Casa e cozinha': 't0', 'Eletrônicos': 't1', 'Beleza': 't2', 'Acessórios': 't3' };

  function thumb(p, small) {
    var img = safeUrl(p.image_url || p.product_image);
    var cls = CLASSE[p.category] || 't0';
    var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[p.category] || ICONS['Casa e cozinha']) + '</svg>';
    var vid = p.video_url && !small ? '<span class="vid">▶ vídeo</span>' : '';
    return '<div class="thumb ' + cls + (small ? ' sm' : '') + '">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : icon) + vid + '</div>';
  }

  /* ---------- carregamento ---------- */
  function loadAll() {
    return Promise.all([
      api('GET', '/api/products'), api('GET', '/api/queue'),
      api('GET', '/api/earnings/summary?days=' + state.days), api('GET', '/api/earnings'),
      api('GET', '/api/connections/instagram'), api('GET', '/api/connections/marketplaces'),
      api('GET', '/api/automations').catch(function () { return { items: [] }; }),
      api('GET', '/api/connections/telegram').catch(function () { return null; }),
    ]).then(function (r) {
      state.products = r[0].products; state.queue = r[1].items; state.summary = r[2];
      state.earnings = r[3].earnings; state.conn = r[4]; state.mkts = r[5];
      state.autos = r[6].items; state.tg = r[7];
      loadMlExtras();
    });
  }

  /** Tendências e categorias do Mercado Livre: carregadas uma vez, em segundo plano, quando ele está conectado. */
  function loadMlExtras() {
    var g = state.g;
    if (!mktReady('ML') || g.trends) return;
    g.trends = [];
    Promise.all([
      api('GET', '/api/garimpo/trends').then(function (r) { g.trends = r.trends; }).catch(function () {}),
      api('GET', '/api/garimpo/categories').then(function (r) { g.cats = r.categories; }).catch(function () {}),
    ]).then(function () { if (state.tab === 'garimpar' || state.tab === 'conexoes') render(); });
  }
  function reload() { return loadAll().then(render); }

  /* ---------- telas ---------- */
  function viewLogin() {
    var reg = state.authMode === 'register';
    return '<div class="login"><div class="brand"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.7 6.7 19.6l1.1-6L3.4 9.4l6-.8z"/></svg></div><h1>Garimpo</h1></div>' +
      '<p class="hint">Encontre os produtos campeões, prepare as postagens e acompanhe suas comissões.</p>' +
      '<form class="stack" id="auth-form">' +
      (reg ? '<div class="field"><label for="a-name">Nome</label><input id="a-name" name="name" type="text" autocomplete="name"></div>' : '') +
      '<div class="field"><label for="a-email">E-mail</label><input id="a-email" name="email" type="email" autocomplete="email" required></div>' +
      '<div class="field"><label for="a-pass">Senha</label><input id="a-pass" name="password" type="password" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" minlength="8" required></div>' +
      '<p class="err" id="auth-err" role="alert"></p>' +
      '<button class="btn primary" type="submit">' + (reg ? 'Criar conta' : 'Entrar') + '</button></form>' +
      (state.signup ? '<button class="link" data-act="toggle-auth">' + (reg ? 'Já tenho conta. Entrar' : 'Não tenho conta. Criar agora') + '</button>' : '') +
      '<div class="row">' + themeButton() + '</div></div>';
  }

  /* ---------- tema: automático (segue o sistema) → claro → escuro ---------- */
  var THEMES = { auto: ['◐', 'Tema automático', 'light'], light: ['☀', 'Tema claro', 'dark'], dark: ['☾', 'Tema escuro', 'auto'] };
  function currentTheme() { var t = document.documentElement.getAttribute('data-theme'); return t === 'light' || t === 'dark' ? t : 'auto'; }
  function themeButton() {
    var t = THEMES[currentTheme()];
    return '<button class="btn small ghost theme-btn" data-act="theme" title="Trocar tema (automático, claro, escuro)" aria-label="' + t[1] + '. Trocar tema">' + t[0] + ' <span>' + t[1].replace('Tema ', '') + '</span></button>';
  }
  function setTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try { if (t === 'auto') localStorage.removeItem('garimpo-theme'); else localStorage.setItem('garimpo-theme', t); } catch (_) { /* só não lembra a escolha */ }
  }

  function shell(body) {
    var pend = state.queue.filter(function (q) { return q.status === 'draft' || q.status === 'scheduled' || q.status === 'failed'; }).length;
    var tabs = [['garimpar', 'Garimpar', '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'],
      ['descobrir', 'Produtos', '<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 016 0v2"/>'],
      ['fila', 'Fila', '<path d="M4 6h16M4 12h16M4 18h10"/>'],
      ['direct', 'Direct', '<path d="M21 11.5a8.4 8.4 0 01-12.2 7.5L3 21l2-5.6A8.5 8.5 0 1121 11.5z"/>'],
      ['piloto', 'Piloto', '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2"/>'],
      ['ganhos', 'Ganhos', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
      ['conexoes', 'Conexões', '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/>']];
    return '<header class="top"><div class="brand"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.7 6.7 19.6l1.1-6L3.4 9.4l6-.8z"/></svg></div><h1>Garimpo</h1></div>' +
      '<div class="top-actions"><span class="who">' + esc(state.user.name || state.user.email) + '</span>' + themeButton() + '<button class="btn small ghost" data-act="logout">Sair</button></div></header>' +
      '<nav class="tabs" role="tablist" aria-label="Seções">' + tabs.map(function (t) {
        return '<button role="tab" aria-selected="' + (state.tab === t[0]) + '" data-tab="' + t[0] + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + t[2] + '</svg>' + t[1] + (t[0] === 'fila' && pend ? '<span class="badge">' + pend + '</span>' : '') + '</button>';
      }).join('') + '</nav><main>' + body + '</main>';
  }

  function ago(iso) {
    if (!iso) return 'nunca';
    var h = (Date.now() - new Date(iso).getTime()) / 36e5;
    if (h < 1) return 'agora há pouco';
    if (h < 24) return 'há ' + Math.floor(h) + ' h';
    var d = Math.floor(h / 24); return 'há ' + d + (d === 1 ? ' dia' : ' dias');
  }
  function staleHours(p) { return p.price_checked_at ? (Date.now() - new Date(p.price_checked_at).getTime()) / 36e5 : Infinity; }
  function mktReady(m) {
    var s = state.mkts || {};
    return m === 'SH' ? Boolean(s.SH && s.SH.connected) : Boolean(s.ML && s.ML.authorized);
  }
  function mktName(m) { return m === 'ML' ? 'Mercado Livre' : 'Shopee'; }
  function selectEl(id, name, label, opts, cur) {
    return '<select id="' + id + '" name="' + name + '" aria-label="' + label + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }
  /** Vendas em milhares -> "72 vendidos" ou "8,5 mil vendidos". */
  function fmtSales(k) { return k >= 1 ? String(Math.round(k * 10) / 10).replace('.', ',') + ' mil vendidos' : Math.round(k * 1000) + ' vendidos'; }
  function statsBlock(p) {
    var hasCom = p.commission_pct != null;
    var fix = p.marketplace === 'ML' ? '<button class="link small" data-tab="conexoes" title="Preencha a tabela de comissão por categoria em Conexões">definir</button>' : '—';
    return '<div class="stats"><div><span>Comissão</span><b class="num">' + (hasCom ? p.commission_pct + '%' : fix) + '</b></div>' +
      '<div><span>Você ganha</span><b class="num earn">' + (hasCom ? brl(p.earn_per_sale) : '—') + '</b><small class="hint">' + (hasCom ? 'por venda' : 'sem comissão') + '</small></div>' +
      (p.rating || !p.sales_k ? '<div><span>Avaliação</span><b class="num">' + (p.rating ? '★ ' + Number(p.rating).toFixed(1) : '—') + '</b>' + (p.sales_k ? '<small class="hint">' + fmtSales(p.sales_k) + '</small>' : '') + '</div>' : '<div><span>Vendas</span><b class="num">' + fmtSales(p.sales_k) + '</b></div>') + '</div>';
  }
  /** Selos da oferta: ranking, frete grátis, Full, loja oficial, nº de vendedores. */
  function badges(p) {
    var b = [];
    if (p.best_seller_rank) b.push('<span class="tag top">' + p.best_seller_rank + 'º mais vendido</span>');
    if (p.free_shipping) b.push('<span class="tag free">Frete grátis</span>');
    if (p.full) b.push('<span class="tag full">⚡ Full</span>');
    if (p.official_store) b.push('<span class="tag off">Loja oficial</span>');
    if (p.sellers > 1) b.push('<span class="tag plain">' + p.sellers + ' vendedores</span>');
    if (p.seller_commission_pct) b.push('<span class="tag hl" title="Parte da comissão paga pela própria loja">💰 +' + String(p.seller_commission_pct).replace('.', ',') + '% da loja</span>');
    if (p.shop_labels && p.shop_labels.length && !p.official_store) p.shop_labels.forEach(function (l) { b.push('<span class="tag plain">' + esc(l) + '</span>'); });
    if (p.has_video) b.push('<span class="tag plain" title="O anúncio tem vídeo no Mercado Livre; a API não libera o arquivo">🎬 anúncio com vídeo</span>');
    return b.length ? '<div class="badges">' + b.join('') + '</div>' : '';
  }
  /** Comparação com o histórico: menor preço do período, caiu/subiu desde a última conferência, "de" inflado. */
  function priceTrend(p) {
    var s = p.price_stats;
    if (!s || s.count < 2) return '';
    var out = [];
    if (p.price <= s.min && s.max > s.min) out.push('<span class="trend down">Menor preço em 90 dias</span>');
    else if (s.previous != null && p.price < s.previous) out.push('<span class="trend down">↓ caiu de ' + brl(s.previous) + '</span>');
    else if (s.previous != null && p.price > s.previous) out.push('<span class="trend up">↑ subiu de ' + brl(s.previous) + '</span>');
    if (s.inflated_original) out.push('<span class="trend warn" title="Nas conferências dos últimos 90 dias o produto nunca custou o preço original anunciado">⚠ Desconto suspeito: o "preço de" nunca foi visto</span>');
    return out.length ? '<div class="trends-line">' + out.join('') + '</div>' : '';
  }
  /**
   * Frete até o CEP de referência e o total que o comprador paga. Frete acima de 30% do preço ganha alerta:
   * quem vê o preço no post e encontra um total bem maior no checkout costuma desistir.
   */
  function shipInfo(p) {
    if (p.free_shipping || p.shipping_cost === 0 || p.shipping_cost == null) return '';
    var high = p.shipping_cost > p.price * 0.3;
    var zip = p.shipping_zip ? ' <span class="hint">(CEP ' + esc(p.shipping_zip.slice(0, 5) + '-' + p.shipping_zip.slice(5)) + ')</span>' : '';
    return '<p class="ship' + (high ? ' high' : '') + '">Frete ' + brl(p.shipping_cost) + ' · total ' + brl(p.price + p.shipping_cost) + zip +
      (high ? '<br><b>⚠ Frete alto</b>: o comprador paga ' + Math.round((p.shipping_cost / p.price) * 100) + '% a mais no checkout.' : '') + '</p>';
  }
  function shipFilterOk(p, mode) {
    if (!mode) return true;
    var free = p.free_shipping || p.shipping_cost === 0;
    if (mode === 'free') return free;
    return free || (p.shipping_cost != null && p.shipping_cost <= p.price * 0.15);
  }
  var SHIP_OPTS = [['', 'Qualquer frete'], ['free', 'Só frete grátis'], ['cheap', 'Frete grátis ou barato']];
  function priceBlock(p) {
    var range = p.price_max > p.price; // produto com opções/kits: preço "a partir de"
    return '<div class="price">' + (range ? '<span class="from">a partir de</span>' : '') + '<strong class="num">' + brl(p.price) + '</strong>' + (p.original_price ? '<s class="num">' + brl(p.original_price) + '</s>' : '') + (p.desc ? '<span class="off num">−' + p.desc + '%</span>' : '') +
      (range ? '<span class="hint num">até ' + brl(p.price_max) + ' conforme a opção</span>' : '') + '</div>';
  }

  var G_SORTS = [['relevancia', 'Recomendados (ordem da loja)'], ['ganho', 'Maior ganho por venda (R$)'], ['vendidos', 'Mais vendidos'], ['comissao', 'Maior comissão (%)'],
    ['desconto', 'Maior desconto'], ['preco', 'Menor preço'], ['nota', 'Melhor nota geral']];
  var G_SORTERS = {
    ganho: function (a, b) { return (b.earn_per_sale || 0) - (a.earn_per_sale || 0); },
    vendidos: function (a, b) { return (a.best_seller_rank || 1e9) - (b.best_seller_rank || 1e9) || (b.sales_k || 0) - (a.sales_k || 0); },
    comissao: function (a, b) { return (b.commission_pct || 0) - (a.commission_pct || 0); },
    desconto: function (a, b) { return (b.desc || 0) - (a.desc || 0); },
    preco: function (a, b) { return a.price - b.price; },
    nota: function (a, b) { return b.score - a.score; },
  };
  /** Mesma nota do servidor (score.js): 30% desconto, 30% comissão, 20% avaliação, 20% vendas. */
  function scoreOf(p) {
    var cl = function (x) { return Math.max(0, Math.min(1, x)); };
    var desc = p.original_price > p.price ? Math.round((1 - p.price / p.original_price) * 100) : 0;
    var com = Number(p.commission_pct) || 0;
    p.desc = desc;
    p.earn_per_sale = Math.round(p.price * com) / 100;
    p.score = Math.round(100 * (0.3 * cl(desc / 60) + 0.3 * cl(com / 16) + 0.2 * cl(((Number(p.rating) || 0) - 4) / 1) + 0.2 * cl((Number(p.sales_k) || 0) / 20)));
    return p;
  }
  /** Resultados na ordem e no filtro escolhidos, guardando o índice original (a seleção usa o índice). */
  function gView() {
    var g = state.g;
    var list = g.results.map(function (p, i) { return { p: p, i: i }; }).filter(function (x) {
      return (!g.onlyCom || x.p.commission_pct != null) && (!g.official || isOfficialP(x.p)) && (!g.priceMin || x.p.price >= g.priceMin);
    });
    var s = G_SORTERS[g.sort];
    if (s) list.sort(function (a, b) { return s(a.p, b.p) || a.i - b.i; });
    return list;
  }
  /** Loja oficial no Mercado Livre, ou loja oficial/Mall na Shopee (pelo nome da loja). */
  function isOfficialP(p) { return p.official_store === true || /oficial|official|\bmall\b/i.test((p.shop || '') + ' ' + (p.notes || '')); }
  /** Destaques entre os resultados: maior ganho, mais vendido e maior desconto. */
  function gHighlights(list) {
    var best = function (key) {
      var top = null, topV = null;
      list.forEach(function (x) { var v = key(x.p); if (v != null && v > 0 && (topV === null || v > topV)) { top = x; topV = v; } });
      return top;
    };
    var earn = best(function (p) { return p.commission_pct != null ? p.earn_per_sale : null; });
    var sold = best(function (p) { return p.best_seller_rank ? 1e6 - p.best_seller_rank : p.sales_k || null; });
    var off = best(function (p) { return p.desc || null; });
    var tags = {};
    var add = function (x, t) { if (x) tags[x.i] = (tags[x.i] || []).concat(t); };
    add(earn, '🏆 Maior ganho'); add(sold, '🔥 Mais vendido'); add(off, '💥 Maior desconto');
    return { tags: tags, earn: earn, sold: sold, off: off };
  }
  function mlComMissing() {
    var ml = (state.mkts || {}).ML || {};
    return ml.default_commission == null && !Object.keys(ml.commission_table || {}).length;
  }
  /** Mercado Livre sem comissão nesta categoria: campo para preencher ali mesmo (vale para a categoria toda). */
  function setComInline(p) {
    if (p.marketplace !== 'ML' || p.commission_pct != null || !p.category_id) return '';
    return '<div class="setcom"><span>Comissão em <b>' + esc(p.category || 'esta categoria') + '</b>:</span><input type="text" inputmode="decimal" data-comcat="' + esc(p.category_id) + '" placeholder="Ex.: 8" aria-label="Comissão em ' + esc(p.category || '') + ' (%)"><em>%</em>' +
      '<button type="button" class="btn small" data-comsave="' + esc(p.category_id) + '">OK</button></div>';
  }
  function shopeeSheetCard(apiReady) {
    var g = state.g;
    return '<section class="card sheetcard"><h3>📄 Garimpar pela planilha da Shopee</h3>' +
      '<p class="hint">' + (apiReady ? 'Outra forma de garimpar: ' : 'Enquanto a API da Shopee não é liberada, garimpe assim. ') + 'A planilha traz <b>preço, comissão, vendas e o seu link de afiliado</b> de até 100 produtos de uma vez.</p>' +
      '<ol class="steps"><li>No portal de afiliados da Shopee, abra <b>Ofertas de produtos</b> e ordene por <b>maior comissão</b> ou <b>mais vendidos</b> (dá para filtrar por categoria).</li>' +
      '<li>Marque os produtos (ou "selecionar todos") e clique em <b>Obter link em massa</b> → baixar CSV.</li>' +
      '<li>Envie o arquivo aqui. Produtos que você já salvou ganham a comissão e as vendas que faltavam.</li></ol>' +
      '<div class="row"><label class="btn primary" for="g-sheet"' + (g.sheetBusy ? ' aria-disabled="true"' : '') + '>' + (g.sheetBusy ? 'Lendo a planilha e buscando as fotos…' : 'Enviar planilha (CSV)') + '</label>' +
      '<input id="g-sheet" class="file-input" type="file" accept=".csv,text/csv" hidden' + (g.sheetBusy ? ' disabled' : '') + '>' +
      (g.sheetBusy ? '<span class="hint">pode levar até 1 minuto</span>' : '') + '</div></section>';
  }

  /* ---------- cupons (dentro de Garimpar) ---------- */
  var CP_STATUS = { valido: ['Válido', 'posted'], hoje: ['Vence hoje', 'scheduled'], vencido: ['Vencido', 'failed'], pausado: ['Pausado', 'draft'] };
  function cpDesc(c) {
    var off = c.kind === 'value' ? brl(c.amount) + ' OFF' : String(c.amount).replace('.', ',') + '% OFF';
    var min = c.min_purchase > 1 ? 'a partir de ' + brl(c.min_purchase) : 'sem mínimo';
    return off + ' · ' + min + (c.kind !== 'value' && c.max_discount ? ' · limite ' + brl(c.max_discount) : '');
  }
  function loadCoupons() {
    return api('GET', '/api/coupons').then(function (r) { state.cp.items = r.items; state.cp.settings = r.settings; state.cp.today = r.today; state.cp.loaded = true; })
      .then(loadCouponMsg);
  }
  function loadCouponMsg() {
    return api('GET', '/api/coupons/message?channel=' + state.cp.msgChannel).then(function (r) { state.cp.msg = r; });
  }
  /** Linha editável de um cupom lido da mensagem (ou novo). */
  function cpRow(c, i) {
    var num = function (v) { return v == null ? '' : String(v).replace('.', ','); };
    return '<div class="cprow">' +
      '<label class="check"><input type="checkbox" data-cpsel="' + i + '"' + (c._skip ? '' : ' checked') + ' aria-label="Salvar este cupom"></label>' +
      '<input type="text" data-cpf="code" data-cpi="' + i + '" value="' + esc(c.code) + '" aria-label="Código" class="cpcode">' +
      '<select data-cpf="kind" data-cpi="' + i + '" aria-label="Tipo"><option value="percent"' + (c.kind !== 'value' ? ' selected' : '') + '>%</option><option value="value"' + (c.kind === 'value' ? ' selected' : '') + '>R$</option></select>' +
      '<input type="text" inputmode="decimal" data-cpf="amount" data-cpi="' + i + '" value="' + esc(num(c.amount)) + '" aria-label="Desconto" placeholder="desconto">' +
      '<input type="text" inputmode="decimal" data-cpf="min_purchase" data-cpi="' + i + '" value="' + esc(num(c.min_purchase)) + '" aria-label="Compra mínima (R$)" placeholder="mínimo R$">' +
      '<input type="text" inputmode="decimal" data-cpf="max_discount" data-cpi="' + i + '" value="' + esc(num(c.max_discount)) + '" aria-label="Limite (R$)" placeholder="limite R$">' +
      '<input type="date" data-cpf="expires_on" data-cpi="' + i + '" value="' + esc(c.expires_on || '') + '" aria-label="Validade"></div>';
  }
  function viewCupons() {
    var cp = state.cp;
    if (!cp.loaded) { loadCoupons().then(render).catch(function (e) { toast(e.message); }); return '<p class="hint">Carregando cupons…</p>'; }
    var tg = state.tg || {};
    var parsed = cp.parsed;
    var paste = '<section class="card"><h3>📋 Colar cupons</h3>' +
      '<p class="hint">Cole uma mensagem com cupons (de um grupo, e-mail do Mercado Livre ou o que você copiou do app). O Garimpo lê os códigos, o desconto, a compra mínima e o limite. <b>Confira no app da loja se o cupom está valendo</b> antes de salvar.</p>' +
      '<div class="row"><select id="cp-mk" aria-label="Loja"><option value="ML"' + (cp.mk === 'ML' ? ' selected' : '') + '>Mercado Livre</option><option value="SH"' + (cp.mk === 'SH' ? ' selected' : '') + '>Shopee</option></select></div>' +
      '<textarea id="cp-text" rows="5" placeholder="Ex.: 🎟️ CUPOMON — 30% em R$1, limite R$500">' + esc(cp.text || '') + '</textarea>' +
      '<div class="row end"><button class="btn small" data-act="cp-new">+ Cupom em branco</button><button class="btn small primary" data-act="cp-parse">Ler cupons</button></div>' +
      (parsed ? (parsed.length ? '<div class="cplist"><div class="cprow cphead"><span></span><span>Código</span><span>Tipo</span><span>Desconto</span><span>Mínimo R$</span><span>Limite R$</span><span>Validade</span></div>' + parsed.map(cpRow).join('') + '</div>' +
        '<div class="field"><label for="cp-link">Seu link de afiliado para ativar os cupons</label><input id="cp-link" type="url" value="' + esc(cp.link || '') + '" placeholder="https://mercadolivre.com/sec/... (gere no seu painel de Afiliados)">' +
        '<p class="hint">Gere o link no seu painel de Afiliados (de preferência da página de cupons ou de ofertas da loja). O link de quem mandou a mensagem <b>não</b> é aproveitado: a comissão seria dela.</p></div>' +
        '<div class="row end"><button class="btn small" data-act="cp-cancel">Cancelar</button><button class="btn small primary" data-act="cp-save">Salvar cupons marcados</button></div>'
        : '<p class="err">Não encontrei cupons nessa mensagem. Use "+ Cupom em branco" para cadastrar à mão.</p>') : '') + '</section>';

    var rows = cp.items.map(function (c) {
      var st = CP_STATUS[c.status] || CP_STATUS.valido;
      return '<div class="cpitem' + (c.status === 'vencido' || c.status === 'pausado' ? ' off' : '') + '"><div class="grow"><div class="row" style="gap:8px"><b class="num">' + esc(c.code) + '</b>' + mktTag(c.marketplace) + '<span class="pill ' + st[1] + '">' + st[0] + '</span></div>' +
        '<div class="hint">' + esc(cpDesc(c)) + (c.expires_on ? ' · até ' + esc(c.expires_on.split('-').reverse().join('/')) : '') + (c.link ? '' : ' · <span class="err">sem link</span>') + '</div></div>' +
        '<div class="row"><button class="btn small ghost" data-cpedit="' + c.id + '">Editar</button>' +
        '<button class="btn small ghost" data-cptoggle="' + c.id + '">' + (c.active ? 'Pausar' : 'Ativar') + '</button>' +
        '<button class="btn small ghost danger" data-cpdel="' + c.id + '">Excluir</button></div></div>';
    }).join('');
    var expired = cp.items.filter(function (c) { return c.status === 'vencido'; }).length;
    var list = '<section class="card"><h3>🎟️ Seus cupons</h3>' + (rows ? '<div class="cpitems">' + rows + '</div>' : '<p class="hint">Nenhum cupom ainda. Cole uma mensagem acima ou cadastre em branco.</p>') +
      (expired ? '<div class="row end"><button class="btn small ghost" data-act="cp-clean">Apagar ' + expired + ' vencido' + (expired > 1 ? 's' : '') + '</button></div>' : '') +
      '<p class="hint">Cupons válidos também entram sozinhos no texto das ofertas da mesma loja quando o produto atende a compra mínima ("🎟️ Cupom X: …").</p></section>';

    var m = cp.msg || {};
    var msgCard = '<section class="card"><h3>📣 Mensagem dos cupons de hoje</h3>' +
      '<div class="seg" role="group" aria-label="Canal"><button type="button" data-cpch="whatsapp" aria-pressed="' + (cp.msgChannel === 'whatsapp') + '">WhatsApp / Telegram</button><button type="button" data-cpch="instagram" aria-pressed="' + (cp.msgChannel === 'instagram') + '">Instagram</button></div>' +
      (m.text ? '<textarea id="cp-msg" rows="10" readonly>' + esc(m.text) + '</textarea>' +
        (m.missing_link ? '<p class="err small">Algum cupom está sem o seu link: edite e cole o link de afiliado.</p>' : '') +
        '<div class="row end"><button class="btn small" data-act="cp-copy">Copiar</button>' +
        (cp.msgChannel === 'whatsapp' ? '<button class="btn small" data-act="cp-wa">Abrir no WhatsApp</button>' +
          '<button class="btn small primary" data-act="cp-tg"' + (tg.ready ? '' : ' disabled title="Conecte o Telegram em Conexões"') + '>Enviar no Telegram</button>' : '') + '</div>'
        : '<p class="hint">Nenhum cupom válido hoje.</p>') + '</section>';

    var s = cp.settings || { auto: false, time: '09:00', channels: { telegram: true, whatsapp: true } };
    var auto = '<section class="card"><h3>🤖 Postar os cupons todo dia</h3>' +
      '<form id="cp-auto" class="stack"><label class="check"><input type="checkbox" name="auto"' + (s.auto ? ' checked' : '') + '> Ligado</label>' +
      '<div class="row"><label for="cp-time">Horário</label><input id="cp-time" name="time" type="time" value="' + esc(s.time) + '" style="max-width:130px"></div>' +
      '<label class="check"><input type="checkbox" name="telegram"' + (s.channels.telegram ? ' checked' : '') + '> Telegram (posta sozinho)' + (tg.ready ? '' : ' <span class="hint">· conecte em Conexões</span>') + '</label>' +
      '<label class="check"><input type="checkbox" name="whatsapp"' + (s.channels.whatsapp ? ' checked' : '') + '> WhatsApp (fica pronto na Fila para você enviar)</label>' +
      '<p class="hint">Uma vez por dia, no horário escolhido (Brasília), só com os cupons válidos. Sem cupom válido, não posta nada.</p>' +
      '<div class="row end"><button class="btn small primary" type="submit">Salvar</button></div></form></section>';
    return '<div class="cupons">' + paste + list + msgCard + auto + '</div>';
  }
  function cpEditDialog(c) {
    var num = function (v) { return v == null ? '' : String(v).replace('.', ','); };
    var inner = field('code', 'Código', c.code, 'required') +
      '<div class="cols"><div class="field"><label for="kind">Tipo</label><select id="kind" name="kind"><option value="percent"' + (c.kind !== 'value' ? ' selected' : '') + '>% de desconto</option><option value="value"' + (c.kind === 'value' ? ' selected' : '') + '>R$ de desconto</option></select></div>' +
      field('amount', 'Desconto', num(c.amount), 'inputmode="decimal" required') + '</div>' +
      '<div class="cols">' + field('min_purchase', 'Compra mínima (R$)', num(c.min_purchase), 'inputmode="decimal" placeholder="sem mínimo"') + field('max_discount', 'Limite do desconto (R$)', num(c.max_discount), 'inputmode="decimal" placeholder="sem limite"') + '</div>' +
      '<div class="field"><label for="expires_on">Validade (último dia)</label><input id="expires_on" name="expires_on" type="date" value="' + esc(c.expires_on || '') + '"></div>' +
      field('link', 'Seu link de afiliado para ativar', c.link, 'inputmode="url" placeholder="https://mercadolivre.com/sec/..."') +
      field('notes', 'Observação (só para você)', c.notes, 'maxlength="200"');
    openDialog('Editar cupom', inner, 'Salvar', function (d) {
      return api('PATCH', '/api/coupons/' + c.id, d).then(function () { toast('Cupom salvo'); return loadCoupons().then(render); });
    });
  }

  /* ---------- Shopee pela API de afiliados: lojas, ofertas e gerador de link ---------- */
  function shSeg() {
    var v = state.g.shview || 'produtos';
    return '<div class="seg wrapseg" role="group" aria-label="Shopee" style="margin:10px 0">' + [['produtos', '🔎 Produtos'], ['lojas', '🏬 Lojas'], ['ofertas', '🎁 Ofertas Shopee'], ['link', '🔗 Gerar link']].map(function (o) {
      return '<button type="button" data-shview="' + o[0] + '" aria-pressed="' + (v === o[0]) + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function loadShShops() {
    var g = state.g;
    return api('GET', '/api/garimpo/shopee/shops?type=' + g.shopsType + '&sort=' + g.shopsSort + '&q=' + encodeURIComponent(g.shopsQ || '')).then(function (r) { g.shops = r.items; });
  }
  function shShops() {
    var g = state.g;
    if (!g.shops) { loadShShops().then(render).catch(function (e) { g.shops = []; toast(e.message); render(); }); return '<p class="hint">Carregando lojas…</p>'; }
    var types = [['todas', 'Todas'], ['oficial', 'Lojas oficiais'], ['indicada', 'Indicadas']].map(function (o) {
      return '<button type="button" data-shtype="' + o[0] + '" aria-pressed="' + (g.shopsType === o[0]) + '">' + o[1] + '</button>';
    }).join('');
    var cards = g.shops.map(function (s) {
      return '<article class="prow shop">' + (safeUrl(s.image_url) ? '<div class="thumb sm"><img src="' + esc(safeUrl(s.image_url)) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></div>' : '<div class="thumb sm"></div>') +
        '<div class="pinfo"><h3>' + esc(s.name) + '</h3><div class="meta">' + s.labels.map(function (l) { return '<span class="tag off">' + esc(l) + '</span>'; }).join('') +
        (s.rating ? '<span>★ ' + String(s.rating).replace('.', ',') + '</span>' : '') + '</div>' +
        '<div class="pline"><span class="earn num">' + String(s.commission_pct).replace('.', ',') + '% de comissão</span></div></div>' +
        '<div class="pact"><button class="btn small primary" data-shopprod="' + esc(s.shop_id) + '" data-shopname="' + esc(s.name) + '">Ver produtos</button>' +
        (s.link ? '<button class="btn small ghost" data-copylink="' + esc(s.link) + '">Copiar link da loja</button>' : '') + '</div></article>';
    }).join('');
    return '<form id="sh-shops-form" class="row"><input id="sh-shops-q" type="search" class="grow" placeholder="Buscar loja (ex.: boticário, decoração)" value="' + esc(g.shopsQ || '') + '"><button class="btn" type="submit">Buscar</button></form>' +
      '<div class="filters" style="padding:8px 0"><div class="seg" role="group">' + types + '</div>' +
      selectEl('sh-sort', 'sort', 'Ordenar lojas', [['comissao', 'Maior comissão'], ['populares', 'Mais populares'], ['recentes', 'Mais recentes']], g.shopsSort) + '</div>' +
      '<p class="hint">Comissão da loja = vale para os produtos dela no período da campanha. Lojas oficiais costumam ser as mais confiáveis para a Linha Premium.</p>' +
      (cards ? '<div class="prodlist">' + cards + '</div>' : '<div class="empty centered-empty">Nenhuma loja encontrada.</div>');
  }
  function shCamps() {
    var g = state.g;
    if (!g.camps) { api('GET', '/api/garimpo/shopee/campaigns').then(function (r) { g.camps = r.items; render(); }).catch(function (e) { g.camps = []; toast(e.message); render(); }); return '<p class="hint">Carregando ofertas…</p>'; }
    var cards = g.camps.map(function (c) {
      return '<article class="prow shop">' + (safeUrl(c.image_url) ? '<div class="thumb sm"><img src="' + esc(safeUrl(c.image_url)) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></div>' : '<div class="thumb sm"></div>') +
        '<div class="pinfo"><h3>' + esc(c.name) + '</h3><div class="pline"><span class="earn num">' + String(c.commission_pct).replace('.', ',') + '% de comissão</span>' +
        (c.ends_at ? '<span class="hint">até ' + esc(new Date(c.ends_at).toLocaleDateString('pt-BR')) + '</span>' : '') + '</div></div>' +
        '<div class="pact">' + (c.link ? '<button class="btn small primary" data-copylink="' + esc(c.link) + '">Copiar link</button><button class="btn small ghost" data-walink="' + esc(c.link) + '" data-waname="' + esc(c.name) + '">WhatsApp</button>' : '') + '</div></article>';
    }).join('');
    return '<p class="hint">Campanhas da própria Shopee por categoria ou evento. O link já é o seu (de afiliado) e leva para a página da campanha: bom para posts do tipo "Ofertas de Beleza de hoje".</p>' +
      (cards ? '<div class="prodlist">' + cards + '</div>' : '<div class="empty centered-empty">Nenhuma oferta disponível agora.</div>');
  }
  function shLink() {
    var g = state.g;
    return '<form id="sh-link-form" class="card stack"><h3>🔗 Gerar o seu link de afiliado</h3>' +
      '<p class="hint">Cole qualquer link da Shopee (produto, loja, categoria, campanha). O Garimpo gera o seu link s.shopee.com.br, que conta a venda para você.</p>' +
      '<input id="sh-link-url" type="url" placeholder="https://shopee.com.br/..." required>' +
      '<div class="field"><label for="sh-link-sub">Canal (Sub_id, para ver no relatório da Shopee de onde veio a venda)</label><select id="sh-link-sub">' +
      [['instagram', 'Instagram'], ['whatsapp', 'WhatsApp'], ['telegram', 'Telegram'], ['garimpo', 'Outro']].map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="row end"><button class="btn primary" type="submit">Gerar link</button></div>' +
      (g.linkOut ? '<div class="linkout"><input type="text" readonly value="' + esc(g.linkOut) + '"><button type="button" class="btn small primary" data-copylink="' + esc(g.linkOut) + '">Copiar</button></div>' : '') + '</form>';
  }

  function viewGarimpar() {
    var g = state.g;
    var ready = mktReady(g.mkt);
    var switcher = '<div class="seg gview" role="group" aria-label="O que garimpar"><button type="button" data-gview="produtos" aria-pressed="' + (state.gview !== 'cupons') + '">🔎 Produtos</button>' +
      '<button type="button" data-gview="cupons" aria-pressed="' + (state.gview === 'cupons') + '">🎟️ Cupons</button></div>';
    if (state.gview === 'cupons') {
      return '<div class="pagehead"><h2>Garimpar</h2><p>Cupons das lojas: cole, confira e o Garimpo monta e posta as mensagens.</p></div>' + switcher + viewCupons();
    }
    var chips = [['ML', 'Mercado Livre'], ['SH', 'Shopee']].map(function (m) {
      return '<button type="button" class="chip" data-gmkt="' + m[0] + '" aria-pressed="' + (g.mkt === m[0]) + '">' + m[1] + (m[0] === 'ML' && !mktReady('ML') ? ' · desconectado' : '') + '</button>';
    }).join('');
    var form = '<form class="card" id="g-form"><div class="filters" style="padding:0">' + chips + '</div>' +
      (g.mkt === 'SH' && ready ? shSeg() : '') +
      (ready && !(g.mkt === 'SH' && g.shview !== 'produtos') ? '<div class="row"><input id="g-q" name="q" type="search" class="grow gq" placeholder="O que você quer garimpar? Ex.: air fryer, fone bluetooth" value="' + esc(g.q) + '"' + (g.mkt === 'SH' ? '' : ' required minlength="2"') + ' aria-label="Busca">' +
        '<button class="btn primary" type="submit"' + (!g.busy ? '' : ' disabled') + '>' + (g.busy ? 'Garimpando…' : 'Garimpar agora') + '</button></div>' +
        '<div class="filters" style="padding:0">' +
        selectEl('g-desc', 'minDesc', 'Desconto mínimo', [[0, 'Qualquer desconto'], [10, 'Desconto de 10%+'], [20, 'Desconto de 20%+'], [30, 'Desconto de 30%+'], [50, 'Desconto de 50%+']], g.minDesc) +
        (g.mkt === 'SH' ? selectEl('g-com', 'minCom', 'Comissão mínima', [[0, 'Qualquer comissão'], [5, 'Comissão de 5%+'], [8, 'Comissão de 8%+'], [10, 'Comissão de 10%+'], [15, 'Comissão de 15%+']], g.minCom) +
          selectEl('g-rat', 'minRat', 'Avaliação mínima', [[0, 'Qualquer avaliação'], [4, '★ 4,0+'], [4.5, '★ 4,5+'], [4.8, '★ 4,8+']], g.minRat) :
          selectEl('g-ship', 'ship', 'Frete', SHIP_OPTS, g.ship)) + '</div>' +
        (g.mkt === 'SH' ? '<div class="filters" style="padding:0"><label class="check"><input type="checkbox" id="g-ams"' + (g.ams ? ' checked' : '') + '> 💰 Só com comissão extra da loja</label>' +
          '<label class="check"><input type="checkbox" id="g-key"' + (g.keySeller ? ' checked' : '') + '> ⭐ Vendedores-chave</label>' +
          '<button type="button" class="btn small" data-act="sh-top">🔥 Melhor desempenho agora</button>' +
          (g.shopId ? '<span class="chip small" aria-pressed="true">Loja: ' + esc(g.shopName || g.shopId) + ' <button type="button" class="link" data-act="sh-shop-clear" aria-label="Tirar filtro de loja">✕</button></span>' : '') + '</div>' +
          '<p class="hint">Dá para garimpar sem digitar: marque um filtro e toque em Garimpar, ou use "Melhor desempenho".</p>' : '') : '') +
      (g.mkt === 'ML' && ready ? mlExplore(g) : '') + '</form>';

    var head = '<div class="pagehead"><h2>Garimpar</h2><p>Encontre os produtos que mais vendem e que mais pagam comissão, compare e salve os melhores.</p></div>';
    var pre = '';
    if (g.mkt === 'SH' && ready && g.shview && g.shview !== 'produtos') {
      return head + switcher + form + (g.shview === 'lojas' ? shShops() : g.shview === 'ofertas' ? shCamps() : shLink());
    }
    if (g.mkt === 'SH') { if (!ready) pre = shopeeSheetCard(false); }
    else if (!ready) {
      return head + switcher + form + '<div class="empty centered-empty" style="margin-top:12px">Para garimpar no Mercado Livre, conecte a sua conta primeiro.<div class="row" style="justify-content:center;margin-top:10px"><button class="btn primary" data-tab="conexoes">Ir para Conexões</button></div></div>';
    } else if (mlComMissing()) {
      pre = '<div class="rule warnbox"><b>Sem a comissão, não dá para saber quanto você ganha.</b> O Mercado Livre não informa a comissão de afiliado pela API. ' +
        'Veja os percentuais no seu painel de Afiliados do Mercado Livre e preencha direto nos produtos abaixo (campo "Comissão em…", vale para a categoria inteira) ou de uma vez em <button type="button" class="link" data-tab="conexoes">Conexões → Comissão por categoria</button>.</div>';
    }

    var list = gView();
    var hl = gHighlights(list);
    var nsel = Object.keys(g.sel).filter(function (k) { return g.sel[k]; }).length;
    var cards = list.map(function (x) {
      var p = x.p, i = x.i;
      var picked = Boolean(g.sel[i]);
      var tags = (hl.tags[i] || []).map(function (t) { return '<span class="tag hl">' + t + '</span>'; }).join('');
      return '<article class="card' + (picked ? ' picked' : '') + '" id="gres-' + i + '">' + thumb(p) +
        '<div class="prod"><div><h3>' + esc(p.title) + '</h3><div class="meta">' + mktTag(p.marketplace) + (p.shop ? '<span>' + esc(p.shop) + '</span>' : '') + (p.category ? '<span>' + esc(p.category) + '</span>' : '') + '</div></div>' +
        '<div class="score" title="Nota de prioridade: desconto, comissão, avaliação e vendas"><div><b class="num">' + p.score + '</b><small>nota</small></div></div></div>' +
        (tags ? '<div class="badges">' + tags + '</div>' : '') + badges(p) + priceBlock(p) + shipInfo(p) + statsBlock(p) + setComInline(p) +
        (p.marketplace === 'ML' && !p.affiliate_url && !p.saved_id ? '<p class="hint small">Depois de salvar, gere o seu link no portal de Afiliados e cole no produto (Editar).</p>' : '') +
        '<div class="row">' + (p.saved_id ? '<span class="pill posted">Já salvo</span>' : '<label class="pick"><input type="checkbox" data-gpick="' + i + '"' + (picked ? ' checked' : '') + '> Selecionar</label>') +
        '<span class="grow"></span>' + (p.product_url ? '<a class="btn small ghost" href="' + esc(safeUrl(p.product_url)) + '" target="_blank" rel="noopener noreferrer">Ver na loja</a>' : '') + '</div></article>';
    }).join('');

    var summary = '';
    if (g.results.length) {
      var item = function (label, x, val) {
        return x ? '<button type="button" class="sumit" data-gfocus="' + x.i + '"><span>' + label + '</span><b class="num">' + esc(val) + '</b><small>' + esc(x.p.title.slice(0, 60)) + '</small></button>' : '';
      };
      var withCom = g.results.filter(function (p) { return p.commission_pct != null; }).length;
      summary = '<div class="gsum">' +
        item('🏆 Maior ganho por venda', hl.earn, hl.earn ? brl(hl.earn.p.earn_per_sale) : '') +
        item('🔥 Mais vendido', hl.sold, hl.sold ? (hl.sold.p.best_seller_rank ? hl.sold.p.best_seller_rank + 'º no ranking' : fmtSales(hl.sold.p.sales_k)) : '') +
        item('💥 Maior desconto', hl.off, hl.off ? '−' + hl.off.p.desc + '%' : '') + '</div>' +
        '<div class="filters gtools">' + selectEl('g-sort', 'sort', 'Ordenar por', G_SORTS, g.sort) +
        '<label class="check"><input type="checkbox" id="g-onlycom"' + (g.onlyCom ? ' checked' : '') + '> Só com comissão (' + withCom + ' de ' + g.results.length + ')</label>' +
        '<label class="check"><input type="checkbox" id="g-official"' + (g.official ? ' checked' : '') + '> 💎 Só lojas oficiais (' + g.results.filter(isOfficialP).length + ')</label>' +
        '<label class="check">Preço a partir de R$ <input type="text" inputmode="decimal" id="g-pmin" value="' + (g.priceMin ? String(g.priceMin).replace('.', ',') : '') + '" placeholder="qualquer" style="width:90px"></label></div>';
    }
    var results = list.length ? '<div class="grid three" style="margin-top:12px">' + cards + '</div>' :
      (g.results.length ? '<div class="empty centered-empty" style="margin-top:12px">Nenhum resultado com esses filtros. Desmarque algum filtro (comissão, lojas oficiais, preço) ou preencha a comissão.</div>' :
        (g.done && !g.busy ? '<div class="empty centered-empty" style="margin-top:12px">Nada encontrado com esses filtros. Tente outra palavra ou afrouxe os filtros.</div>' : ''));
    var bar = g.results.length ? '<div class="gbar"><span class="hint">' + list.length + ' resultados · ' + nsel + ' selecionados</span><span class="grow"></span>' +
      '<button class="btn small" data-act="g-all">Selecionar todos</button>' +
      (g.more ? '<button class="btn small" data-act="g-more"' + (g.busy ? ' disabled' : '') + '>Carregar mais</button>' : '') +
      '<button class="btn small primary" data-act="g-save"' + (nsel ? '' : ' disabled') + '>Salvar selecionados (' + nsel + ')</button></div>' : '';
    return head + switcher + form + pre + summary + results + bar;
  }

  /** Atalhos do Mercado Livre: o que está em alta nas buscas e os mais vendidos de uma categoria. */
  function mlExplore(g) {
    var trends = (g.trends || []).slice(0, 14).map(function (k) {
      return '<button type="button" class="chip small" data-trend="' + esc(k) + '">' + esc(k) + '</button>';
    }).join('');
    var cats = g.cats ? selectEl('g-cat', 'category', 'Mais vendidos por categoria', [['', 'Ou veja os mais vendidos de uma categoria…']].concat(g.cats.map(function (c) { return [c.id, c.name]; })), g.category) : '';
    return (trends ? '<div class="trends"><span class="hint">🔥 Em alta no Mercado Livre:</span>' + trends + '</div>' : '') + (cats ? '<div class="filters" style="padding:0">' + cats + '</div>' : '');
  }

  function garimpar(page) {
    var g = state.g;
    g.busy = true; render();
    return api('POST', '/api/garimpo/search', {
      marketplace: g.mkt, q: g.q, category: g.mkt === 'ML' && g.category ? g.category : undefined, page: page, sort: g.sort,
      min_discount: g.minDesc, min_commission: g.mkt === 'SH' ? g.minCom : 0, min_rating: g.mkt === 'SH' ? g.minRat : 0,
      shipping: g.mkt === 'ML' ? g.ship : '',
      ams: g.mkt === 'SH' && g.ams, key_seller: g.mkt === 'SH' && g.keySeller, top: g.mkt === 'SH' && g.top, shop_id: g.mkt === 'SH' ? g.shopId : null,
    }).then(function (r) {
      if (page === 1) { g.results = r.items; g.sel = {}; } else g.results = g.results.concat(r.items);
      g.page = r.page; g.more = r.has_more; g.done = true;
    }).finally(function () { g.busy = false; render(); });
  }

  /** Produtos marcados com "Juntar", na ordem da lista. */
  function groupSelected() { return state.products.filter(function (p) { return state.psel[p.id]; }); }
  function groupBar() {
    var n = groupSelected().length;
    if (!n) return '';
    return '<div class="gbar"><span class="hint">' + n + ' selecionado' + (n > 1 ? 's' : '') + (n === 1 ? ' · marque mais um para juntar' : '') + '</span><span class="grow"></span>' +
      '<button class="btn small" data-act="psel-clear">Limpar</button>' +
      '<button class="btn small primary" data-act="psel-post"' + (n < 2 ? ' disabled' : '') + '>Postar ' + n + ' juntos</button></div>';
  }

  /* ---------- Produtos: ordem fixa, busca, lista compacta e páginas ---------- */
  var P_PAGE = 24;
  var P_SORTS = [['recentes', 'Mais recentes primeiro'], ['antigos', 'Mais antigos primeiro'], ['nome', 'Nome (A–Z)'], ['score', 'Maior nota'], ['ganho', 'Maior ganho por venda'],
    ['comissao', 'Maior comissão'], ['desc', 'Maior desconto'], ['vendidos', 'Mais vendidos'], ['preco', 'Menor preço']];
  // Toda ordem desempata pelo mais recente: a lista nunca "embaralha" entre uma visita e outra.
  var P_SORTERS = {
    recentes: function () { return 0; },
    antigos: function (a, b) { return a.id - b.id; },
    nome: function (a, b) { return String(a.title).localeCompare(String(b.title), 'pt-BR', { sensitivity: 'base' }); },
    score: function (a, b) { return b.score - a.score; },
    ganho: function (a, b) { return (b.earn_per_sale || 0) - (a.earn_per_sale || 0); },
    comissao: function (a, b) { return (b.commission_pct || 0) - (a.commission_pct || 0); },
    desc: function (a, b) { return (b.desc || 0) - (a.desc || 0); },
    vendidos: function (a, b) { return (a.best_seller_rank || 1e9) - (b.best_seller_rank || 1e9) || (b.sales_k || 0) - (a.sales_k || 0); },
    preco: function (a, b) { return a.price - b.price; },
  };
  var P_FLAGS = [['', 'Todos os produtos'], ['semlink', 'Sem link de afiliado'], ['semcom', 'Sem comissão'], ['comlink', 'Prontos (com link)']];

  /** Preferências da tela de produtos guardadas neste aparelho. */
  function prefGet(k, def) { try { var v = localStorage.getItem('garimpo.' + k); return v === null ? def : v; } catch (_) { return def; } }
  function prefSet(k, v) { try { localStorage.setItem('garimpo.' + k, v); } catch (_) { /* sem armazenamento: só não lembra */ } }

  function productsFiltered() {
    var q = normTxt(state.pq);
    var list = state.products.filter(function (p) {
      if (state.mkt !== 'todos' && p.marketplace !== state.mkt) return false;
      if (state.cat !== 'todas' && p.category !== state.cat) return false;
      if ((p.commission_pct || 0) < state.comMin) return false;
      if (!shipFilterOk(p, state.shipFilter)) return false;
      if (state.pflag === 'semlink' && p.affiliate_url) return false;
      if (state.pflag === 'comlink' && !p.affiliate_url) return false;
      if (state.pflag === 'semcom' && p.commission_pct != null) return false;
      return !q || normTxt(p.title + ' ' + (p.category || '')).indexOf(q) > -1;
    });
    var s = P_SORTERS[state.ordem] || P_SORTERS.recentes;
    return list.sort(function (a, b) { return s(a, b) || b.id - a.id; });
  }
  function normTxt(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }

  /** Card completo (o de sempre). */
  function productCard(p, compactOpen) {
    return '<article class="card' + (compactOpen ? ' pexpanded' : '') + '" id="prod-' + p.id + '">' + thumb(p) +
      '<div class="prod"><div><h3>' + esc(p.title) + '</h3><div class="meta">' + mktTag(p.marketplace) + (p.category ? '<span>' + esc(p.category) + '</span>' : '') + '</div></div>' +
      '<div class="score" title="Nota de prioridade"><div><b class="num">' + p.score + '</b><small>nota</small></div></div></div>' +
      badges(p) + priceBlock(p) + shipInfo(p) + priceTrend(p) + statsBlock(p) +
      '<p class="hint' + (staleHours(p) > 24 ? ' stale' : '') + '">Preço conferido ' + ago(p.price_checked_at) +
      (p.price_stats && p.price_stats.count > 1 ? ' · <button class="link" data-history="' + p.id + '">Histórico</button>' : '') +
      (p.external_id && mktReady(p.marketplace) ? ' · <button class="link" data-refresh="' + p.id + '">Atualizar preço</button>' : '') + '</p>' +
      (p.affiliate_url ? '' : '<p class="err small">Sem link de afiliado: o post vai sem o seu link. Use Editar para colar.</p>') +
      '<div class="row"><button class="btn small primary" data-post="' + p.id + '">Postar agora</button>' +
      '<label class="pick" title="Marque vários para postar juntos num carrossel"><input type="checkbox" data-psel="' + p.id + '"' + (state.psel[p.id] ? ' checked' : '') + '> Juntar</label><span class="grow"></span>' +
      (p.product_url ? '<a class="btn small ghost" href="' + esc(safeUrl(p.product_url)) + '" target="_blank" rel="noopener noreferrer">Abrir</a>' : '') +
      '<button class="btn small ghost" data-edit-product="' + p.id + '">Editar</button></div>' +
      '<div class="row later"><span class="hint">Guardar para depois:</span><button class="btn small ghost" data-add="' + p.id + '" data-channel="instagram">Fila Instagram</button><button class="btn small ghost" data-add="' + p.id + '" data-channel="whatsapp">Fila WhatsApp</button></div>' +
      (compactOpen ? '<div class="row end"><button class="btn small ghost" data-pexp="' + p.id + '">Fechar detalhes ▲</button></div>' : '') + '</article>';
  }

  /** Linha compacta: foto pequena, nome, preço, ganho e ações principais. */
  function productRow(p) {
    var com = p.commission_pct != null;
    return '<article class="prow" id="prod-' + p.id + '">' + thumb(p, true) +
      '<div class="pinfo"><h3 title="' + esc(p.title) + '">' + esc(p.title) + '</h3>' +
      '<div class="meta">' + mktTag(p.marketplace) + (p.category ? '<span>' + esc(p.category) + '</span>' : '') + '</div>' +
      '<div class="pline"><b class="num">' + (p.price_max > p.price ? 'a partir de ' : '') + brl(p.price) + '</b>' + (p.desc ? '<span class="off num">−' + p.desc + '%</span>' : '') +
      '<span class="' + (com ? 'earn' : 'hint') + ' num">' + (com ? p.commission_pct + '% · ' + brl(p.earn_per_sale) + '/venda' : 'sem comissão') + '</span>' +
      (p.affiliate_url ? '' : '<span class="err small">sem link</span>') + '</div></div>' +
      '<div class="pact"><button class="btn small primary" data-post="' + p.id + '">Postar</button>' +
      '<label class="pick" title="Juntar num carrossel"><input type="checkbox" data-psel="' + p.id + '"' + (state.psel[p.id] ? ' checked' : '') + ' aria-label="Juntar"> Juntar</label>' +
      '<button class="btn small ghost" data-pexp="' + p.id + '" aria-label="Ver detalhes">Detalhes ▾</button></div></article>';
  }

  /** Lista (filtrada, ordenada e paginada). Separada da tela para a busca redesenhar só ela (sem perder o foco). */
  function productsList() {
    var list = productsFiltered();
    var shown = list.slice(0, state.plimit);
    var compact = state.pview === 'lista';
    var body = shown.map(function (p) { return compact && !state.pexp[p.id] ? productRow(p) : productCard(p, compact); }).join('');
    var count = '<p class="hint pcount">' + (list.length === state.products.length ? list.length + ' produto' + (list.length === 1 ? '' : 's') : list.length + ' de ' + state.products.length + ' produtos') +
      (shown.length < list.length ? ' · mostrando ' + shown.length : '') + '</p>';
    if (!list.length) {
      return '<div class="empty centered-empty">' + (state.products.length ? 'Nenhum produto com esses filtros' + (state.pq ? ' e essa busca' : '') + '.' : 'Nenhum produto ainda. Use a aba Garimpar, Cadastrar por links ou importe um CSV.') + '</div>';
    }
    return count + '<div class="' + (compact ? 'prodlist' : 'grid three') + '">' + body + '</div>' +
      (shown.length < list.length ? '<div class="row" style="justify-content:center;margin-top:12px"><button class="btn" data-act="p-more">Mostrar mais ' + Math.min(P_PAGE, list.length - shown.length) + '</button><button class="btn ghost" data-act="p-all">Mostrar todos (' + list.length + ')</button></div>' : '');
  }

  function viewDescobrir() {
    var cats = ['todas'].concat(Array.from(new Set(state.products.map(function (p) { return p.category; }).filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); }));
    var chips = [['todos', 'Todos'], ['ML', 'Mercado Livre'], ['SH', 'Shopee']].map(function (m) {
      return '<button class="chip" data-mkt="' + m[0] + '" aria-pressed="' + (state.mkt === m[0]) + '">' + m[1] + '</button>';
    }).join('');
    function sel(id, label, opts, cur) {
      return '<select id="' + id + '" aria-label="' + label + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    }
    var noLink = state.products.filter(function (p) { return !p.affiliate_url; }).length;
    var views = '<div class="seg" role="group" aria-label="Modo de exibição"><button type="button" data-pview="lista" aria-pressed="' + (state.pview === 'lista') + '">☰ Lista</button><button type="button" data-pview="cards" aria-pressed="' + (state.pview !== 'lista') + '">▦ Cards</button></div>';
    return '<div class="pagehead"><h2>Produtos</h2><p>Seus produtos salvos. Os novos aparecem no topo; mude a ordem quando quiser.</p></div>' +
      '<div class="toolbar"><button class="btn primary" data-act="links-open">Cadastrar por links</button><button class="btn" data-act="new-product">Novo produto</button><button class="btn" data-act="import-products">Importar CSV</button>' +
      (state.products.some(function (p) { return p.external_id && mktReady(p.marketplace); }) ? '<button class="btn" data-act="refresh-all">Atualizar todos os preços</button>' : '') + '</div>' +
      '<div class="psearch"><input id="f-q" type="search" placeholder="Buscar nos seus produtos…" value="' + esc(state.pq) + '" aria-label="Buscar produtos" autocomplete="off">' + views + '</div>' +
      '<div class="filters">' + chips + '<span class="sep"></span>' +
      sel('f-ord', 'Ordenar por', P_SORTS, state.ordem) +
      sel('f-cat', 'Categoria', cats.map(function (c) { return [c, c === 'todas' ? 'Todas as categorias' : c]; }), state.cat) +
      sel('f-flag', 'Situação', P_FLAGS.map(function (f) { return [f[0], f[1] + (f[0] === 'semlink' && noLink ? ' (' + noLink + ')' : '')]; }), state.pflag) +
      sel('f-com', 'Comissão mínima', [[0, 'Qualquer comissão'], [8, 'A partir de 8%'], [10, 'A partir de 10%'], [12, 'A partir de 12%']], state.comMin) +
      sel('f-ship', 'Frete', SHIP_OPTS, state.shipFilter) + '</div>' +
      '<div id="plist">' + productsList() + '</div>' + groupBar();
  }

  var STATUS = { draft: 'Rascunho', scheduled: 'Agendado', publishing: 'Publicando', processing: 'Processando', posted: 'Postado', failed: 'Falhou' };

  function waPending(q) { return q.channel === 'whatsapp' && (q.status === 'draft' || q.status === 'failed'); }
  function viewFila() {
    var nWa = state.queue.filter(waPending).length;
    var nAuto = state.queue.filter(function (q) { return q.automation_id; }).length;
    var shown = state.queue.filter(function (q) {
      return state.qfilter === 'wa' ? waPending(q) : state.qfilter === 'piloto' ? Boolean(q.automation_id) : true;
    });
    var filters = '<div class="row chips" style="margin-bottom:12px">' + [['', 'Tudo'], ['wa', 'WhatsApp a enviar' + (nWa ? ' (' + nWa + ')' : '')], ['piloto', '🤖 Do piloto' + (nAuto ? ' (' + nAuto + ')' : '')]].map(function (f) {
      return '<button class="chip" data-qfilter="' + f[0] + '" aria-pressed="' + (state.qfilter === f[0]) + '">' + esc(f[1]) + '</button>';
    }).join('') + '</div>';
    var prefetch = 0;
    var items = shown.map(function (q) {
      var editable = q.status === 'draft' || q.status === 'scheduled' || q.status === 'failed';
      var isIg = q.channel === 'instagram';
      var media = '';
      var items = [];
      try { items = q.media_items ? JSON.parse(q.media_items) : []; } catch (_) { items = []; }
      if (isIg && q.media_type === 'carousel') {
        media = '<div class="gallery" aria-label="Carrossel">' + items.map(function (m, i) {
          var s = esc(safeUrl(m.url));
          return '<span class="gpic">' + (m.type === 'video' ? '<video src="' + s + '" muted playsinline preload="metadata"></video><span class="vtag">▶</span>' : '<img src="' + s + '" alt="" loading="lazy" referrerpolicy="no-referrer">') + '<span class="ord">' + (i + 1) + '</span></span>';
        }).join('') + '</div><p class="hint">Carrossel com ' + items.length + ' itens' + (editable ? ' · "Trocar mídia" transforma em post simples' : '') + '</p>' +
          (editable ? '<label class="btn small" for="up-' + q.id + '">Trocar mídia</label><input id="up-' + q.id + '" class="file-input" type="file" accept="image/jpeg,image/png,video/mp4" data-upload="' + q.id + '" hidden>' : '');
      } else if (isIg) {
        var u = safeUrl(q.media_url);
        media = '<div class="qmedia"><div class="thumb">' +
          (q.media_type === 'video' && u ? '<video src="' + esc(u) + '" muted playsinline preload="metadata"></video>' : (u ? '<img src="' + esc(u) + '" alt="" referrerpolicy="no-referrer">' : '<span class="hint" style="padding:8px">sem mídia</span>')) +
          '</div><div class="stack" style="display:flex;flex-direction:column;gap:6px"><span class="hint">' + (q.media_type === 'none' ? 'O Instagram exige foto (JPEG) ou vídeo.' : (q.media_type === 'video' ? 'Reels em vídeo' : 'Foto')) + '</span>' +
          (editable ? '<label class="btn small" for="up-' + q.id + '">Trocar mídia</label><input id="up-' + q.id + '" class="file-input" type="file" accept="image/jpeg,image/png,video/mp4" data-upload="' + q.id + '" hidden>' : '') + '</div></div>';
      } else if (safeUrl(q.product_image)) {
        // WhatsApp: a foto do produto vai junto ao compartilhar (preparada antes, porque o compartilhar precisa ser imediato)
        if (editable && prefetch++ < 6) prepareWaImage(q.product_image).catch(function () {});
        media = '<div class="qmedia"><div class="thumb"><img src="' + esc(safeUrl(q.product_image)) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></div><span class="hint">Foto que vai junto no WhatsApp</span></div>';
      }
      var nProd = 1;
      try { nProd = q.product_ids ? JSON.parse(q.product_ids).length : 1; } catch (_) { nProd = 1; }
      return '<article class="card qitem" data-q="' + q.id + '"><header><div><h3>' + (q.kind === 'coupons' ? '🎟️ Cupons do dia' : esc(q.product_title || 'Produto removido')) + (nProd > 1 ? ' <span class="hint">+ ' + (nProd - 1) + ' produto' + (nProd > 2 ? 's' : '') + '</span>' : '') + '</h3>' +
        '<div class="meta">' + (q.product_marketplace ? mktTag(q.product_marketplace) : '') + '<span>' + (isIg ? 'Instagram' : 'WhatsApp') + '</span>' + (q.automation_id ? '<span class="tag plain">🤖 Piloto</span>' : '') +
        (q.scheduled_at && q.status === 'scheduled' ? '<span class="num">· ' + fmtWhen(q.scheduled_at) + '</span>' : '') + '</div></div>' +
        '<span class="pill ' + q.status + '">' + STATUS[q.status] + '</span></header>' + media +
        '<textarea id="cap-' + q.id + '" data-caption="' + q.id + '" ' + (editable ? '' : 'readonly') + ' aria-label="Texto da postagem">' + esc(q.caption) + '</textarea>' +
        (isIg ? '<p class="hint"><span id="cnt-' + q.id + '">' + q.caption.length + '</span>/2200 caracteres</p>' : '') +
        (q.status === 'processing' ? '<p class="hint">O Instagram está processando o vídeo. Ele será publicado automaticamente quando ficar pronto.</p><div class="actions"><button class="btn small" data-check="' + q.id + '">Verificar agora</button></div>' : '') +
        (q.error ? '<p class="err">' + esc(q.error) + '</p>' : '') +
        (q.permalink ? '<p class="ok"><a href="' + esc(safeUrl(q.permalink)) + '" target="_blank" rel="noopener noreferrer">Ver no Instagram</a></p>' : '') +
        (editable ? '<div class="actions"><button class="btn small" data-save="' + q.id + '">Salvar texto</button><button class="btn small" data-regen="' + q.id + '">Refazer texto</button>' + (state.ai ? '<button class="btn small" data-regen="' + q.id + '" data-ai="1">Refazer com IA</button>' : '') + '</div>' : '') +
        (editable && isIg ? '<details class="sched"' + (q.status === 'scheduled' ? ' open' : '') + '><summary>Agendar (opcional)</summary><div class="row"><input type="datetime-local" id="when-' + q.id + '" value="' + localInput(q.scheduled_at) + '" aria-label="Data e hora"><button class="btn small" data-schedule="' + q.id + '">Agendar</button>' +
          (q.status === 'scheduled' ? '<button class="btn small ghost" data-unschedule="' + q.id + '">Tirar agendamento</button>' : '') + '</div></details>' : '') +
        '<div class="actions">' +
        (!isIg && editable && safeUrl(q.product_image) ? '<button class="btn small primary" data-washare="' + q.id + '">📷 Compartilhar com foto</button>' : '') +
        (!isIg && editable ? '<button class="btn small' + (safeUrl(q.product_image) ? '' : ' primary') + '" data-wa="' + q.id + '">' + (safeUrl(q.product_image) ? 'Só o texto' : 'Abrir no WhatsApp') + '</button>' : '') +
        '<button class="btn small" data-copy="' + q.id + '">Copiar texto</button>' +
        (editable && isIg ? '<button class="btn small primary" data-publish="' + q.id + '"' + (state.conn && state.conn.connected ? '' : ' disabled title="Conecte o Instagram na aba Conexões"') + '>Publicar agora</button>' : '') +
        (editable ? '<button class="btn small" data-posted="' + q.id + '">Marcar como postado</button>' : '') +
        (q.status === 'posted' && !q.external_id ? '<button class="btn small" data-reopen="' + q.id + '">Voltar para fila</button>' : '') +
        (q.status !== 'publishing' ? '<button class="btn small ghost danger" data-del-queue="' + q.id + '">Excluir</button>' : '') + '</div></article>';
    }).join('');
    return '<div class="pagehead"><h2>Fila e histórico</h2><p>Posts guardados para depois e tudo o que já foi postado. Publique quando quiser; agendar é opcional. Para postar na hora, use Postar agora na aba Produtos.</p></div>' +
      (state.queue.length ? filters : '') +
      (items ? '<div class="grid">' + items + '</div>' : state.queue.length ? '<div class="empty centered-empty">Nada neste filtro.</div>' : '<div class="empty centered-empty">Nada por aqui ainda. Em Produtos, use Postar agora, ou Fila Instagram/WhatsApp para guardar e publicar depois.</div>');
  }

  /* ---------- piloto automático ---------- */
  var INTERVALS = [[15, 'a cada 15 min'], [30, 'a cada 30 min'], [45, 'a cada 45 min'], [60, 'a cada 1 hora'], [90, 'a cada 1h30'], [120, 'a cada 2 horas'], [180, 'a cada 3 horas'], [240, 'a cada 4 horas']];
  var DEDUPS = [[1, '1 dia'], [2, '2 dias'], [3, '3 dias'], [7, '7 dias'], [14, '14 dias'], [30, '30 dias']];
  var CH_NAMES = { instagram: 'Instagram', telegram: 'Telegram', whatsapp: 'WhatsApp' };
  var runsOpen = {}; // id do piloto -> lista de rodadas carregada

  function autoSummary(c) {
    if (!c) return 'Configuração inválida: edite e salve de novo.';
    var src = [];
    if (c.sources.saved) src.push('seus produtos ' + (c.sources.marketplaces.length === 2 ? 'salvos' : 'da ' + mktName(c.sources.marketplaces[0])) + (c.sources.keywords.length ? ' com "' + c.sources.keywords.join('", "') + '"' : ''));
    if (c.sources.shopee_queries.length) src.push('busca na Shopee: ' + c.sources.shopee_queries.join(', '));
    var f = c.filters, filt = [];
    if (f.min_discount) filt.push('desconto ≥ ' + f.min_discount + '%');
    if (f.min_commission) filt.push('comissão ≥ ' + String(f.min_commission).replace('.', ',') + '%');
    if (f.shipping) filt.push(f.shipping === 'free' ? 'frete grátis' : 'frete grátis ou barato');
    if (f.price_min) filt.push('a partir de ' + brl(f.price_min));
    if (f.price_max) filt.push('até ' + brl(f.price_max));
    if (f.official_only) filt.push('só lojas oficiais');
    var iv = INTERVALS.filter(function (x) { return x[0] === c.interval_min; })[0];
    var chans = Object.keys(CH_NAMES).filter(function (k) { return c.channels[k]; }).map(function (k) { return CH_NAMES[k] + (k === 'instagram' ? ' (até ' + c.ig_daily_max + '/dia)' : ''); });
    return '<b>De onde:</b> ' + esc(src.join(' + ')) + '<br><b>Filtros:</b> ' + esc(filt.join(', ') || 'nenhum') +
      '<br><b>Quando:</b> 1 oferta ' + esc(iv ? iv[1] : '') + ', das ' + esc(c.window.start) + ' às ' + esc(c.window.end) + ', sem repetir por ' + c.dedup_days + ' dia' + (c.dedup_days > 1 ? 's' : '') +
      '<br><b>Para:</b> ' + esc(chans.join(', ')) + (c.tone === 'premium' ? '<br><b>Texto:</b> 💎 Premium' : '');
  }

  function runLine(r) {
    var ch = r.channels ? Object.keys(r.channels).map(function (k) { return CH_NAMES[k] + ': ' + r.channels[k]; }).join(' · ') : '';
    var icon = r.status === 'sent' ? '✅' : r.status === 'empty' ? '⏭️' : '⚠️';
    return '<li><span class="num hint">' + esc(fmtWhen(r.ran_at)) + '</span> ' + icon + ' ' + (r.title ? '<b>' + esc(r.title) + '</b> ' : '') +
      '<span class="hint">' + esc([r.source, ch, r.error].filter(Boolean).join(' · ')) + '</span></li>';
  }

  function viewPiloto() {
    var withLink = state.products.filter(function (p) { return p.affiliate_url; }).length;
    var tg = state.tg || {};
    var warn = [];
    if (!withLink) warn.push('Você ainda não tem produtos com o seu link de afiliado. O piloto só envia ofertas com o seu link (senão a venda não conta para você). Cadastre em Produtos → Cadastrar por links ou pela planilha da Shopee.');
    var cards = state.autos.map(function (a) {
      var c = a.config;
      var needs = [];
      if (c && c.channels.instagram && !(state.conn && state.conn.connected)) needs.push('conecte o Instagram');
      if (c && c.channels.telegram && !tg.ready) needs.push('conecte o Telegram');
      var runs = runsOpen[a.id];
      return '<article class="card auto' + (a.active ? '' : ' paused') + '"><header><div><h3>🤖 ' + esc(a.name) + '</h3><div class="meta"><span>' +
        (a.active ? 'Ligado' : 'Pausado') + '</span><span class="num">· ' + a.sent_today + ' hoje · ' + a.sent_total + ' no total</span>' +
        (a.last_run_at ? '<span class="num">· última rodada ' + esc(ago(a.last_run_at)) + '</span>' : '') + '</div></div>' +
        '<label class="switch"><input type="checkbox" data-auto-toggle="' + a.id + '"' + (a.active ? ' checked' : '') + ' aria-label="Ligar ou pausar"><span></span></label></header>' +
        '<p class="small">' + autoSummary(c) + '</p>' +
        (needs.length ? '<p class="err small">Para funcionar: ' + esc(needs.join(' e ')) + ' (aba Conexões).</p>' : '') +
        '<div class="actions"><button class="btn small primary" data-auto-run="' + a.id + '">Rodar agora</button><button class="btn small" data-auto-edit="' + a.id + '">Editar</button>' +
        '<button class="btn small" data-auto-runs="' + a.id + '">' + (runs ? 'Esconder histórico' : 'Histórico') + '</button><button class="btn small ghost danger" data-auto-del="' + a.id + '">Excluir</button></div>' +
        (runs ? (runs.length ? '<ul class="runs">' + runs.map(runLine).join('') + '</ul>' : '<p class="hint">Ainda não rodou.</p>') : '') + '</article>';
    }).join('');
    return '<div class="pagehead"><h2>Piloto automático</h2><p>Escolha de onde vêm as ofertas, os filtros, o horário e os canais. O Garimpo envia sozinho: <b>Instagram</b> e <b>Telegram</b> direto; no <b>WhatsApp</b> a oferta fica pronta na Fila e você compartilha com foto em um toque.</p></div>' +
      warn.map(function (w) { return '<p class="err">' + esc(w) + '</p>'; }).join('') +
      '<div class="row" style="margin-bottom:12px"><button class="btn primary" data-act="auto-new">+ Novo piloto</button><button class="btn" data-act="auto-new-premium">💎 Novo piloto Premium</button></div>' +
      (cards ? '<div class="grid">' + cards + '</div>' : '<div class="empty centered-empty">Nenhum piloto ainda. Crie um: por exemplo, "1 oferta da Shopee com 30% off a cada hora, das 9h às 21h, no Telegram e no WhatsApp".</div>') +
      '<section class="card" style="margin-top:14px"><h3>Como funciona</h3><ol class="steps">' +
      '<li>A cada rodada o piloto pega <b>1 oferta</b>: a fonte da vez, só itens com o seu link de afiliado, dentro dos filtros, sem repetir o que já mandou no período escolhido. Entre as melhores notas ele sorteia, para variar.</li>' +
      '<li>Produtos do Mercado Livre têm o preço conferido antes de sair (se a conferência tiver mais de 3 horas).</li>' +
      '<li><b>Instagram</b>: publica foto ou carrossel com até 3 fotos, respeitando o limite por dia (contas novas devem postar pouco no começo).</li>' +
      '<li><b>WhatsApp</b>: por segurança da sua conta, o envio é feito por você. Na Fila, filtre "WhatsApp a enviar" e use "📷 Compartilhar com foto".</li>' +
      '<li>Fora do horário escolhido o piloto descansa. "Rodar agora" funciona a qualquer hora, para testar.</li></ol></section>';
  }

  /** Pré-configuração da Linha Premium: produtos de loja oficial a partir de R$ 150, texto de curadoria, ritmo calmo. */
  function premiumPreset() {
    return { sources: { saved: true, marketplaces: ['ML', 'SH'], keywords: [], shopee_queries: [] }, filters: { min_discount: 0, min_commission: 0, shipping: '', price_min: 150, price_max: null, official_only: true },
      window: { start: '10:00', end: '21:00' }, interval_min: 240, dedup_days: 14, tone: 'premium',
      channels: { instagram: Boolean(state.conn && state.conn.connected), telegram: Boolean(state.tg && state.tg.ready), whatsapp: true }, ig_daily_max: 2 };
  }
  function autoDialog(a, preset) {
    var c = (a && a.config) || (preset === 'premium' ? premiumPreset() : null) || { sources: { saved: true, marketplaces: ['ML', 'SH'], keywords: [], shopee_queries: [] }, filters: { min_discount: 20, min_commission: 0, shipping: '', price_min: null, price_max: null },
      window: { start: '09:00', end: '21:00' }, interval_min: 60, dedup_days: 7, channels: { instagram: false, telegram: Boolean(state.tg && state.tg.ready), whatsapp: true }, ig_daily_max: 4 };
    var shOk = mktReady('SH');
    var chk = function (name, value, on, label) { return '<label class="check"><input type="checkbox" name="' + name + '" value="' + value + '"' + (on ? ' checked' : '') + '> ' + label + '</label>'; };
    var opt = function (list, cur) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); };
    var numv = function (v) { return v == null || v === 0 ? '' : String(v).replace('.', ','); };
    var inner = field('a_name', 'Nome do piloto', a ? a.name : preset === 'premium' ? 'Linha Premium' : 'Ofertas do dia', 'required maxlength="60"') +
      (preset === 'premium' ? '<p class="hint">💎 Já veio configurado para a Linha Premium: só lojas oficiais, a partir de R$ 150, texto de curadoria, até 2 posts por dia no Instagram. Ajuste o que quiser.</p>' : '') +
      '<fieldset class="fs"><legend>De onde vêm as ofertas</legend>' +
      chk('saved', '1', c.sources.saved, 'Meus produtos salvos (com link de afiliado)') +
      '<div class="row">' + chk('mk', 'ML', c.sources.marketplaces.indexOf('ML') > -1, 'Mercado Livre') + chk('mk', 'SH', c.sources.marketplaces.indexOf('SH') > -1, 'Shopee') + '</div>' +
      field('keywords', 'Só produtos com estas palavras (opcional, separe por vírgula)', c.sources.keywords.join(', '), 'placeholder="Ex.: air fryer, cozinha, maquiagem"') +
      field('shopee_queries', 'Buscas na Shopee (opcional, separe por vírgula)', c.sources.shopee_queries.join(', '), 'placeholder="Ex.: organizador, fone bluetooth"' + (shOk ? '' : ' disabled')) +
      (shOk ? '<p class="hint">Cada busca traz ofertas novas já com o seu link de afiliado. As fontes se revezam a cada rodada.</p>' : '<p class="hint">Buscas na Shopee ficam disponíveis quando a API de afiliados da Shopee for liberada e conectada.</p>') + '</fieldset>' +
      '<fieldset class="fs"><legend>Filtros</legend><div class="cols">' +
      field('min_discount', 'Desconto mínimo (%)', numv(c.filters.min_discount), 'inputmode="numeric" placeholder="0"') +
      field('min_commission', 'Comissão mínima (%)', numv(c.filters.min_commission), 'inputmode="decimal" placeholder="0"') + '</div><div class="cols">' +
      field('price_min', 'Preço de (R$)', numv(c.filters.price_min), 'inputmode="decimal" placeholder="qualquer"') +
      field('price_max', 'Preço até (R$)', numv(c.filters.price_max), 'inputmode="decimal" placeholder="qualquer"') + '</div>' +
      '<div class="field"><label for="a_ship">Frete</label><select id="a_ship" name="shipping">' + opt(SHIP_OPTS, c.filters.shipping) + '</select></div>' +
      chk('official_only', '1', c.filters.official_only, '💎 Só lojas oficiais (Mercado Livre: loja oficial · Shopee: Mall/oficial)') + '</fieldset>' +
      '<fieldset class="fs"><legend>Texto</legend><div class="field"><label for="a_tone">Tom do texto</label><select id="a_tone" name="tone">' + opt([['anninha', 'Anninha (animado, de achadinho)'], ['premium', '💎 Premium (curadoria, sóbrio)']], c.tone || 'anninha') + '</select></div></fieldset>' +
      '<fieldset class="fs"><legend>Quando</legend><div class="cols">' +
      '<div class="field"><label for="a_start">Das</label><input id="a_start" name="start" type="time" value="' + esc(c.window.start) + '" required></div>' +
      '<div class="field"><label for="a_end">Até</label><input id="a_end" name="end" type="time" value="' + esc(c.window.end) + '" required></div></div><div class="cols">' +
      '<div class="field"><label for="a_int">Ritmo (1 oferta)</label><select id="a_int" name="interval_min">' + opt(INTERVALS, c.interval_min) + '</select></div>' +
      '<div class="field"><label for="a_dd">Não repetir o mesmo produto por</label><select id="a_dd" name="dedup_days">' + opt(DEDUPS, c.dedup_days) + '</select></div></div>' +
      '<p class="hint">Horário de Brasília.</p></fieldset>' +
      '<fieldset class="fs"><legend>Para onde</legend>' +
      chk('ch', 'telegram', c.channels.telegram, 'Telegram (automático)' + (state.tg && state.tg.ready ? '' : ' <span class="hint">· conecte em Conexões</span>')) +
      chk('ch', 'instagram', c.channels.instagram, 'Instagram (automático)' + (state.conn && state.conn.connected ? '' : ' <span class="hint">· conecte em Conexões</span>')) +
      '<div class="field" style="margin-left:26px"><label for="a_igmax">Máximo de posts no Instagram por dia</label><input id="a_igmax" name="ig_daily_max" type="number" min="1" max="25" value="' + c.ig_daily_max + '" style="max-width:90px"></div>' +
      chk('ch', 'whatsapp', c.channels.whatsapp, 'WhatsApp (fica pronto na Fila para você compartilhar com foto)') + '</fieldset>' +
      chk('active', '1', a ? a.active : true, 'Ligado');
    openDialog(a ? 'Editar piloto' : 'Novo piloto', inner, 'Salvar piloto', function () {
      var fd = new FormData($('#dform', dlg));
      var body = {
        name: fd.get('a_name'), active: fd.get('active') === '1',
        config: {
          sources: { saved: fd.get('saved') === '1', marketplaces: fd.getAll('mk'), keywords: fd.get('keywords') || '', shopee_queries: fd.get('shopee_queries') || '' },
          filters: { min_discount: fd.get('min_discount'), min_commission: fd.get('min_commission'), price_min: fd.get('price_min'), price_max: fd.get('price_max'), shipping: fd.get('shipping'), official_only: fd.get('official_only') === '1' },
          tone: fd.get('tone'),
          window: { start: fd.get('start'), end: fd.get('end') }, interval_min: Number(fd.get('interval_min')), dedup_days: Number(fd.get('dedup_days')),
          channels: { instagram: fd.getAll('ch').indexOf('instagram') > -1, telegram: fd.getAll('ch').indexOf('telegram') > -1, whatsapp: fd.getAll('ch').indexOf('whatsapp') > -1 },
          ig_daily_max: Number(fd.get('ig_daily_max')),
        },
      };
      return (a ? api('PATCH', '/api/automations/' + a.id, body) : api('POST', '/api/automations', body)).then(function () { toast(a ? 'Piloto atualizado' : 'Piloto criado. Use "Rodar agora" para testar.'); return reload(); });
    });
  }

  function autoById(id) { return state.autos.filter(function (a) { return a.id === Number(id); })[0]; }
  function loadRuns(id) { return api('GET', '/api/automations/' + id + '/runs').then(function (r) { runsOpen[id] = r.items; }); }

  /* ---------- Direct: comentários "QUERO" e resposta com o link ---------- */
  var DM_STATUS = { novo: ['Aguardando', 'scheduled'], enviando: ['Enviando', 'publishing'], enviado: ['Enviado', 'posted'], erro: ['Erro', 'failed'], ignorado: ['Ignorado', 'draft'], fora_do_prazo: ['Prazo de 7 dias passou', 'draft'] };
  function loadDirect() {
    var dm = state.dm;
    return Promise.all([
      api('GET', '/api/direct/comments?filter=' + dm.filter).then(function (r) { dm.items = r.items; dm.syncedAt = r.synced_at; }),
      dm.settings ? null : api('GET', '/api/direct/settings').then(function (r) { dm.settings = r.settings; dm.defaults = r.defaults; }),
    ]).then(function () { dm.loaded = true; });
  }
  /* ---------- Direct: Pessoas (mini-CRM) e Relatório ---------- */
  function dmSwitch() {
    var v = state.dm.view || 'comentarios';
    return '<div class="seg gview" role="group" aria-label="Seção do Direct">' + [['comentarios', '💬 Comentários'], ['pessoas', '👥 Pessoas'], ['relatorio', '📊 Relatório']].map(function (o) {
      return '<button type="button" data-dmview="' + o[0] + '" aria-pressed="' + (v === o[0]) + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function loadDmPeople() {
    return api('GET', '/api/direct/people?q=' + encodeURIComponent(state.dm.q || '')).then(function (r) { state.dm.people = r.items; state.dm.peopleTotal = r.total; });
  }
  function loadDmReport() {
    return api('GET', '/api/direct/report?days=' + (state.dm.days || 30)).then(function (r) { state.dm.report = r; });
  }
  function viewDmPeople() {
    var dm = state.dm;
    if (!dm.people) { loadDmPeople().then(render).catch(function (e) { toast(e.message); }); return '<p class="hint">Carregando pessoas…</p>'; }
    var rows = dm.people.map(function (p) {
      return '<div class="prow person"><div class="pinfo"><h3><a href="https://www.instagram.com/' + esc(encodeURIComponent(p.username)) + '/" target="_blank" rel="noopener noreferrer">@' + esc(p.username) + '</a>' +
        (p.frequent ? ' <span class="tag hl">⭐ cliente frequente</span>' : '') + '</h3>' +
        '<div class="pline"><span><b class="num">' + p.requests + '</b> pedido' + (p.requests === 1 ? '' : 's') + '</span><span><b class="num">' + p.sent + '</b> Direct' + (p.sent === 1 ? '' : 's') + '</span>' +
        '<span class="' + (p.clicks ? 'earn' : 'hint') + '"><b class="num">' + p.clicks + '</b> clique' + (p.clicks === 1 ? '' : 's') + '</span><span class="hint">último ' + esc(ago(p.last_at)) + '</span></div>' +
        (p.products.length ? '<div class="hint small">' + esc(p.products.join(' · ').slice(0, 160)) + '</div>' : '') + '</div></div>';
    }).join('');
    return '<div class="psearch"><input id="dm-q" type="search" placeholder="Buscar por @ ou produto…" value="' + esc(dm.q || '') + '" aria-label="Buscar pessoas">' +
      '<a class="btn" href="/api/direct/people.csv" download>⬇ Exportar planilha</a></div>' +
      '<p class="hint pcount">' + dm.peopleTotal + ' pessoa' + (dm.peopleTotal === 1 ? '' : 's') + ' · "cliente frequente" = 3 pedidos ou mais</p>' +
      (rows ? '<div class="prodlist">' + rows + '</div>' : '<div class="empty centered-empty">Ninguém por aqui ainda. As pessoas aparecem quando comentam nos seus posts.</div>');
  }
  function bars(list, max) {
    return list.map(function (e) {
      var w = max ? Math.max(4, Math.round((e.n / max) * 100)) : 0;
      return '<div class="barrow"><span class="barlabel">' + e.label + '</span><span class="bar"><i style="width:' + w + '%"></i></span><b class="num">' + e.n + '</b></div>';
    }).join('');
  }
  function viewDmReport() {
    var dm = state.dm;
    if (!dm.report) { loadDmReport().then(render).catch(function (e) { toast(e.message); }); return '<p class="hint">Carregando relatório…</p>'; }
    var r = dm.report, t = r.totals;
    var kp = [['Comentários', t.comments], ['Pediram o link', t.requests], ['Pessoas', t.people], ['Directs enviados', t.sent], ['Cliques', t.clicks], ['Taxa de clique', t.click_rate + '%']];
    var maxP = r.top_products.length ? r.top_products[0].n : 0;
    var maxH = Math.max.apply(null, r.hours.concat([0]));
    var best = r.hours.indexOf(maxH);
    var hours = '<div class="hours">' + r.hours.map(function (n, h) {
      return '<span title="' + h + 'h: ' + n + ' pedido(s)"><i style="height:' + (maxH ? Math.max(3, Math.round((n / maxH) * 100)) : 3) + '%"></i><small>' + (h % 3 === 0 ? h : '') + '</small></span>';
    }).join('') + '</div>';
    return '<div class="seg" role="group" aria-label="Período" style="margin-bottom:12px">' + [[7, '7 dias'], [30, '30 dias'], [90, '90 dias']].map(function (o) {
      return '<button type="button" data-dmdays="' + o[0] + '" aria-pressed="' + (r.days === o[0]) + '">' + o[1] + '</button>';
    }).join('') + '</div>' +
      '<div class="kpis">' + kp.map(function (k) { return '<div class="kpi"><span>' + k[0] + '</span><b class="num">' + k[1] + '</b></div>'; }).join('') + '</div>' +
      '<p class="hint">Taxa de clique = pessoas que clicaram no link ÷ Directs enviados. Os cliques são medidos pelo link curto do Garimpo (robôs de prévia não contam).</p>' +
      '<div class="panels"><section class="card"><h3>🏆 Produtos mais pedidos</h3>' + (r.top_products.length ? bars(r.top_products.map(function (e) { return { n: e.n, label: esc(e.label || 'Produto') }; }), maxP) : '<p class="hint">Sem pedidos no período.</p>') + '</section>' +
      '<section class="card"><h3>🕐 Horários com mais pedidos</h3>' + (maxH ? hours + '<p class="hint">Pico às <b>' + best + 'h</b>: um bom horário para postar.</p>' : '<p class="hint">Sem pedidos no período.</p>') +
      (Object.keys(r.weekdays).length ? '<p class="hint">Por dia: ' + Object.keys(r.weekdays).map(function (d) { return esc(d) + ' ' + r.weekdays[d]; }).join(' · ') + '</p>' : '') + '</section></div>' +
      '<section class="card" style="margin-top:12px"><h3>📸 Posts que mais geraram pedidos</h3>' + (r.top_posts.length ? r.top_posts.map(function (p) {
        return '<div class="barrow"><span class="barlabel">' + (p.label ? '<a href="' + esc(safeUrl(p.label)) + '" target="_blank" rel="noopener noreferrer">' + esc(p.title.slice(0, 60)) + ' ↗</a>' : esc(p.title.slice(0, 60))) + '</span><b class="num">' + p.n + ' pedido' + (p.n === 1 ? '' : 's') + '</b></div>';
      }).join('') : '<p class="hint">Sem pedidos no período.</p>') + '</section>';
  }

  function viewDirect() {
    var dm = state.dm;
    var head0 = '<div class="pagehead"><h2>Direct</h2><p>Quem pede o link nos comentários, quem clicou e o que mais vende.</p></div>';
    if (dm.view === 'pessoas') return head0 + dmSwitch() + viewDmPeople();
    if (dm.view === 'relatorio') return head0 + dmSwitch() + viewDmReport();
    if (!dm.loaded) { loadDirect().then(render).catch(function (e) { toast(e.message); }); return '<p class="hint">Carregando comentários…</p>'; }
    if (!(state.conn && state.conn.connected)) {
      return '<div class="pagehead"><h2>Direct</h2></div><div class="empty centered-empty">Conecte o Instagram na aba Conexões para receber os comentários.<div class="row" style="justify-content:center;margin-top:10px"><button class="btn primary" data-tab="conexoes">Ir para Conexões</button></div></div>';
    }
    var s = dm.settings || { auto: false, keywords: [], template: '', public_reply: true };
    var chips = [['pedidos', 'Pediram o link'], ['pendentes', 'Pendentes'], ['todos', 'Todos']].map(function (f) {
      return '<button class="chip" data-dmfilter="' + f[0] + '" aria-pressed="' + (dm.filter === f[0]) + '">' + f[1] + '</button>';
    }).join('');
    var rows = dm.items.map(function (c) {
      var st = DM_STATUS[c.status] || DM_STATUS.novo;
      var canSend = c.status === 'novo' || c.status === 'erro' || c.status === 'ignorado';
      return '<article class="card dmitem' + (c.matched ? ' asked' : '') + '"><header><div><h3>@' + esc(c.username || 'alguém') + (c.matched ? ' <span class="tag hl">pediu o link</span>' : '') + '</h3>' +
        '<div class="meta"><span>' + esc(c.commented_at ? ago(c.commented_at) : '') + '</span>' + (c.products.length ? '<span>' + esc(c.products.map(function (p) { return p.title; }).join(', ').slice(0, 70)) + '</span>' : '<span class="err">post sem produto do Garimpo</span>') +
        (c.permalink ? '<a class="small" href="' + esc(safeUrl(c.permalink)) + '" target="_blank" rel="noopener noreferrer">ver post ↗</a>' : '') + '</div></div>' +
        '<span class="pill ' + st[1] + '">' + st[0] + '</span></header>' +
        (c.clicks ? '<p class="ok small">👆 Clicou no link' + (c.clicks > 1 ? ' (' + c.clicks + 'x)' : '') + '</p>' : (c.status === 'enviado' ? '<p class="hint small">Ainda não clicou no link</p>' : '')) +
        '<p class="dmtext">💬 ' + esc(c.text || '') + '</p>' +
        (c.status === 'enviado' ? '<details><summary class="hint">Mensagem enviada ' + esc(c.sent_at ? ago(c.sent_at) : '') + '</summary><pre class="dmsent">' + esc(c.reply_text || '') + '</pre></details>' : '') +
        (c.error && c.status !== 'enviado' ? '<p class="err small">' + esc(c.error) + '</p>' : '') +
        (canSend ? '<textarea id="dm-' + c.id + '" rows="5" aria-label="Mensagem do Direct" placeholder="Escreva a mensagem com o link">' + esc(c.preview || '') + '</textarea>' +
          '<div class="actions"><button class="btn small primary" data-dmsend="' + c.id + '">💌 Enviar no Direct</button>' + (c.status !== 'ignorado' ? '<button class="btn small ghost" data-dmignore="' + c.id + '">Ignorar</button>' : '') + '</div>' : '') +
        '</article>';
    }).join('');
    var settings = '<details class="card dmset"' + (dm.items.length ? '' : ' open') + '><summary><b>⚙️ Respostas automáticas</b> <span class="hint">' + (s.auto ? '· ligado' : '· desligado (você revisa e envia)') + '</span></summary>' +
      '<form id="dm-form" class="stack" style="margin-top:10px">' +
      '<label class="check"><input type="checkbox" name="auto"' + (s.auto ? ' checked' : '') + '> <b>Enviar sozinho</b>: quem comentar uma palavra-chave recebe o link no Direct em até 3 minutos</label>' +
      '<div class="field"><label for="dm-kw">Palavras-chave (separe por vírgula)</label><input id="dm-kw" name="keywords" type="text" value="' + esc(s.keywords.join(', ')) + '"></div>' +
      '<div class="field"><label for="dm-tpl">Mensagem do Direct</label><textarea id="dm-tpl" name="template" rows="6">' + esc(s.template) + '</textarea>' +
      '<p class="hint">Use {nome} (o @ da pessoa), {produto} e {link}. Em post com vários produtos, vai a lista numerada (ou só o número que a pessoa comentou).</p></div>' +
      '<label class="check"><input type="checkbox" name="public_reply"' + (s.public_reply ? ' checked' : '') + '> Responder também no comentário ("Te mandei no Direct! 💌"), o que ajuda o post a aparecer mais</label>' +
      '<label class="check"><input type="checkbox" name="track_links"' + (s.track_links !== false ? ' checked' : '') + '> Medir cliques: o link vai encurtado pelo Garimpo (um por pessoa) e leva ao seu link de afiliado</label>' +
      '<div class="row end"><button class="btn small" type="button" data-act="dm-defaults">Restaurar padrão</button><button class="btn small primary" type="submit">Salvar</button></div></form></details>';
    var meta = '<details class="card"><summary><b>🔓 Liberar para todos os clientes (Análise da Meta)</b></summary><ol class="steps" style="margin-top:8px">' +
      '<li>Hoje o seu app da Meta está em <b>modo de desenvolvimento</b>: a Meta só mostra comentários e só deixa mandar Direct para <b>contas cadastradas no app</b> (você e testadoras).</li>' +
      '<li>Para testar já: em developers.facebook.com → seu app → Funções do app → adicione uma segunda conta do Instagram como <b>Testadora do Instagram</b>, aceite o convite nessa conta e comente "QUERO" num post seu.</li>' +
      '<li>Para todos os clientes: no app, peça <b>Acesso avançado</b> às permissões <b>instagram_business_manage_comments</b> e <b>instagram_business_manage_messages</b>, envie para a Análise do App com um vídeo do fluxo e use as páginas de <a href="/privacidade.html" target="_blank">Política de Privacidade</a> e <a href="/exclusao-de-dados.html" target="_blank">Exclusão de Dados</a> do Garimpo.</li>' +
      '<li>Depois de aprovado, mude o app para o modo <b>Ao vivo</b>. Pronto: funciona com qualquer pessoa.</li></ol></details>';
    return '<div class="pagehead"><h2>Direct</h2><p>Quem comentar "QUERO" nos seus posts recebe o link do produto no Direct, pela resposta oficial do Instagram (até 7 dias depois do comentário, 1 mensagem por comentário).</p></div>' + dmSwitch() +
      '<div class="toolbar"><button class="btn primary" data-act="dm-sync">🔄 Buscar comentários agora</button><span class="hint">' + (dm.syncedAt ? 'Última busca ' + esc(ago(dm.syncedAt)) : 'Ainda não buscou') + '</span></div>' +
      settings + meta +
      '<div class="filters" style="margin-top:12px">' + chips + '</div>' +
      (rows ? '<div class="grid">' + rows + '</div>' : '<div class="empty centered-empty">' + (dm.filter === 'pedidos' ? 'Nenhum pedido de link ainda. Toque em "Buscar comentários agora".' : 'Nenhum comentário por aqui.') + '</div>');
  }

  function viewGanhos() {
    var s = state.summary; if (!s) return '';
    var k = s.kpis;
    var kp = [['A receber', brl(k.to_receive), 'pendente + confirmada'], ['Já recebido', brl(k.paid), 'comissões pagas'],
      ['Cliques', k.clicks.toLocaleString('pt-BR'), 'últimos ' + s.range.days + ' dias'], ['Pedidos', String(k.orders), 'conversão ' + String(k.conversion).replace('.', ',') + '%']];
    var W = 640, H = 220, L = 46, B = 26, T = 10, R = 8, n = s.by_day.length;
    var maxv = Math.max.apply(null, s.by_day.map(function (d) { return d.commission; }).concat([1]));
    var mag = Math.pow(10, Math.floor(Math.log10(maxv))); var max = Math.ceil(maxv / mag * 2) / 2 * mag; if (max < maxv) max = maxv;
    var bw = (W - L - R) / n;
    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Comissão por dia, total de ' + brl(k.total) + '">';
    [0, max / 2, max].forEach(function (v) {
      var y = T + (H - T - B) * (1 - v / max);
      svg += '<line class="grid-l" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">R$ ' + Math.round(v) + '</text>';
    });
    s.by_day.forEach(function (d, i) {
      var h = (H - T - B) * (d.commission / max), x = L + i * bw + bw * 0.18, y = H - B - h;
      svg += '<rect class="bar' + (i === n - 1 ? ' last' : '') + '" x="' + x + '" y="' + y + '" width="' + (bw * 0.64) + '" height="' + h + '" rx="3"><title>' + esc(d.day) + ': ' + brl(d.commission) + '</title></rect>';
      if (i % Math.ceil(n / 7) === 0 || i === n - 1) { var p = d.day.split('-'); svg += '<text x="' + (x + bw * 0.32) + '" y="' + (H - 8) + '" text-anchor="middle">' + p[2] + '/' + p[1] + '</text>'; }
    });
    svg += '</svg>';
    var mx = Math.max.apply(null, s.by_channel.map(function (c) { return c.commission; }).concat([1]));
    var bars = s.by_channel.length ? s.by_channel.map(function (c) {
      return '<div><div class="lbl"><span>' + esc(c.channel) + '</span><b class="num">' + brl(c.commission) + '</b></div><div class="track"><div class="fill" style="width:' + (c.commission / mx * 100) + '%"></div></div></div>';
    }).join('') : '<p class="hint">Sem lançamentos neste período.</p>';
    var prods = s.by_product.map(function (p) {
      return '<tr><td>' + esc(p.title.length > 34 ? p.title.slice(0, 33) + '…' : p.title) + '</td><td class="r num">' + p.clicks + '</td><td class="r num">' + p.orders + '</td><td class="r num">' + brl(p.commission) + '</td></tr>';
    }).join('');
    var rows = state.earnings.slice(0, 30).map(function (e) {
      var st = ['pendente', 'confirmada', 'paga'].map(function (o) { return '<option' + (o === e.status ? ' selected' : '') + '>' + o + '</option>'; }).join('');
      return '<tr><td class="num">' + e.day.split('-').reverse().join('/') + '</td><td>' + esc(e.product_title || '—') + '</td><td>' + esc(e.channel) + '</td><td class="r num">' + e.clicks + '</td><td class="r num">' + e.orders + '</td><td class="r num">' + brl(e.commission) + '</td>' +
        '<td><select data-earn-status="' + e.id + '" aria-label="Situação">' + st + '</select></td><td><button class="btn small ghost danger" data-del-earn="' + e.id + '">Excluir</button></td></tr>';
    }).join('');
    return '<div class="pagehead"><h2>Ganhos</h2><p>Comissão dos últimos ' + s.range.days + ' dias: <b class="num">' + brl(k.total) + '</b></p></div>' +
      '<div class="toolbar"><button class="btn primary" data-act="new-earning">Novo lançamento</button><button class="btn" data-act="import-earnings">Importar CSV</button>' +
      (mktReady('SH') ? '<button class="btn" data-act="sh-sales" title="As vendas da Shopee também entram sozinhas a cada 6 horas">🔄 Importar vendas da Shopee</button>' : '') +
      '<select id="f-days" aria-label="Período">' + [7, 14, 30, 90].map(function (d) { return '<option value="' + d + '"' + (d === state.days ? ' selected' : '') + '>Últimos ' + d + ' dias</option>'; }).join('') + '</select></div>' +
      '<div class="kpis">' + kp.map(function (x) { return '<div class="kpi"><span>' + x[0] + '</span><b class="num">' + x[1] + '</b><small>' + x[2] + '</small></div>'; }).join('') + '</div>' +
      '<div class="panels"><section class="card panel"><h3>Comissão por dia</h3>' + svg + '</section><section class="card panel"><h3>Por canal</h3><div class="bars">' + bars + '</div></section></div>' +
      '<section class="card panel" style="margin-top:12px"><h3>Por produto</h3>' + (prods ? '<div class="tablewrap"><table><thead><tr><th>Produto</th><th class="r">Cliques</th><th class="r">Pedidos</th><th class="r">Comissão</th></tr></thead><tbody>' + prods + '</tbody></table></div>' : '<p class="hint">Sem lançamentos neste período.</p>') + '</section>' +
      '<section class="card panel" style="margin-top:12px"><h3>Lançamentos recentes</h3>' + (rows ? '<div class="tablewrap"><table><thead><tr><th>Dia</th><th>Produto</th><th>Canal</th><th class="r">Cliques</th><th class="r">Pedidos</th><th class="r">Comissão</th><th>Situação</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="hint">Nada lançado ainda. Importe o relatório do painel de afiliados ou use Novo lançamento.</p>') + '</section>';
  }

  /**
   * Tabela de comissão do Mercado Livre por categoria principal. A API não informa a comissão de afiliado;
   * o usuário copia do painel de Afiliados uma vez e o app aplica em cada produto pela categoria dele.
   */
  /** CEP de referência: o Mercado Livre calcula o frete por região; o app estima para este CEP. */
  function shipZipCard() {
    var z = state.shipZip ? state.shipZip.slice(0, 5) + '-' + state.shipZip.slice(5) : '';
    return '<form id="ship-form" class="stack shipzip"><div class="field"><label for="ship-zip">CEP de referência para o frete</label>' +
      '<div class="row"><input id="ship-zip" name="zip" type="text" inputmode="numeric" maxlength="9" autocomplete="off" placeholder="00000-000" value="' + esc(z) + '" style="max-width:160px">' +
      '<button class="btn small" type="submit">Salvar CEP</button></div></div>' +
      '<p class="hint">O frete muda por região. Use o seu CEP ou o de uma cidade onde estão seus seguidores. Os produtos mostram o frete e o total até esse CEP (atualizado no "Atualizar preço").</p>' +
      '<p class="err" id="ship-err" role="alert"></p></form>';
  }

  function commissionTableCard(ml) {
    var cats = state.g.cats;
    if (!cats) return '<p class="hint">Carregando as categorias do Mercado Livre…</p>';
    var t = ml.commission_table || {};
    var filled = Object.keys(t).length;
    var rows = cats.map(function (c) {
      return '<label class="comrow"><span>' + esc(c.name) + '</span><input type="text" inputmode="decimal" name="' + esc(c.id) + '" value="' + esc(t[c.id] == null ? '' : String(t[c.id]).replace('.', ',')) + '" placeholder="' + esc(ml.default_commission == null ? '—' : String(ml.default_commission).replace('.', ',')) + '" aria-label="Comissão em ' + esc(c.name) + ' (%)"><em>%</em></label>';
    }).join('');
    return '<details class="comtable"' + (filled ? '' : ' open') + '><summary><b>Comissão por categoria</b> <span class="hint">(' + filled + ' de ' + cats.length + ' preenchidas)</span></summary>' +
      '<p class="hint">O Mercado Livre não informa a comissão de afiliado pela API. Copie os percentuais do seu painel de Afiliados do Mercado Livre: o app descobre a categoria de cada produto e calcula quanto você ganha por venda. Em branco = usa a comissão padrão.</p>' +
      '<form id="mlcom-form" class="stack"><div class="comgrid">' + rows + '</div><p class="err" id="mlcom-err" role="alert"></p>' +
      '<div class="row end"><button class="btn primary" type="submit">Salvar comissões</button></div></form></details>';
  }

  /** Telegram: 1) token do bot (@BotFather); 2) escolher o grupo/canal (lista ou @canal); 3) pronto. */
  function telegramCard() {
    var tg = state.tg || {};
    var head = '<section class="card"><h3>Telegram (piloto automático)</h3>';
    if (tg.ready) {
      return head + '<p class="ok">Postando em <b>' + esc(tg.chat_title || tg.chat_id) + '</b>.</p>' +
        '<div class="actions row"><button class="btn small" data-act="tg-change">Trocar grupo/canal</button><button class="btn small danger" data-act="disconnect-tg">Desconectar</button></div></section>';
    }
    if (tg.connected) {
      var found = state.tgChats;
      return head + '<p class="ok">Bot conectado. Falta escolher onde ele vai postar.</p><ol class="steps">' +
        '<li>No Telegram, abra o seu <b>grupo</b> ou <b>canal</b> de ofertas → Administradores → Adicionar administrador → procure o seu bot e permita <b>enviar/publicar mensagens</b>.</li>' +
        '<li>Mande qualquer mensagem no grupo/canal (ex.: "oi") e toque em <b>Procurar meus grupos</b>.</li></ol>' +
        '<div class="row"><button class="btn small primary" data-act="tg-find">Procurar meus grupos</button><button class="btn small danger" data-act="disconnect-tg">Desconectar</button></div>' +
        (found && found.length ? '<div class="stack" style="margin-top:10px">' + found.map(function (ch) {
          return '<button class="btn" data-tgchat="' + esc(ch.id) + '">Usar "' + esc(ch.title) + '" <span class="hint">(' + (ch.type === 'channel' ? 'canal' : 'grupo') + ')</span></button>';
        }).join('') + '</div>' : '') +
        '<form class="stack" id="tgchat-form" style="margin-top:10px"><div class="field"><label for="tg-chat">Ou digite o @ do canal público</label><input id="tg-chat" type="text" autocomplete="off" placeholder="@achadinhosdaanninha"></div>' +
        '<p class="err" role="alert"></p><button class="btn" type="submit">Usar este canal</button></form></section>';
    }
    return head + '<p class="hint">Não conectado. Com o Telegram, o piloto automático posta as ofertas com foto sozinho no seu grupo ou canal (API oficial, sem risco para a conta).</p>' +
      '<form class="stack" id="tg-form" autocomplete="off"><div class="field"><label for="tg-token">Token do bot</label><input id="tg-token" type="password" autocomplete="new-password" data-lpignore="true" placeholder="123456789:AAH..." required></div>' +
      '<p class="err" role="alert"></p><button class="btn primary" type="submit">Conectar bot</button></form>' +
      '<ol class="steps"><li>No Telegram, abra uma conversa com <b>@BotFather</b> (o oficial, com selo azul).</li><li>Envie <b>/newbot</b>, escolha um nome (ex.: Achadinhos da Anninha) e um usuário terminado em <b>bot</b>.</li>' +
      '<li>O BotFather responde com o <b>token</b>. Copie e cole aqui. Ele fica guardado criptografado e nunca volta para esta tela.</li></ol></section>';
  }

  function viewConexoes() {
    var c = state.conn || {};
    var m = state.mkts || { SH: {}, ML: {} };
    var sh = m.SH || {}, ml = m.ML || {};
    var shCard = '<section class="card"><h3>Shopee (garimpo)</h3>' +
      (sh.connected ? '<p class="ok">Conectada (App ID ' + esc(sh.app_id) + ').</p><div class="row"><button class="btn small danger" data-act="disconnect-sh">Desconectar</button></div>' : '<p class="hint">Não conectada.</p>') +
      '<form class="stack" id="sh-form"><div class="field"><label for="sh-id">App ID</label><input id="sh-id" name="app_id" type="text" inputmode="numeric" autocomplete="off" required></div>' +
      '<div class="field"><label for="sh-secret">Secret</label><input id="sh-secret" name="secret" type="password" autocomplete="new-password" data-lpignore="true" required></div>' +
      '<p class="err" id="sh-err" role="alert"></p><button class="btn primary" type="submit">Salvar e testar</button></form>' +
      '<ol class="steps"><li>Entre no portal de afiliados da Shopee (affiliate.shopee.com.br).</li><li>Abra o menu <b>Open API</b> e peça o acesso. A aprovação pode levar alguns dias.</li><li>Copie o <b>App ID</b> e a <b>Secret</b> e cole aqui.</li></ol></section>';
    var mlStatus = ml.authorized ? '<p class="ok">Conectado e autorizado (Client ID ' + esc(ml.app_id) + ').</p>' :
      ml.connected ? '<p class="err">Credenciais salvas, mas falta autorizar a sua conta.</p><div class="row"><button class="btn small primary" data-act="ml-authorize">Autorizar agora</button></div>' : '<p class="hint">Não conectado.</p>';
    var mlCard = '<section class="card"><h3>Mercado Livre (garimpo)</h3>' + mlStatus +
      (ml.connected ? '<div class="row"><button class="btn small danger" data-act="disconnect-ml">Desconectar</button></div>' : '') +
      '<form class="stack" id="ml-form"><div class="field"><label for="ml-id">Client ID' + (ml.connected ? ' (em branco mantém o atual)' : '') + '</label><input id="ml-id" name="client_id" type="text" inputmode="numeric" autocomplete="off"' + (ml.connected ? '' : ' required') + '></div>' +
      '<div class="field"><label for="ml-secret">Client Secret</label><input id="ml-secret" name="client_secret" type="password" autocomplete="new-password" data-lpignore="true"' + (ml.connected ? '' : ' required') + '></div>' +
      '<div class="field"><label for="ml-com">Sua comissão padrão no Mercado Livre (%)</label><input id="ml-com" name="default_commission" type="text" inputmode="decimal" value="' + esc(ml.default_commission == null ? '' : ml.default_commission) + '" placeholder="Ex.: 8"></div>' +
      '<p class="err" id="ml-err" role="alert"></p><button class="btn primary" type="submit">' + (ml.connected ? 'Salvar' : 'Salvar e autorizar') + '</button></form>' +
      '<ol class="steps"><li>Entre em developers.mercadolivre.com.br com a sua conta e clique em <b>Criar aplicação</b>.</li>' +
      '<li>Em <b>URI de redirect</b>, cole exatamente:<br><code class="copyable">' + esc(ml.redirect_uri || '') + '</code></li>' +
      '<li>Marque as permissões de leitura e <b>offline_access</b> (para não precisar autorizar de novo a cada 6 horas).</li>' +
      '<li>Copie o <b>Client ID</b> e a <b>Client Secret</b> para cá e clique em Salvar e autorizar. Na página do Mercado Livre, aceite.</li>' +
      '<li>A comissão padrão vale para as categorias que você não preencher na tabela abaixo.</li></ol>' +
      (ml.authorized ? shipZipCard() + commissionTableCard(ml) : '') + '</section>';
    return '<div class="pagehead"><h2>Conexões</h2><p>Lojas para garimpar, Instagram e Telegram para publicar direto do painel.</p></div><div class="conn">' + mlCard + shCard + telegramCard() +
      '<section class="card"><h3>Instagram</h3>' +
      (c.connected ? '<p class="ok">Conectado (conta ' + esc(c.ig_user_id) + ').</p><div class="actions row"><button class="btn small" data-act="test-ig">Testar conexão</button><button class="btn small danger" data-act="disconnect-ig">Desconectar</button></div>' : '<p class="hint">Não conectado. Sem conexão você ainda pode copiar os textos e postar manualmente.</p>') +
      (c.public_media === false ? '<p class="err">Este servidor está em endereço local. O Instagram só consegue ler fotos e vídeos de uma URL pública, então a publicação vai falhar até você configurar APP_URL com o seu domínio.</p>' : '') +
      // Conectado: formulário recolhido. autocomplete desligado para o navegador não preencher e-mail/senha salvos.
      (c.connected ? '<details class="sched"><summary>Trocar de conta ou atualizar o token</summary>' : '') +
      '<form class="stack" id="ig-form" autocomplete="off"><div class="field"><label for="ig-id">ID da conta do Instagram (só números)</label><input id="ig-id" name="ig_user_id" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-lpignore="true" placeholder="17841400000000000" required></div>' +
      '<div class="field"><label for="ig-token">Token de acesso (começa com IG)</label><input id="ig-token" name="access_token" type="password" autocomplete="new-password" data-lpignore="true" required></div>' +
      '<p class="err" id="ig-err" role="alert"></p><button class="btn primary" type="submit">' + (c.connected ? 'Atualizar credenciais' : 'Conectar') + '</button></form>' +
      (c.connected ? '</details>' : '') + '</section>' +
      '<section class="card"><h3>Como conseguir as credenciais</h3><ol class="steps">' +
      '<li>No app do Instagram, deixe a conta como <b>profissional</b> (Comercial ou Criador de conteúdo).</li>' +
      '<li>Em developers.facebook.com, crie um app com o caso de uso <b>Gerenciar mensagens e conteúdo no Instagram</b> (API do Instagram).</li>' +
      '<li>No painel do app, abra <b>Configuração da API com login do Instagram</b> e, em <b>Gerar tokens de acesso</b>, adicione a sua conta do Instagram.</li>' +
      '<li>Copie o <b>ID da conta do Instagram</b> e o <b>token</b> (começa com IG) para cá.</li></ol>' +
      '<p class="hint">Não precisa de Página do Facebook. O token é guardado criptografado, nunca volta para esta tela e é renovado sozinho antes de vencer (60 dias).</p></section></div>';
  }

  function render() {
    var scroll = window.scrollY;
    if (state.loading) { app.innerHTML = '<p class="hint" style="padding-top:40vh;text-align:center">Carregando…</p>'; return; }
    if (!state.user) { app.innerHTML = viewLogin(); return; }
    var body = state.tab === 'garimpar' ? viewGarimpar() : state.tab === 'descobrir' ? viewDescobrir() : state.tab === 'fila' ? viewFila() : state.tab === 'piloto' ? viewPiloto() : state.tab === 'direct' ? viewDirect() : state.tab === 'ganhos' ? viewGanhos() : viewConexoes();
    app.innerHTML = shell(body);
    window.scrollTo(0, scroll);
  }

  /* ---------- diálogos ---------- */
  function field(id, label, value, attrs) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" name="' + id + '" type="text" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + '></div>';
  }
  function openDialog(title, inner, submitLabel, onSubmit) {
    dlg.innerHTML = '<h2>' + esc(title) + '</h2><form class="stack" id="dform">' + inner + '<p class="err" id="derr" role="alert"></p><div class="row end"><button class="btn" type="button" data-act="close-dlg">Cancelar</button><button class="btn primary" type="submit">' + esc(submitLabel) + '</button></div></form>';
    $('#dform', dlg).addEventListener('submit', function (e) {
      e.preventDefault();
      var data = Object.fromEntries(new FormData(e.target).entries());
      Promise.resolve(onSubmit(data)).then(function () { dlg.close(); }).catch(function (err) { $('#derr', dlg).textContent = err.message; });
    });
    dlg.showModal();
  }

  function productDialog(p) {
    p = p || {};
    var inner = field('title', 'Nome do produto', p.title, 'required') +
      '<div class="cols"><div class="field"><label for="marketplace">Marketplace</label><select id="marketplace" name="marketplace"><option value="ML"' + (p.marketplace === 'ML' ? ' selected' : '') + '>Mercado Livre</option><option value="SH"' + (p.marketplace === 'SH' ? ' selected' : '') + '>Shopee</option></select></div>' + field('category', 'Categoria', p.category, 'list="cats"') + '</div>' +
      '<datalist id="cats"><option>Casa e cozinha</option><option>Eletrônicos</option><option>Beleza</option><option>Acessórios</option></datalist>' +
      '<div class="cols">' + field('price', 'Preço (R$) — o menor, se tiver opções', p.price, 'inputmode="decimal" required') + field('original_price', 'Preço original (R$)', p.original_price, 'inputmode="decimal"') + '</div>' +
      '<div class="cols">' + field('price_max', 'Até (R$) — só se tiver opções/kits', p.price_max, 'inputmode="decimal" placeholder="vazio = preço único"') + field('commission_pct', 'Comissão (%)', p.commission_pct, 'inputmode="decimal"') + '</div>' +
      '<div class="cols">' + field('rating', 'Avaliação (0 a 5)', p.rating, 'inputmode="decimal"') + field('sales_k', 'Vendidos (em milhares)', p.sales_k, 'inputmode="decimal"') + '</div>' +
      field('product_url', 'Link do anúncio', p.product_url, 'inputmode="url"') + field('affiliate_url', 'Seu link de afiliado', p.affiliate_url, 'inputmode="url"') +
      field('image_url', 'Foto principal (endereço)', p.image_url, 'inputmode="url"') +
      '<div class="field"><label for="images">Mais fotos do produto (endereços, um por linha)</label><textarea id="images" name="images" rows="3" placeholder="https://down-br.img.susercontent.com/file/...">' +
      esc((p.images || []).filter(function (u) { return u !== p.image_url; }).join('\n')) + '</textarea>' +
      '<p class="hint">Na página do produto (no computador), clique com o botão direito em cada foto → <b>Copiar endereço da imagem</b> e cole aqui. Elas aparecem para escolher no Postar agora (carrossel e capa). No celular, salve as fotos e use "+ foto" no Postar agora.</p></div>' +
      field('video_url', 'Vídeo (endereço)', p.video_url, 'inputmode="url"') +
      '<div class="field"><label for="pfile">Ou envie foto/vídeo do seu aparelho</label><input id="pfile" class="file-input" type="file" accept="image/jpeg,image/png,video/mp4"></div>';
    openDialog(p.id ? 'Editar produto' : 'Novo produto', inner, 'Salvar', function (data) {
      var f = $('#pfile', dlg).files[0];
      var up = f ? uploadFile(f).then(function (r) { if (r.media_type === 'video') data.video_url = r.url; else data.image_url = r.url; }) : Promise.resolve();
      return up.then(function () { delete data.pfile; return p.id ? api('PATCH', '/api/products/' + p.id, data) : api('POST', '/api/products', data); }).then(function () { toast('Produto salvo'); return reload(); });
    });
    if (p.id) {
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'btn small ghost danger'; del.textContent = 'Excluir produto'; del.dataset.delProduct = p.id;
      $('#dform', dlg).appendChild(del);
    }
  }

  function earningDialog() {
    var today = new Date().toISOString().slice(0, 10);
    var opts = '<option value="">Sem produto</option>' + state.products.map(function (p) { return '<option value="' + p.id + '">' + esc(p.title) + '</option>'; }).join('');
    var inner = '<div class="cols">' + field('day', 'Dia (dd/mm/aaaa)', new Date().toLocaleDateString('pt-BR'), 'required') +
      '<div class="field"><label for="channel">Canal</label><select id="channel" name="channel"><option value="instagram">Instagram</option><option value="whatsapp">WhatsApp</option><option value="outro">Outro</option></select></div></div>' +
      '<div class="field"><label for="product_id">Produto</label><select id="product_id" name="product_id">' + opts + '</select></div>' +
      '<div class="cols">' + field('clicks', 'Cliques', '0', 'inputmode="numeric"') + field('orders', 'Pedidos', '0', 'inputmode="numeric"') + '</div>' +
      '<div class="cols">' + field('commission', 'Comissão (R$)', '', 'inputmode="decimal" required') +
      '<div class="field"><label for="status">Situação</label><select id="status" name="status"><option>pendente</option><option>confirmada</option><option>paga</option></select></div></div>';
    void today;
    openDialog('Novo lançamento', inner, 'Salvar', function (data) {
      if (!data.product_id) delete data.product_id;
      return api('POST', '/api/earnings', data).then(function () { toast('Lançamento salvo'); return reload(); });
    });
  }

  function importDialog(kind) {
    var isProd = kind === 'products';
    var cols = isProd ? 'titulo; marketplace (ML ou SH); categoria; preco; preco_original; avaliacao; vendas_mil; comissao; link; link_afiliado; imagem; video' : 'data; produto; canal; cliques; pedidos; comissao; situacao';
    openDialog(isProd ? 'Importar produtos (CSV)' : 'Importar ganhos (CSV)',
      '<p class="hint">Colunas: ' + cols + '. Aceita separador ; ou , e vírgula decimal.</p><div class="field"><label for="csv">Arquivo CSV</label><input id="csv" class="file-input" type="file" accept=".csv,text/csv" required></div>',
      'Importar', function () {
        var f = $('#csv', dlg).files[0];
        if (!f) throw new Error('Escolha um arquivo.');
        return f.text().then(function (txt) { return api('POST', isProd ? '/api/products/import' : '/api/earnings/import', undefined, txt); }).then(function (r) {
          toast(r.imported + ' importados' + (r.skipped ? ', ' + r.skipped + ' já existiam' : '') + (r.errors.length ? ', ' + r.errors.length + ' com erro (linha ' + r.errors[0].line + ': ' + r.errors[0].error + ')' : ''));
          return reload();
        });
      });
  }

  var SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.0/dist/umd/supabase.js';
  var SUPABASE_SRI = 'sha384-xPW3QHswsICVC2mW6BFNwMbhpLkbZ133fKOhxNx3QGGgAOJfL3O9t8r2aWn1aez6';
  function loadSupabase() {
    if (window.supabase) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = SUPABASE_JS; el.integrity = SUPABASE_SRI; el.crossOrigin = 'anonymous';
      el.onload = resolve;
      el.onerror = function () { reject(new Error('Não foi possível carregar o envio de arquivos. Verifique a conexão.')); };
      document.head.appendChild(el);
    });
  }
  /** Envia foto/vídeo. Com Supabase, vai direto do navegador para o Storage; sem ele, passa pelo servidor. */
  /** O Instagram só aceita foto em JPEG: PNG (ex.: print da tela) é convertido aqui antes de enviar. */
  function toJpeg(file) {
    if (file.type !== 'image/png') return Promise.resolve(file);
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        var x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0);
        c.toBlob(function (b) {
          if (!b) return reject(new Error('Não consegui converter a foto para JPEG.'));
          resolve(new File([b], file.name.replace(/\.png$/i, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.92);
      };
      img.onerror = function () { reject(new Error('Não consegui ler a foto.')); };
      // data: (e não blob:), que a política de segurança da página permite em imagens
      var rd = new FileReader();
      rd.onload = function () { img.src = rd.result; };
      rd.onerror = function () { reject(new Error('Não consegui ler a foto.')); };
      rd.readAsDataURL(file);
    });
  }
  function uploadFile(original) {
    return toJpeg(original).then(function (file) { return uploadRaw(file); });
  }
  function uploadRaw(file) {
    return api('POST', '/api/media/sign', { content_type: file.type, size: file.size }).then(function (s) {
      if (s.driver === 'local') {
        var fd = new FormData(); fd.append('file', file);
        return api('POST', '/api/queue/upload', undefined, fd);
      }
      return loadSupabase().then(function () {
        // um cliente só por página (vários geram aviso do Supabase e podem conflitar)
        var sb = uploadFile.sb && uploadFile.sbKey === s.supabase_url + s.anon_key ? uploadFile.sb
          : (uploadFile.sb = window.supabase.createClient(s.supabase_url, s.anon_key, { auth: { persistSession: false, autoRefreshToken: false } }));
        uploadFile.sbKey = s.supabase_url + s.anon_key;
        return sb.storage.from(s.bucket).uploadToSignedUrl(s.path, s.token, file, { contentType: file.type });
      }).then(function (r) {
        if (r.error) throw new Error(r.error.message || 'Falha no envio do arquivo.');
        return { url: s.public_url, media_type: s.media_type };
      });
    });
  }

  /* ---------- ações ---------- */
  var actions = {
    'toggle-auth': function () { state.authMode = state.authMode === 'login' ? 'register' : 'login'; render(); },
    'theme': function () {
      var next = THEMES[currentTheme()][2];
      setTheme(next);
      render();
      toast(THEMES[next][1] + (next === 'auto' ? ' (segue o sistema)' : ''));
    },
    'logout': function () { return api('POST', '/api/auth/logout').then(function () { state.user = null; render(); }); },
    'new-product': function () { productDialog(); },
    'import-products': function () { importDialog('products'); },
    'new-earning': function () { earningDialog(); },
    'import-earnings': function () { importDialog('earnings'); },
    'close-dlg': function () { dlg.close(); },
    'test-ig': function () { return api('POST', '/api/connections/instagram/test').then(function (r) { toast('Conexão ok' + (r.username ? ': @' + r.username : '')); }); },
    'disconnect-ig': function () { return api('DELETE', '/api/connections/instagram').then(reload).then(function () { toast('Instagram desconectado'); }); },
    'disconnect-sh': function () { return api('DELETE', '/api/connections/shopee').then(reload).then(function () { toast('Shopee desconectada'); }); },
    'disconnect-ml': function () { return api('DELETE', '/api/connections/mercadolivre').then(reload).then(function () { toast('Mercado Livre desconectado'); }); },
    'cp-parse': function () {
      var cp = state.cp; cp.text = $('#cp-text').value; cp.mk = $('#cp-mk').value;
      return api('POST', '/api/coupons/parse', { text: cp.text, marketplace: cp.mk }).then(function (r) { cp.parsed = r.items; render(); });
    },
    'cp-new': function () { var cp = state.cp; cp.mk = $('#cp-mk').value; cp.parsed = (cp.parsed || []).concat([{ marketplace: cp.mk, code: '', kind: 'percent', amount: null, min_purchase: null, max_discount: null, expires_on: '' }]); render(); },
    'cp-cancel': function () { state.cp.parsed = null; render(); },
    'cp-save': function () {
      var cp = state.cp;
      var items = cp.parsed.filter(function (c) { return !c._skip; }).map(function (c) { return Object.assign({}, c, { marketplace: c.marketplace || cp.mk, link: cp.link }); });
      if (!items.length) throw new Error('Marque pelo menos um cupom.');
      return api('POST', '/api/coupons', { items: items }).then(function (r) {
        toast((r.created ? r.created + ' cupom(ns) salvo(s)' : '') + (r.updated ? (r.created ? ' · ' : '') + r.updated + ' atualizado(s)' : ''));
        cp.parsed = null; cp.text = ''; return loadCoupons().then(render);
      });
    },
    'cp-clean': function () { return api('POST', '/api/coupons/clean').then(function (r) { toast(r.removed + ' vencido(s) apagado(s)'); return loadCoupons().then(render); }); },
    'cp-copy': function () { copyText(state.cp.msg.text); },
    'cp-wa': function () { var t = state.cp.msg.text; copyText(t); window.open(waLink(t), '_blank', 'noopener'); },
    'cp-tg': function () { return api('POST', '/api/coupons/send-telegram').then(function () { toast('Cupons enviados no Telegram'); }); },
    'dm-sync': function (t) {
      t.disabled = true; t.textContent = 'Buscando…';
      return api('POST', '/api/direct/sync').then(function (r) {
        toast(r.fresh ? r.fresh + ' comentário(s) novo(s)' + (r.sent ? ' · ' + r.sent + ' link(s) enviado(s)' : '') : 'Nenhum comentário novo');
        return loadDirect().then(render);
      }).catch(function (err) { return loadDirect().then(render).then(function () { throw err; }); });
    },
    'dm-defaults': function () {
      var d = state.dm.defaults || {};
      var f = $('#dm-form'); if (!f) return;
      f.keywords.value = (d.keywords || []).join(', '); f.template.value = d.template || '';
      toast('Padrão restaurado: toque em Salvar para manter');
    },
    'sh-top': function () { var g = state.g; g.top = true; g.q = ''; g.shopId = null; g.shopName = null; return garimpar(1); },
    'sh-shop-clear': function () { var g = state.g; g.shopId = null; g.shopName = null; render(); },
    'sh-sales': function (t) {
      t.disabled = true; t.textContent = 'Importando…';
      return api('POST', '/api/garimpo/shopee/sync-sales').then(function (r) {
        toast(r.created || r.updated ? r.created + ' venda(s) nova(s), ' + r.updated + ' atualizada(s)' + (r.removed ? ', ' + r.removed + ' cancelada(s)' : '') : 'Nenhuma venda nova da Shopee');
        return reload();
      }).catch(function (err) { return reload().then(function () { throw err; }); });
    },
    'auto-new': function () { autoDialog(null); },
    'auto-new-premium': function () { autoDialog(null, 'premium'); },
    'tg-find': function () {
      return api('GET', '/api/connections/telegram/chats').then(function (r) {
        state.tgChats = r.chats;
        if (!r.chats.length) toast('Não achei grupos ainda. Adicione o bot no grupo/canal, mande uma mensagem lá e tente de novo.');
        render();
      });
    },
    'tg-change': function () { return api('GET', '/api/connections/telegram/chats').then(function (r) { state.tgChats = r.chats; state.tg.ready = false; render(); }); },
    'disconnect-tg': function () {
      if (!confirm('Desconectar o Telegram? Os pilotos param de postar lá.')) return null;
      return api('DELETE', '/api/connections/telegram').then(function () { state.tgChats = null; toast('Telegram desconectado'); return reload(); });
    },
    'ml-authorize': function () { window.location.href = '/api/connections/mercadolivre/authorize'; },
    'g-more': function () { return garimpar(state.g.page + 1); },
    'g-all': function () {
      var g = state.g;
      g.results.forEach(function (p, i) { if (!p.saved_id) g.sel[i] = true; });
      render();
    },
    'g-save': function () {
      var g = state.g;
      var items = g.results.filter(function (p, i) { return g.sel[i] && !p.saved_id; });
      if (!items.length) throw new Error('Marque os produtos que quer salvar.');
      return api('POST', '/api/garimpo/save', { items: items }).then(function (r) {
        var ids = {};
        r.products.forEach(function (p) { if (p.external_id) ids[p.external_id] = p.id; });
        g.results.forEach(function (p) { if (ids[p.external_id]) p.saved_id = ids[p.external_id]; });
        g.sel = {};
        toast(r.saved + ' salvo' + (r.saved === 1 ? '' : 's') + (r.skipped ? ', ' + r.skipped + ' já existiam' : '') + (r.errors.length ? ', ' + r.errors.length + ' com erro: ' + r.errors[0].error : ''));
        return reload();
      });
    },
  };

  /** Confere o preço na loja antes de levar para a fila, se ele tiver mais de 6 horas. Falha não impede. */
  function freshBeforeQueue(p) {
    if (!p || !p.external_id || !mktReady(p.marketplace) || staleHours(p) < 6) return Promise.resolve(null);
    return api('POST', '/api/products/' + p.id + '/refresh').then(function (r) {
      return r.previous_price !== r.product.price ? 'Preço atualizado: ' + brl(r.previous_price) + ' → ' + brl(r.product.price) + '. ' : null;
    }).catch(function (e) { return 'Não consegui conferir o preço (' + e.message + '). '; });
  }

  /* ---------- Cadastrar por links (Shopee sem API: prévia do link; Mercado Livre: dados completos) ---------- */
  var links = null; // { text, items: [...], busy, saving }

  function renderLinks() {
    if (!links) return;
    var it = links.items;
    var body;
    if (!it) {
      body = '<p class="hint">Cole os links dos produtos, um por linha (até 20). Vale link curto de afiliado da Shopee (s.shopee.com.br/…) e link do Mercado Livre. O link colado fica salvo como o seu link de afiliado.</p>' +
        '<div class="sheetbox"><b>Shopee: planilha "Obter link em massa"</b><p class="hint">No painel de afiliados da Shopee, gere os links em massa e baixe o arquivo (BatchProductLinks…csv). Ele já traz preço, comissão, vendas e o seu link de afiliado; a foto o Garimpo busca sozinho.</p>' +
        '<input id="links-sheet" class="file-input" type="file" accept=".csv,text/csv"' + (links.busy ? ' disabled' : '') + ' aria-label="Planilha da Shopee"></div>' +
        '<p class="hint" style="text-align:center">ou cole os links</p>' +
        '<textarea id="links-text" placeholder="https://s.shopee.com.br/…&#10;https://mercadolivre.com/sec/…" aria-label="Links dos produtos">' + esc(links.text || '') + '</textarea>' +
        '<div class="row end"><button type="button" class="btn" data-act="links-close">Cancelar</button><button type="button" class="btn primary" data-act="links-fetch"' + (links.busy ? ' disabled' : '') + '>' + (links.busy ? 'Buscando…' : 'Buscar produtos') + '</button></div>';
    } else {
      var ok = it.filter(function (x) { return !x.error && !x.saved_id; });
      var needPrice = ok.some(function (x) { return x.marketplace === 'SH'; });
      var fromSheet = ok.length && ok.every(function (x) { return x.source === 'planilha'; });
      body = (needPrice ? '<p class="hint">' + (fromSheet
          ? 'Preço e comissão vieram da planilha. Use <b>Ver na Shopee ↗</b> para conferir o preço atual e preencher o <b>preço "de"</b> dos que estão com desconto.'
          : 'A prévia da Shopee não informa o preço: use <b>Ver na Shopee ↗</b> e preencha <b>preço</b>, <b>preço "de"</b> (se tiver desconto) e a <b>comissão</b> que aparece no seu painel de afiliados.') + '</p>' +
          '<div class="row"><label class="field" style="flex:0 0 auto"><span class="hint">Comissão para todos da Shopee (%)</span><input id="links-com-all" type="text" inputmode="decimal" style="width:110px" placeholder="Ex.: 8"></label><button type="button" class="btn small" data-act="links-com-all">Aplicar</button></div>' : '') +
        '<div class="linklist">' + it.map(function (x, i) {
          var img = safeUrl(x.image_url);
          var head = '<div class="linkhead">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="noimg"></span>') +
            '<div class="grow"><div class="meta">' + (x.marketplace ? mktTag(x.marketplace) : '') +
            (x.source === 'api' ? '<span class="tag free">dados da loja</span>' : x.source === 'planilha' ? '<span class="tag free">planilha da Shopee</span>' : x.source ? '<span class="tag plain">prévia do link</span>' : '') +
            (x.sales_k ? '<span class="hint">' + (x.sales_k >= 1 ? x.sales_k + ' mil' : Math.round(x.sales_k * 1000)) + ' vendidos</span>' : '') +
            (x.shop ? '<span class="hint">· ' + esc(x.shop) + '</span>' : '') +
            // abre a página do produto (não o link de afiliado, para não gerar clique na própria conta)
            (safeUrl(x.product_url || x.link) ? '<a class="seeprod" href="' + esc(safeUrl(x.product_url || x.link)) + '" target="_blank" rel="noopener noreferrer">Ver na ' + (x.marketplace === 'ML' ? 'loja' : 'Shopee') + ' ↗</a>' : '') +
            (x.saved_id ? '<span class="pill posted">Já cadastrado</span>' : '') + '</div>' +
            (x.error ? '<p class="err small">' + esc(x.error) + '</p><p class="hint">' + esc(x.link) + '</p>' : '<input type="text" data-li="' + i + '" data-lf="title" value="' + esc(x.title || '') + '" aria-label="Nome do produto">') + '</div></div>';
          if (x.error || x.saved_id) return '<div class="linkitem off">' + head + '</div>';
          var num = function (f, label, ph) {
            return '<label class="field"><span class="hint">' + label + '</span><input type="text" inputmode="decimal" data-li="' + i + '" data-lf="' + f + '" value="' + esc(x[f] == null ? '' : String(x[f]).replace('.', ',')) + '" placeholder="' + ph + '"></label>';
          };
          return '<div class="linkitem">' + head + '<div class="cols4">' + num('price', 'Preço (R$)', 'o menor') + num('price_max', 'Até (R$)', 'se tiver kits') + num('original_price', 'Preço "de" (R$)', 'opcional') + num('commission_pct', 'Comissão (%)', 'Ex.: 8') + '</div></div>';
        }).join('') + '</div>' +
        '<p class="err" id="links-err" role="alert"></p>' +
        '<div class="row end"><button type="button" class="btn" data-act="links-back">Colar outros links</button>' +
        '<button type="button" class="btn primary" data-act="links-save"' + (ok.length && !links.saving ? '' : ' disabled') + '>' + (links.saving ? 'Salvando…' : 'Salvar ' + ok.length + ' produto' + (ok.length === 1 ? '' : 's')) + '</button></div>';
    }
    dlg.innerHTML = '<h2>Cadastrar por links</h2><div class="stack" style="display:flex;flex-direction:column;gap:10px">' + body + '</div>';
  }

  /** "64,50", "1.234,56" ou "64.50" -> número (null se vazio/inválido). */
  function linkNum(v) {
    var s = String(v == null ? '' : v).replace(/[R$\s%]/g, '');
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  Object.assign(actions, {
    'links-open': function () { links = { text: '' }; renderLinks(); if (!dlg.open) dlg.showModal(); var ta = $('#links-text'); if (ta) ta.focus(); },
    'links-close': function () { links = null; dlg.close(); },
    'links-back': function () { links.items = null; renderLinks(); },
    'links-fetch': function () {
      links.text = ($('#links-text') || {}).value || '';
      var list = links.text.split(/\s+/).filter(function (s) { return /^https?:\/\//i.test(s); });
      if (!list.length) throw new Error('Cole pelo menos um link (começando com https://).');
      links.busy = true; renderLinks();
      return api('POST', '/api/garimpo/from-links', { links: list }).then(function (r) { links.items = r.items; })
        .finally(function () { if (links) { links.busy = false; renderLinks(); } });
    },
    'links-com-all': function () {
      var v = ($('#links-com-all') || {}).value;
      if (linkNum(v) == null) throw new Error('Digite a comissão, por exemplo 8.');
      links.items.forEach(function (x) { if (x.marketplace === 'SH' && !x.error && !x.saved_id) x.commission_pct = linkNum(v); });
      renderLinks();
    },
    'links-save': function () {
      var ok = links.items.filter(function (x) { return !x.error && !x.saved_id; });
      var missing = ok.filter(function (x) { return !(Number(x.price) > 0); });
      if (missing.length) { var el = $('#links-err'); if (el) el.textContent = 'Falta o preço de ' + missing.length + ' produto(s).'; return null; }
      links.saving = true; renderLinks();
      return api('POST', '/api/garimpo/save', { items: ok }).then(function (r) {
        var dupMsg = (r.duplicates || []).map(function (x) { return '"' + (x.title || '').slice(0, 40) + '" já estava cadastrado' + (x.existing_title && x.existing_title !== x.title ? ' (como "' + x.existing_title.slice(0, 40) + '")' : ''); }).join('; ');
        toast(r.saved + ' cadastrado' + (r.saved === 1 ? '' : 's') + (dupMsg ? '. ' + dupMsg : r.skipped ? ', ' + r.skipped + ' já existiam' : '') + (r.errors.length ? ', ' + r.errors.length + ' com erro: ' + r.errors[0].error : ''));
        links = null; dlg.close();
        state.tab = 'descobrir';
        return reload();
      }).finally(function () { if (links) { links.saving = false; renderLinks(); } });
    },
  });

  /* ---------- Postar agora: direto do produto, sem fila e sem agendador ---------- */
  // { products, product, group, channel, caption, media: [{type,url}], uploads, busy, sending, status, permalink, note, error, waOpened, customMedia }
  var post = null;
  var MAX_MEDIA = 10;

  /** Baixa um arquivo gerado no navegador (alternativa quando não dá para copiar a imagem). */
  function downloadFile(file) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name || 'achadinho.jpg';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function waLink(text) { return 'https://wa.me/?text=' + encodeURIComponent(text); }
  function copyText(text) {
    try { return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; }); } catch (_) { return Promise.resolve(false); }
  }

  /** Abre o Postar agora para um produto ou para vários (carrossel com um texto numerado). */
  function openPost(arg) {
    var list = (Array.isArray(arg) ? arg : [arg]).filter(Boolean);
    if (!list.length) return null;
    post = { products: list, product: list[0], group: list.length > 1, channel: state.conn && state.conn.connected ? 'instagram' : 'whatsapp', caption: '', media: [], uploads: [], busy: true, tone: prefGet('tone', 'anninha') };
    renderPost();
    if (!dlg.open) dlg.showModal();
    return (post.group ? Promise.resolve(null) : freshBeforeQueue(list[0])).then(function (msg) { if (post) post.note = msg; return loadPreview(false); });
  }

  function loadPreview(ai) {
    if (!post) return null;
    post.busy = true; post.error = null; renderPost();
    var req = post.group
      ? api('POST', '/api/queue/preview-group', { product_ids: post.products.map(function (p) { return p.id; }), channel: post.channel, ai: ai })
      : api('POST', '/api/queue/preview', { product_id: post.product.id, channel: post.channel, ai: ai, tone: post.tone });
    return req.then(function (r) {
      if (!post) return;
      post.caption = r.caption;
      if (!post.customMedia) {
        post.media = post.group ? (r.media_items || []).slice(0, MAX_MEDIA)
          : (r.media_type !== 'none' && r.media_url ? [{ type: r.media_type, url: r.media_url }] : []);
      }
      if (r.warning) post.note = (post.note || '') + r.warning;
    }).catch(function (e) { if (post) post.error = e.message; }).finally(function () { if (post) { post.busy = false; renderPost(); } });
  }

  /** Tudo o que pode entrar no post: fotos de cada produto (galeria da loja), vídeo cadastrado e o que foi enviado agora. */
  function mediaPool() {
    var seen = {}, out = [];
    function add(type, url) { if (url && !seen[url]) { seen[url] = 1; out.push({ type: type, url: url }); } }
    post.products.forEach(function (p) {
      ((p.images && p.images.length) ? p.images : [p.image_url]).forEach(function (u) { add('image', u); });
      add('video', p.video_url);
    });
    post.uploads.forEach(function (m) { add(m.type, m.url); });
    return out;
  }
  function mediaIndex(url) { for (var i = 0; i < post.media.length; i++) if (post.media[i].url === url) return i; return -1; }
  function toggleMedia(type, url) {
    var i = mediaIndex(url);
    if (i >= 0) post.media.splice(i, 1);
    else if (post.media.length >= MAX_MEDIA) throw new Error('O Instagram aceita no máximo 10 fotos ou vídeos por post.');
    else post.media.push({ type: type, url: url });
    post.customMedia = true;
    renderPost();
  }

  function renderPost() {
    if (!post) return;
    var ig = post.channel === 'instagram';
    var igOk = Boolean(state.conn && state.conn.connected);
    var p = post.product;
    var locked = post.busy || Boolean(post.status);
    var sel = post.media;
    var nVideo = sel.filter(function (m) { return m.type === 'video'; }).length;
    var summary = !sel.length ? 'Nada marcado: o Instagram exige pelo menos 1 foto ou vídeo.'
      : sel.length === 1 ? (nVideo ? 'Reels com 1 vídeo' : 'Post com 1 foto')
      : 'Carrossel com ' + sel.length + ' itens' + (nVideo ? ' (' + nVideo + ' vídeo' + (nVideo > 1 ? 's' : '') + ')' : '');
    // galeria: toque marca/desmarca; a ordem dos toques é a ordem no carrossel
    var media = ig ? '<div class="mediabox"><div class="row"><b>Fotos e vídeos</b><span class="hint">' + summary + '</span><span class="grow"></span>' +
      (locked || (post.cover && post.cover.open) ? '' : '<button type="button" class="btn small primary" data-act="cover-open">✨ ' + (post.cover && post.cover.url ? 'Editar capa' : 'Criar capa') + '</button>') + '</div>' +
      (post.cover && post.cover.open && !locked ? coverPanel() : '') +
      '<p class="hint">Toque para marcar até 10. A ordem dos toques é a ordem no post; 2 ou mais viram carrossel.</p>' +
      '<div class="gallery wrap" role="group" aria-label="Escolher fotos e vídeos">' + mediaPool().map(function (m, k) {
        var i = mediaIndex(m.url), src = esc(safeUrl(m.url));
        return '<button type="button" class="gpic' + (i >= 0 ? ' on' : '') + '" data-pmedia="' + esc(m.url) + '" data-ptype="' + m.type + '"' + (locked ? ' disabled' : '') + ' aria-pressed="' + (i >= 0) + '" aria-label="' + (m.type === 'video' ? 'Vídeo ' : 'Foto ') + (k + 1) + '">' +
          (m.type === 'video' ? '<video src="' + src + '" muted playsinline preload="metadata"></video><span class="vtag">▶</span>' : '<img src="' + src + '" alt="" loading="lazy" referrerpolicy="no-referrer">') +
          (i >= 0 ? '<span class="ord">' + (i + 1) + '</span>' : '') + '</button>';
      }).join('') +
      (locked ? '' : '<label class="gpic add" for="post-up" title="Enviar fotos ou vídeos do aparelho">+<small>foto/vídeo</small></label><input id="post-up" class="file-input" type="file" accept="image/jpeg,image/png,video/mp4" data-pupload="1" multiple hidden>') + '</div>' +
      (post.products.some(function (x) { return x.has_video; }) && !nVideo ? '<p class="hint">🎬 O anúncio no Mercado Livre tem vídeo, mas a API não libera o arquivo. Para postar vídeo, grave ou baixe e envie em "+ foto/vídeo" (MP4).</p>' : '') +
      '</div>' : waMediaSection(locked);
    var actions;
    if (post.status === 'posted') {
      actions = '<p class="ok">' + (ig ? 'Publicado no Instagram!' + (post.permalink ? ' <a href="' + esc(safeUrl(post.permalink)) + '" target="_blank" rel="noopener noreferrer">Ver o post</a>' : '') : 'Registrado no histórico como postado.') + '</p>' +
        '<div class="row end"><button class="btn primary" data-act="post-close">Fechar</button></div>';
    } else if (post.status === 'processing') {
      actions = '<p class="hint">O Instagram está processando o vídeo. Deixe esta janela aberta: confiro a cada 5 segundos e publico assim que ficar pronto. Se fechar, o post continua na Fila e você confere por lá.</p>' +
        '<div class="row end"><button class="btn" data-act="post-close">Fechar</button></div>';
    } else if (ig) {
      actions = (igOk ? '' : '<p class="err">Conecte o Instagram na aba Conexões para publicar daqui. Enquanto isso, copie o texto ou use o WhatsApp.</p>') +
        '<div class="row end"><button class="btn" data-act="post-close">Cancelar</button><button class="btn" data-act="post-copy">Copiar texto</button>' +
        '<button class="btn primary" data-act="post-ig"' + (igOk && !post.busy ? '' : ' disabled') + '>' + (post.sending ? 'Publicando…' : 'Publicar no Instagram') + '</button></div>';
    } else {
      var waImg = waPhotoUrl();
      var dis = post.busy ? ' disabled' : '';
      actions = (post.waGuide
          ? '<ol class="steps waguide"><li><b>Foto copiada!</b> Abra o grupo no WhatsApp e cole com <b>Ctrl+V</b>: a foto aparece.</li><li>Clique em <b>Copiar texto</b> aqui e cole na <b>legenda</b> da foto.</li><li>Envie e volte para tocar em <b>Já enviei</b>.</li></ol>'
          : post.waOpened ? '<p class="hint">Escolha o grupo no WhatsApp e envie. Depois toque em "Já enviei" para guardar no histórico.</p>' : '') +
        '<div class="row end wa-actions"><button class="btn" data-act="post-close">Cancelar</button>' +
        (post.waGuide ? '<button class="btn" data-act="post-copy">Copiar texto</button><a class="btn" href="https://web.whatsapp.com/" target="_blank" rel="noopener noreferrer">Abrir WhatsApp Web</a>'
          : '<button class="btn" data-act="post-wa"' + dis + '>' + (waImg ? 'Só o texto' : 'Abrir no WhatsApp') + '</button>') +
        (waImg ? '<button class="btn' + (post.waOpened ? '' : ' primary') + '" data-act="post-wa-share"' + dis + '>' + (post.waGuide ? 'Copiar a foto de novo' : '📷 Compartilhar com foto') + '</button>' : '') +
        (post.waOpened ? '<button class="btn primary" data-act="post-wa-done"' + dis + '>Já enviei</button>' : '') + '</div>';
    }
    var noLink = post.products.filter(function (x) { return !x.affiliate_url; }).length;
    var head = post.group
      ? '<h2>Postar ' + post.products.length + ' produtos juntos</h2><ol class="hint plist">' + post.products.map(function (x) { return '<li>' + esc(x.title) + ' · ' + brl(x.price) + '</li>'; }).join('') + '</ol>'
      : '<h2>Postar agora</h2><p class="hint">' + esc(p.title) + ' · ' + brl(p.price) + '</p>';
    dlg.innerHTML = head +
      '<div class="seg" role="group" aria-label="Canal" style="margin:10px 0"><button type="button" data-pchan="instagram" aria-pressed="' + ig + '"' + (locked ? ' disabled' : '') + '>Instagram</button><button type="button" data-pchan="whatsapp" aria-pressed="' + !ig + '"' + (locked ? ' disabled' : '') + '>WhatsApp</button></div>' +
      '<div style="display:flex;flex-direction:column;gap:10px">' +
      (post.note ? '<p class="hint">' + esc(post.note) + '</p>' : '') +
      (noLink ? '<p class="err small">' + (post.group ? noLink + ' produto(s) sem link de afiliado' : 'Este produto não tem link de afiliado') + ': o texto vai com um espaço reservado. Cole o link em Editar antes de postar.</p>' : '') +
      media +
      '<textarea id="post-cap" aria-label="Texto do post"' + (locked ? ' readonly' : '') + '>' + esc(post.busy && !post.caption ? 'Preparando o texto…' : post.caption) + '</textarea>' +
      (ig ? '<p class="hint"><span id="post-cnt">' + post.caption.length + '</span>/2200 caracteres</p>' : '') +
      (post.status ? '' : '<div class="row">' + (post.group ? '' : '<div class="seg" role="group" aria-label="Tom do texto"><button type="button" data-ptone="anninha" aria-pressed="' + (post.tone !== 'premium') + '"' + (post.busy ? ' disabled' : '') + '>Tom Anninha</button><button type="button" data-ptone="premium" aria-pressed="' + (post.tone === 'premium') + '"' + (post.busy ? ' disabled' : '') + '>💎 Premium</button></div>') + '<button class="btn small" data-act="post-regen"' + (post.busy ? ' disabled' : '') + '>Refazer texto</button>' +
        (state.ai ? '<button class="btn small" data-act="post-regen-ai"' + (post.busy ? ' disabled' : '') + '>Refazer com IA</button>' : '') + '</div>') +
      '<p class="err" role="alert">' + esc(post.error || '') + '</p>' + actions + '</div>';
    if (post.cover && post.cover.open) drawCover();
  }

  /* ---------- WhatsApp com foto: a prévia de link curto nem sempre aparece; a foto sempre ---------- */
  /** Foto que vai junto no WhatsApp: a escolhida, senão a 1ª marcada (capa, se houver), senão a do produto. "none" = sem foto. */
  function waPhotoUrl() {
    if (post.waPhoto === 'none') return null;
    if (post.waPhoto) return post.waPhoto;
    var img = post.media.filter(function (m) { return m.type === 'image'; })[0];
    return img ? img.url : (post.product.image_url || null);
  }
  function waMediaSection(locked) {
    var cur = waPhotoUrl();
    var pics = mediaPool().filter(function (m) { return m.type === 'image'; });
    if (cur && !pics.some(function (m) { return m.url === cur; })) pics.unshift({ type: 'image', url: cur });
    if (cur && !locked) prepareWaImage(cur); // adianta o preparo: o compartilhar precisa ser imediato após o toque
    return '<div class="mediabox"><div class="row"><b>Foto que vai junto</b><span class="hint">' + (cur ? 'chama muito mais atenção que a prévia do link' : 'sem foto: vai só o texto') + '</span><span class="grow"></span>' +
      (locked || (post.cover && post.cover.open) ? '' : '<button type="button" class="btn small primary" data-act="cover-open">✨ ' + (post.cover && post.cover.url ? 'Editar capa' : 'Criar capa') + '</button>') + '</div>' +
      (post.cover && post.cover.open && !locked ? coverPanel() : '') +
      '<div class="gallery wrap" role="group" aria-label="Escolher a foto">' + pics.map(function (m, k) {
        var on = m.url === cur;
        return '<button type="button" class="gpic' + (on ? ' on' : '') + '" data-pwa="' + esc(m.url) + '"' + (locked ? ' disabled' : '') + ' aria-pressed="' + on + '" aria-label="Foto ' + (k + 1) + '"><img src="' + esc(safeUrl(m.url)) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' + (on ? '<span class="ord">✓</span>' : '') + '</button>';
      }).join('') +
      (locked ? '' : '<button type="button" class="gpic add" data-pwa="none" title="Mandar só o texto">✕<small>sem foto</small></button>' +
        '<label class="gpic add" for="post-up" title="Enviar uma foto do aparelho">+<small>foto</small></label><input id="post-up" class="file-input" type="file" accept="image/jpeg,image/png" data-pupload="1" hidden>') + '</div></div>';
  }

  /** Carrega a foto pelo repasse (mesmo endereço do app) e re-codifica em JPEG (compartilhar) e PNG (copiar). */
  var waPreps = {}; // url -> preparo da foto (reaproveitado entre a janela de postar e a Fila)
  function prepareWaImage(url) {
    if (waPreps[url]) { if (post) post.waPrep = waPreps[url]; return waPreps[url].promise; }
    var prep = { url: url, value: null };
    prep.promise = new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Não consegui carregar a foto.')); };
      img.src = /^\//.test(url) ? url : '/api/media/proxy?url=' + encodeURIComponent(url);
    }).then(function (img) {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0);
      var blob = function (type) { return new Promise(function (res, rej) { c.toBlob(function (b) { if (b) res(b); else rej(new Error('Falha ao preparar a foto.')); }, type, 0.92); }); };
      return Promise.all([blob('image/jpeg'), blob('image/png')]).then(function (b) {
        prep.value = { file: new File([b[0]], 'achadinho.jpg', { type: 'image/jpeg' }), png: b[1] };
        return prep.value;
      });
    });
    prep.promise.catch(function () { delete waPreps[url]; });
    waPreps[url] = prep;
    if (post) post.waPrep = prep;
    return prep.promise;
  }

  /**
   * Fila: compartilha um item do WhatsApp com a foto do produto. No celular abre o menu de compartilhar
   * (foto + texto) e, ao concluir, marca como postado. No computador copia a foto (ou baixa) e o texto vai pelo "Copiar texto".
   */
  function shareQueueWa(q) {
    if (!q) return null;
    var text = capValue(q.id) || q.caption;
    var url = q.product_image;
    if (!url) { copyText(text); window.open(waLink(text), '_blank', 'noopener'); return null; }
    var prep = waPreps[url];
    if (!prep || !prep.value) {
      toast('Preparando a foto…');
      return prepareWaImage(url).then(function () { toast('Foto pronta: toque de novo em "Compartilhar com foto".'); });
    }
    var v = prep.value;
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [v.file] })) {
      copyText(text);
      return navigator.share({ files: [v.file], text: text }).then(function () {
        return api('POST', '/api/queue/' + q.id + '/mark-posted').then(function () { toast('Enviado e marcado como postado'); return reload(); });
      }, function (e) { if (e && e.name === 'AbortError') return null; throw new Error('Não consegui abrir o compartilhar: ' + e.message); });
    }
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': v.png })]).then(function () {
        toast('Foto copiada! Cole no WhatsApp (Ctrl+V), depois use "Copiar texto" e cole na legenda. No fim, "Marcar como postado".');
      }, function () { downloadFile(v.file); toast('Baixei a foto: anexe no WhatsApp e cole o texto na legenda.'); });
    }
    downloadFile(v.file);
    toast('Baixei a foto: anexe no WhatsApp e cole o texto na legenda.');
    return null;
  }

  /* ---------- capa (1ª imagem do post), desenhada por cover.js ---------- */
  var DEFAULT_COLOR = '#E8457A';
  function coverDefaultTitle(tpl) {
    return tpl === 'lista' ? post.products.length + ' achadinhos' : tpl === 'achadinho' ? 'Achadinho' : tpl === 'relampago' ? 'Baixou o preço!' : tpl === 'minimal' ? 'Achado do dia' : tpl === 'premium' ? 'Seleção premium' : 'Achadinho do dia';
  }
  /** Foto usada nos modelos de 1 produto: a escolhida, senão a 1ª marcada no post (que não seja a capa), senão a do produto. */
  function coverPhoto() {
    var cv = post.cover;
    if (cv.photo) return cv.photo;
    var first = post.media.filter(function (m) { return m.type === 'image' && m.url !== cv.url; })[0];
    return first ? first.url : post.product.image_url;
  }
  var COVER_TPLS = [['premium', '💎 Premium'], ['oferta', 'Oferta'], ['achadinho', 'Achadinho'], ['foto', 'Foto em destaque'], ['relampago', 'Baixou o preço'], ['minimal', 'Clean']];
  var COVER_FORMATS = [['feed', 'Feed 4:5'], ['story', 'Stories 9:16'], ['square', 'Quadrado 1:1']];
  var COVER_CTAS = ['LINK NA BIO', 'LINK NOS STORIES', 'LINK NO GRUPO', 'COMENTE "EU QUERO"', 'CLIQUE NO LINK'];
  var COVER_COLORS = ['#E8457A', '#7C3AED', '#2563EB', '#0E6B52', '#F97316', '#DC2626', '#111111', '#C8A24A'];
  var COVER_RADIUS = { oferta: 44, achadinho: 60, lista: 36, relampago: 48, foto: 0, minimal: 0, premium: 48 };
  var COVER_SHAPES = [['auto', 'Automática'], ['free', 'Solta'], ['arch', 'Arco'], ['round', 'Arredondada']];
  function coverRadius(cv) { return cv.radius != null && cv.radius !== '' ? Number(cv.radius) : COVER_RADIUS[cv.tpl] || 0; }
  function coverPanel() {
    var cv = post.cover;
    var tpls = post.group ? [['lista', 'Top ' + post.products.length]].concat(COVER_TPLS) : COVER_TPLS;
    var photos = post.group || cv.tpl === 'lista' ? [] : mediaPool().filter(function (m) { return m.type === 'image' && m.url !== cv.url; });
    var cur = coverPhoto();
    var fmt = cv.format || 'feed';
    var opts = cv.opts || {};
    var seg = function (label, list, key, curV) {
      return '<div class="field"><label>' + label + '</label><div class="seg wrapseg" role="group" aria-label="' + label + '">' + list.map(function (t) {
        return '<button type="button" data-' + key + '="' + t[0] + '" aria-pressed="' + (curV === t[0]) + '">' + t[1] + '</button>';
      }).join('') + '</div></div>';
    };
    return '<div class="coverbox"><div class="coverprev"><canvas id="cover-canvas" class="fmt-' + fmt + '" width="1080" height="1350" aria-label="Prévia da capa"></canvas>' +
      '<button type="button" class="btn small" data-act="cover-download"' + (cv.busy ? ' disabled' : '') + '>⬇ Baixar imagem</button></div><div class="coverctl">' +
      seg('Modelo', tpls, 'ctpl', cv.tpl) + seg('Formato', COVER_FORMATS, 'cfmt', fmt) +
      (cv.tpl === 'premium' ? seg('Moldura da foto', COVER_SHAPES, 'cshape', cv.shape || 'auto') : '') +
      (cv.tpl !== 'premium' || cv.shape === 'round' ? '<div class="field"><label for="cover-radius">Arredondar cantos <span class="hint" id="cover-radius-v">' + coverRadius(cv) + '</span></label>' +
        '<div class="row"><input id="cover-radius" type="range" min="0" max="200" step="2" value="' + coverRadius(cv) + '" style="flex:1">' +
        '<button type="button" class="btn small ghost" data-act="cover-radius-reset">Padrão</button></div></div>' : '') +
      '<div class="field"><label for="cover-title">Título</label><input id="cover-title" type="text" maxlength="40" value="' + esc(cv.title) + '" placeholder="(sem título)"></div>' +
      (photos.length > 1 ? '<div class="field"><label>Foto do produto</label><div class="gallery">' + photos.map(function (m) {
        return '<button type="button" class="gpic' + (cur === m.url ? ' on' : '') + '" data-cphoto="' + esc(m.url) + '"><img src="' + esc(safeUrl(m.url)) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></button>';
      }).join('') + '</div></div>' : '') +
      '<div class="field"><label for="cover-cta">Chamada no rodapé</label><select id="cover-cta">' + COVER_CTAS.map(function (c) { return '<option' + ((cv.cta || 'LINK NA BIO') === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Mostrar</label><div class="row"><label class="check"><input type="checkbox" id="cover-opt-off"' + (opts.off !== false ? ' checked' : '') + '> Desconto e preço "de"</label>' +
      '<label class="check"><input type="checkbox" id="cover-opt-seals"' + (opts.seals !== false ? ' checked' : '') + '> Selos (frete grátis, loja oficial, ranking)</label></div></div>' +
      '<div class="field"><label>Cor da marca</label><div class="swatches">' + COVER_COLORS.map(function (c) {
        return '<button type="button" class="sw' + (String(cv.color).toLowerCase() === c.toLowerCase() ? ' on' : '') + '" data-ccolor="' + c + '" style="background:' + c + '" aria-label="Cor ' + c + '"></button>';
      }).join('') + '<input id="cover-color" type="color" value="' + esc(cv.color) + '" aria-label="Outra cor"></div></div>' +
      '<div class="field"><label for="cover-handle">Seu @ no rodapé</label><input id="cover-handle" type="text" maxlength="31" autocomplete="off" value="' + esc(cv.handle) + '" placeholder="seuperfil"></div>' +
      '<label class="pick"><input type="checkbox" id="cover-save"' + (cv.saveDefault ? ' checked' : '') + '> Usar esta cor e este @ nas próximas capas</label>' +
      (fmt === 'story' ? '<p class="hint">Stories: baixe a imagem e poste pelo app do Instagram, colocando o adesivo de link no espaço pontilhado.</p>' : '') +
      '<div class="row end"><button type="button" class="btn small" data-act="cover-close">Fechar</button>' +
      (fmt === 'story' ? '' : '<button type="button" class="btn small primary" data-act="cover-use"' + (cv.busy ? ' disabled' : '') + '>' + (cv.busy ? 'Gerando…' : cv.url ? 'Atualizar capa' : 'Usar como 1ª imagem') + '</button>') + '</div></div></div>';
  }
  var coverImgs = {};
  function coverImage(url) { if (!url) return Promise.resolve(null); return coverImgs[url] || (coverImgs[url] = window.GarimpoCover.loadImage(url)); }
  /** Redesenha a prévia (as chamadas antigas que terminarem depois de uma nova são ignoradas). */
  function drawCover() {
    var cv = post && post.cover;
    if (!cv || !cv.open || !window.GarimpoCover) return null;
    var seq = cv.seq = (cv.seq || 0) + 1;
    var urls = cv.tpl === 'lista' ? post.products.map(function (p) { return (p.images && p.images[0]) || p.image_url; }) : [coverPhoto()];
    return Promise.all([window.GarimpoCover.fontsReady(), Promise.all(urls.map(coverImage))]).then(function (r) {
      var canvas = $('#cover-canvas');
      if (!canvas || !post || !post.cover || post.cover.seq !== seq) return;
      window.GarimpoCover.render(canvas, { template: cv.tpl, format: cv.format || 'feed', title: cv.title, color: cv.color, handle: cv.handle, cta: cv.cta, opts: cv.opts, shape: cv.shape, radius: cv.radius, products: post.products, images: r[1] });
    });
  }
  var coverRaf = 0;
  function drawCoverSoon() { cancelAnimationFrame(coverRaf); coverRaf = requestAnimationFrame(drawCover); }

  /** Janela com o histórico de preço do produto: gráfico de linha + últimas conferências. */
  function showHistory(p) {
    if (!p) return null;
    return api('GET', '/api/products/' + p.id + '/history').then(function (r) {
      var h = r.history;
      var W = 520, H = 170, L = 56, R = 10, T = 12, B = 26;
      var prices = h.map(function (x) { return x.price; });
      var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
      var pad = (max - min) * 0.15 || max * 0.05 || 1; var lo = Math.max(0, min - pad), hi = max + pad;
      var t0 = new Date(h[0].checked_at).getTime(), t1 = new Date(h[h.length - 1].checked_at).getTime();
      var x = function (t) { return L + (t1 === t0 ? (W - L - R) / 2 : (W - L - R) * (t - t0) / (t1 - t0)); };
      var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
      var pts = h.map(function (e) { return x(new Date(e.checked_at).getTime()) + ',' + y(e.price); }).join(' ');
      var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Histórico de preço">' +
        [hi, (hi + lo) / 2, lo].map(function (v) { return '<line class="grid-l" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + brl(v).replace(/\s/g, ' ') + '</text>'; }).join('') +
        '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
        h.map(function (e, i) { return '<circle cx="' + x(new Date(e.checked_at).getTime()) + '" cy="' + y(e.price) + '" r="' + (i === h.length - 1 ? 4.5 : 3) + '" fill="' + (i === h.length - 1 ? 'var(--gold)' : 'var(--accent)') + '"><title>' + fmtWhen(e.checked_at) + ': ' + brl(e.price) + '</title></circle>'; }).join('') +
        '<text x="' + L + '" y="' + (H - 6) + '">' + new Date(t0).toLocaleDateString('pt-BR') + '</text><text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + new Date(t1).toLocaleDateString('pt-BR') + '</text></svg>';
      var rows = h.slice(-10).reverse().map(function (e) {
        return '<tr><td class="num">' + fmtWhen(e.checked_at) + '</td><td class="r num">' + brl(e.price) + '</td><td class="r num">' + (e.original_price ? brl(e.original_price) : '—') + '</td></tr>';
      }).join('');
      dlg.innerHTML = '<h2>Histórico de preço</h2><p class="hint">' + esc(p.title) + '</p>' +
        '<div class="kpis" style="margin:12px 0"><div class="kpi"><span>Agora</span><b class="num">' + brl(p.price) + '</b></div><div class="kpi"><span>Menor</span><b class="num">' + brl(min) + '</b></div><div class="kpi"><span>Maior</span><b class="num">' + brl(max) + '</b></div><div class="kpi"><span>Conferências</span><b class="num">' + h.length + '</b></div></div>' +
        svg + '<div class="tablewrap" style="margin-top:10px"><table><thead><tr><th>Quando</th><th class="r">Preço</th><th class="r">Preço "de"</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="row end" style="margin-top:12px"><button class="btn primary" data-act="close-dlg">Fechar</button></div>';
      if (!dlg.open) dlg.showModal();
    });
  }

  /** Reels/carrossel com vídeo: confere a cada 15 s, por até 10 minutos, enquanto a janela estiver aberta (o servidor ainda espaça para 1 min). */
  function pollPost(id, tries) {
    setTimeout(function () {
      if (!post || post.itemId !== id || post.status !== 'processing') return;
      api('POST', '/api/queue/' + id + '/check').then(function (r) {
        if (!post || post.itemId !== id) return;
        if (r.item.status === 'posted') { post.status = 'posted'; post.permalink = r.item.permalink; toast('Publicado no Instagram'); renderPost(); }
        else if (r.item.status === 'failed') { post.status = null; post.error = (r.item.error || 'O Instagram não publicou.') + ' O post ficou na Fila como "Falhou".'; renderPost(); }
        else if (tries > 1) pollPost(id, tries - 1);
        else { post.error = 'O vídeo está demorando. Confira depois na Fila (botão Verificar).'; renderPost(); }
      }).catch(function () { if (tries > 1) pollPost(id, tries - 1); });
    }, 15000);
  }

  Object.assign(actions, {
    'cover-open': function () {
      if (!window.GarimpoCover) throw new Error('O editor de capa não carregou. Atualize a página (Ctrl+F5).');
      if (!post.cover) {
        var tpl = post.group ? 'lista' : post.tone === 'premium' ? 'premium' : 'oferta';
        post.cover = {
          tpl: tpl, title: coverDefaultTitle(tpl), saveDefault: true, format: prefGet('coverFormat', 'feed') === 'story' ? 'feed' : prefGet('coverFormat', 'feed'), cta: prefGet('coverCta', 'LINK NA BIO'), opts: {}, shape: prefGet('coverShape', 'auto'), radius: prefGet('coverRadius', ''),
          color: state.brand.color || DEFAULT_COLOR,
          handle: state.brand.handle || (state.conn && state.conn.username) || '',
        };
      }
      post.cover.open = true;
      renderPost();
    },
    /** Baixa a capa como está na prévia (JPEG no tamanho do formato escolhido). */
    'cover-download': function () {
      var cv = post.cover, canvas = $('#cover-canvas');
      if (!canvas) return null;
      return Promise.resolve(drawCover()).then(function () {
        return new Promise(function (resolve, reject) {
          try { canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Não consegui gerar a imagem.')); }, 'image/jpeg', 0.95); }
          catch (e) { reject(new Error('Não consegui gerar a imagem: ' + e.message)); }
        });
      }).then(function (b) {
        var name = 'capa-' + (cv.format || 'feed') + '-' + String(post.product.title || 'produto').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) + '.jpg';
        downloadFile(new File([b], name, { type: 'image/jpeg' }));
        toast('Imagem baixada');
      });
    },
    'cover-radius-reset': function () { post.cover.radius = ''; prefSet('coverRadius', ''); renderPost(); },
    'cover-close': function () { post.cover.open = false; renderPost(); },
    /** Exporta a prévia em JPEG 1080x1350, envia ao armazenamento e põe como 1ª imagem do post. */
    'cover-use': function () {
      var cv = post.cover, canvas = $('#cover-canvas');
      if (!canvas) return null;
      return new Promise(function (resolve, reject) {
        try { canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Não consegui gerar a imagem da capa.')); }, 'image/jpeg', 0.92); }
        catch (e) { reject(new Error('Não consegui gerar a imagem da capa: ' + e.message)); }
      }).then(function (blob) {
        cv.busy = true; renderPost();
        return uploadFile(new File([blob], 'capa.jpg', { type: 'image/jpeg' }));
      }).then(function (r) {
        var old = cv.url;
        cv.url = r.url;
        if (post.waPhoto && post.waPhoto !== 'none') post.waPhoto = r.url;
        post.uploads = [{ type: 'image', url: r.url }].concat(post.uploads.filter(function (m) { return m.url !== old; }));
        post.media = [{ type: 'image', url: r.url }].concat(post.media.filter(function (m) { return m.url !== old && m.url !== r.url; })).slice(0, MAX_MEDIA);
        post.customMedia = true;
        cv.open = false;
        toast('Capa pronta: é a 1ª imagem do post');
        if (!cv.saveDefault) return null;
        return api('PUT', '/api/auth/brand', { color: cv.color, handle: cv.handle }).then(function (b) { state.brand = b.brand; }).catch(function () {});
      }).finally(function () { if (post && post.cover) { post.cover.busy = false; renderPost(); } });
    },
    'p-more': function () { state.plimit += P_PAGE; render(); },
    'p-all': function () { state.plimit = 1e6; render(); },
    'psel-clear': function () { state.psel = {}; render(); },
    'psel-post': function () { return openPost(groupSelected()); },
    'refresh-all': function (btn) {
      if (btn) { btn.disabled = true; btn.textContent = 'Atualizando preços…'; }
      return api('POST', '/api/products/refresh-all').then(function (r) {
        var msg = r.checked + ' conferidos';
        if (r.changed.length) msg += ', ' + r.changed.length + ' mudaram de preço (ex.: ' + r.changed[0].title.slice(0, 30) + ': ' + brl(r.changed[0].from) + ' → ' + brl(r.changed[0].to) + ')';
        else msg += ', nenhum mudou de preço';
        if (r.failed.length) msg += '. ' + r.failed.length + ' com erro: ' + r.failed[0].error;
        if (r.remaining > 0) msg += '. Faltaram ' + r.remaining + ': clique de novo para continuar.';
        toast(msg);
        return reload();
      }).catch(function (e) { return reload().then(function () { throw e; }); });
    },
    'post-close': function () { dlg.close(); afterPostClosed(); },
    'post-copy': function () { return copyText(post.caption).then(function (ok) { toast(ok ? 'Texto copiado' : 'Não consegui copiar. Selecione o texto e copie.'); }); },
    'post-regen': function () { return loadPreview(false); },
    'post-regen-ai': function () { return loadPreview(true); },
    'post-ig': function () {
      if (!post.media.length) throw new Error('Marque pelo menos uma foto ou um vídeo antes de publicar no Instagram.');
      post.busy = true; post.sending = true; post.error = null; renderPost();
      var body = { product_ids: post.products.map(function (x) { return x.id; }), channel: 'instagram', caption: post.caption };
      if (post.media.length === 1) { body.media_type = post.media[0].type; body.media_url = post.media[0].url; }
      else { body.media_type = 'carousel'; body.media_items = post.media; }
      return api('POST', '/api/queue/post-now', body).then(function (r) {
        post.itemId = r.item.id; post.status = r.item.status === 'posted' ? 'posted' : 'processing'; post.permalink = r.item.permalink;
        if (post.status === 'posted') toast('Publicado no Instagram'); else pollPost(r.item.id, 40);
      }).catch(function (e) {
        post.error = e.message + (e.status === 502 || e.status === 429 ? ' O post ficou na Fila como "Falhou" para tentar de novo.' : '');
      }).finally(function () { if (post) { post.busy = false; post.sending = false; renderPost(); } });
    },
    'post-wa': function () {
      copyText(post.caption);
      window.open(waLink(post.caption), '_blank', 'noopener');
      post.waOpened = true; renderPost();
    },
    /**
     * Celular: abre o menu de compartilhar com a foto + o texto (a legenda vai junto no WhatsApp).
     * Computador (sem compartilhar arquivos): copia a foto para colar no WhatsApp; o texto vem depois.
     */
    'post-wa-share': function () {
      var url = waPhotoUrl();
      if (!url) throw new Error('Escolha uma foto ou use "Só o texto".');
      var ready = waPreps[url] && waPreps[url].value;
      var run = function (v) {
        if (navigator.canShare && navigator.share && navigator.canShare({ files: [v.file] })) {
          copyText(post.caption);
          return navigator.share({ files: [v.file], text: post.caption }).then(function () {
            post.waOpened = true; renderPost(); toast('Agora é só escolher o grupo e enviar!');
          }, function (e) { if (e && e.name === 'AbortError') return; throw new Error('Não consegui abrir o compartilhar: ' + e.message); });
        }
        if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
          return navigator.clipboard.write([new ClipboardItem({ 'image/png': v.png })]).then(function () {
            post.waGuide = true; post.waOpened = true; renderPost();
          }, function () { downloadFile(v.file); post.waGuide = false; post.waOpened = true; renderPost(); toast('Baixei a foto: anexe no WhatsApp e cole o texto na legenda.'); });
        }
        downloadFile(v.file); post.waOpened = true; renderPost();
        toast('Baixei a foto: anexe no WhatsApp e cole o texto na legenda.');
        return null;
      };
      // com a foto já preparada, compartilha no mesmo toque (o navegador exige isso)
      if (ready) return run(ready);
      post.busy = true; renderPost();
      return prepareWaImage(url).then(function () { toast('Foto pronta: toque de novo em "Compartilhar com foto".'); })
        .finally(function () { if (post) { post.busy = false; renderPost(); } });
    },
    'post-wa-done': function () {
      post.busy = true; renderPost();
      return api('POST', '/api/queue/post-now', { product_ids: post.products.map(function (x) { return x.id; }), channel: 'whatsapp', caption: post.caption })
        .then(function () { post.status = 'posted'; toast('Registrado como postado'); })
        .catch(function (e) { post.error = e.message; })
        .finally(function () { if (post) { post.busy = false; renderPost(); } });
    },
  });

  // Ao fechar a janela (botão ou Esc), descarta a prévia e atualiza as listas.
  // Ao fechar a janela, descarta a prévia e atualiza as listas. Chamado pelos botões e, para o Esc, pelo evento
  // "close" (que nem todo navegador dispara de forma confiável em segundo plano; por isso os botões chamam direto).
  function afterPostClosed() {
    if (!post) return;
    if (post.group && post.status) state.psel = {}; // grupo publicado: limpa a seleção
    post = null;
    reload().catch(function () {});
  }
  dlg.addEventListener('close', afterPostClosed);

  function queueItem(id) { return state.queue.filter(function (q) { return q.id === Number(id); })[0]; }
  function capValue(id) { var el = $('#cap-' + id); return el ? el.value : ''; }
  function saveQueue(id, extra) { return api('PATCH', '/api/queue/' + id, Object.assign({ caption: capValue(id) }, extra || {})); }

  document.addEventListener('click', guard(function (e) {
    var t = e.target.closest('button, label');
    if (!t) return;
    var d = t.dataset;
    if (d.act && actions[d.act]) return actions[d.act](t);
    if (d.tab) { state.tab = d.tab; if (d.tab === 'direct') { state.dm.loaded = false; state.dm.people = null; state.dm.report = null; } render(); window.scrollTo(0, 0); return; }
    if (d.mkt) { state.mkt = d.mkt; state.plimit = P_PAGE; return render(); }
    if (d.pview) { state.pview = d.pview; prefSet('pview', d.pview); state.pexp = {}; return render(); }
    if (d.pexp) { state.pexp[d.pexp] = !state.pexp[d.pexp]; render(); var pe = $('#prod-' + d.pexp); if (pe && state.pexp[d.pexp]) pe.scrollIntoView({ block: 'nearest' }); return null; }
    if (d.gfocus !== undefined) { var el = $('#gres-' + d.gfocus); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(function () { el.classList.remove('flash'); }, 1600); } return null; }
    if (d.comsave) {
      var inp = document.querySelector('[data-comcat="' + d.comsave + '"]');
      var pct = Number(String(inp ? inp.value : '').replace(',', '.'));
      if (!(pct > 0 && pct <= 100)) throw new Error('Digite a comissão em % (ex.: 8).');
      var ml = (state.mkts && state.mkts.ML) || {};
      var table = Object.assign({}, ml.commission_table || {});
      table[d.comsave] = pct;
      t.disabled = true;
      return api('PUT', '/api/connections/mercadolivre/commissions', { table: table }).then(function (r) {
        ml.commission_table = r.table;
        var n = 0;
        state.g.results.forEach(function (p) { if (p.marketplace === 'ML' && p.category_id === d.comsave && p.commission_pct == null) { p.commission_pct = pct; scoreOf(p); n++; } });
        toast('Comissão salva: ' + String(pct).replace('.', ',') + '% para a categoria toda (' + n + ' resultado' + (n === 1 ? '' : 's') + (r.updated ? ', ' + r.updated + ' produto' + (r.updated === 1 ? '' : 's') + ' salvo' + (r.updated === 1 ? '' : 's') : '') + ')');
        return loadAll().then(render);
      }).catch(function (err) { t.disabled = false; throw err; });
    }
    if (d.dmview) { state.dm.view = d.dmview; state.dm.people = null; state.dm.report = null; if (d.dmview === 'comentarios') state.dm.loaded = false; return render(); }
    if (d.dmdays) { state.dm.days = Number(d.dmdays); state.dm.report = null; return render(); }
    if (d.dmfilter) { state.dm.filter = d.dmfilter; return loadDirect().then(render); }
    if (d.dmsend) {
      var dmText = ($('#dm-' + d.dmsend) || {}).value;
      t.disabled = true; t.textContent = 'Enviando…';
      return api('POST', '/api/direct/comments/' + d.dmsend + '/send', { text: dmText }).then(function () { toast('Link enviado no Direct 💌'); return loadDirect().then(render); })
        .catch(function (err) { return loadDirect().then(render).then(function () { throw err; }); });
    }
    if (d.dmignore) { return api('POST', '/api/direct/comments/' + d.dmignore + '/ignore').then(function () { return loadDirect().then(render); }); }
    if (d.shview) { var gg = state.g; gg.shview = d.shview; if (d.shview === 'lojas') gg.shops = null; if (d.shview === 'ofertas') gg.camps = null; return render(); }
    if (d.shtype) { state.g.shopsType = d.shtype; state.g.shops = null; return render(); }
    if (d.shopprod) { var g3 = state.g; g3.shview = 'produtos'; g3.shopId = d.shopprod; g3.shopName = d.shopname; g3.q = ''; g3.top = false; return garimpar(1); }
    if (d.copylink) { copyText(d.copylink); toast('Link copiado'); return null; }
    if (d.walink) { var wt = '🛍️ *' + d.waname + '* na Shopee\n👉 ' + d.walink; copyText(wt); window.open(waLink(wt), '_blank', 'noopener'); return null; }
    if (d.gview) { state.gview = d.gview; prefSet('gview', d.gview); return render(); }
    if (d.cpch) { state.cp.msgChannel = d.cpch; return loadCouponMsg().then(render); }
    if (d.cpedit) { return cpEditDialog(state.cp.items.filter(function (c) { return c.id === Number(d.cpedit); })[0]); }
    if (d.cptoggle) { var cc = state.cp.items.filter(function (c) { return c.id === Number(d.cptoggle); })[0]; return api('PATCH', '/api/coupons/' + cc.id, { active: !cc.active }).then(loadCoupons).then(render); }
    if (d.cpdel) { if (!confirm('Excluir este cupom?')) return null; return api('DELETE', '/api/coupons/' + d.cpdel).then(loadCoupons).then(render); }
    if (d.qfilter !== undefined) { state.qfilter = d.qfilter; return render(); }
    if (d.autoEdit) return autoDialog(autoById(d.autoEdit));
    if (d.autoDel) {
      if (!confirm('Excluir este piloto? O histórico dele também some.')) return null;
      return api('DELETE', '/api/automations/' + d.autoDel).then(function () { toast('Piloto excluído'); return reload(); });
    }
    if (d.autoRuns) {
      if (runsOpen[d.autoRuns]) { delete runsOpen[d.autoRuns]; return render(); }
      return loadRuns(d.autoRuns).then(render);
    }
    if (d.autoRun) {
      t.disabled = true; t.textContent = 'Rodando…';
      return api('POST', '/api/automations/' + d.autoRun + '/run').then(function (r) {
        toast(r.status === 'sent' ? 'Enviado: ' + r.title : r.status === 'empty' ? (r.error || 'Nenhuma oferta nova agora.') : 'Problema: ' + (r.error || Object.keys(r.channels || {}).map(function (k) { return CH_NAMES[k] + ': ' + r.channels[k]; }).join(' · ')));
        return loadRuns(d.autoRun).then(reload);
      }).catch(function (err) { return reload().then(function () { throw err; }); });
    }
    if (d.tgchat) {
      t.disabled = true;
      return api('PUT', '/api/connections/telegram/chat', { chat_id: d.tgchat }).then(function (r) {
        state.tgChats = null; toast('Pronto! Mandei uma mensagem de teste em ' + r.chat_title); return reload();
      }).catch(function (err) { t.disabled = false; throw err; });
    }
    if (d.washare) return shareQueueWa(queueItem(d.washare));
    if (d.trend) { state.g.q = d.trend; state.g.category = ''; return garimpar(1); }
    if (d.history) return showHistory(state.products.filter(function (x) { return x.id === Number(d.history); })[0]);
    if (d.pmedia && post) return toggleMedia(d.ptype === 'video' ? 'video' : 'image', d.pmedia);
    if (d.pwa && post) { post.waPhoto = d.pwa; post.waGuide = false; return renderPost(); }
    if (d.ctpl && post && post.cover) {
      var cv = post.cover;
      if (cv.title === coverDefaultTitle(cv.tpl)) cv.title = coverDefaultTitle(d.ctpl); // título padrão acompanha o modelo
      cv.tpl = d.ctpl;
      return renderPost();
    }
    if (d.cshape && post && post.cover) { post.cover.shape = d.cshape; prefSet('coverShape', d.cshape); return renderPost(); }
    if (d.cfmt && post && post.cover) { post.cover.format = d.cfmt; prefSet('coverFormat', d.cfmt); return renderPost(); }
    if (d.ccolor && post && post.cover) { post.cover.color = d.ccolor; return renderPost(); }
    if (d.cphoto && post && post.cover) { post.cover.photo = d.cphoto; return renderPost(); }
    if (d.post) { return openPost(state.products.filter(function (x) { return x.id === Number(d.post); })[0]); }
    if (d.ptone && post && post.tone !== d.ptone) { post.tone = d.ptone; prefSet('tone', d.ptone); return loadPreview(false); }
    if (d.pchan && post && post.channel !== d.pchan) { post.channel = d.pchan; post.waOpened = false; post.waGuide = false; post.note = null; return loadPreview(false); }
    if (d.wa) { var wt = capValue(d.wa); copyText(wt); window.open(waLink(wt), '_blank', 'noopener'); return; }
    if (d.gmkt) { var g = state.g; if (g.mkt !== d.gmkt) { g.mkt = d.gmkt; g.results = []; g.sel = {}; g.done = false; g.more = false; } return render(); }
    if (d.refresh) {
      t.disabled = true; t.textContent = 'Atualizando…';
      return api('POST', '/api/products/' + d.refresh + '/refresh').then(function (r) {
        toast(r.previous_price !== r.product.price ? 'Preço mudou: ' + brl(r.previous_price) + ' → ' + brl(r.product.price) : 'Preço confirmado: ' + brl(r.product.price));
        return reload();
      }).catch(function (err) { return reload().then(function () { throw err; }); });
    }
    if (d.add) {
      var prod = state.products.filter(function (x) { return x.id === Number(d.add); })[0];
      t.disabled = true;
      return freshBeforeQueue(prod).then(function (msg) {
        return api('POST', '/api/queue', { product_id: Number(d.add), channel: d.channel }).then(function (r) { toast((msg || '') + (r.warning || 'Adicionado à fila')); return reload(); });
      }).catch(function (err) { t.disabled = false; throw err; });
    }
    if (d.editProduct) { var p = state.products.filter(function (x) { return x.id === Number(d.editProduct); })[0]; return productDialog(p); }
    if (d.delProduct) { return api('DELETE', '/api/products/' + d.delProduct).then(function () { dlg.close(); toast('Produto excluído'); return reload(); }); }
    if (d.save) return saveQueue(d.save).then(function () { toast('Texto salvo'); return reload(); });
    if (d.regen) return api('POST', '/api/queue/' + d.regen + '/regenerate', { ai: Boolean(d.ai) }).then(function (r) { toast(r.warning || 'Texto refeito'); return reload(); });
    if (d.schedule) {
      var v = $('#when-' + d.schedule).value;
      if (!v) throw new Error('Escolha a data e a hora.');
      return saveQueue(d.schedule, { scheduled_at: new Date(v).toISOString() }).then(function () { toast('Agendado'); return reload(); });
    }
    if (d.unschedule) return saveQueue(d.unschedule, { scheduled_at: null }).then(function () { toast('Agendamento removido'); return reload(); });
    if (d.publish) {
      t.disabled = true; t.textContent = 'Publicando…';
      return saveQueue(d.publish).then(function () { return api('POST', '/api/queue/' + d.publish + '/publish'); })
        .then(function () { toast('Publicado no Instagram'); return reload(); })
        .catch(function (err) { return reload().then(function () { throw err; }); });
    }
    if (d.check) return api('POST', '/api/queue/' + d.check + '/check').then(function (r) { toast(r.item.status === 'posted' ? 'Publicado no Instagram' : 'Ainda processando'); return reload(); });
    if (d.posted) return api('POST', '/api/queue/' + d.posted + '/mark-posted').then(reload);
    if (d.reopen) return api('POST', '/api/queue/' + d.reopen + '/reopen').then(reload);
    if (d.delQueue) return api('DELETE', '/api/queue/' + d.delQueue).then(reload);
    if (d.copy) {
      var txt = capValue(d.copy);
      var done = function () { toast('Texto copiado'); };
      var fallback = function () { var el = $('#cap-' + d.copy); el.select(); toast('Texto selecionado. Use copiar do aparelho.'); };
      try { return navigator.clipboard.writeText(txt).then(done, fallback); } catch (_) { return fallback(); }
    }
    if (d.delEarn) return api('DELETE', '/api/earnings/' + d.delEarn).then(reload);
  }));

  document.addEventListener('change', guard(function (e) {
    var t = e.target;
    if (t.id === 'f-cat') { state.cat = t.value; state.plimit = P_PAGE; return render(); }
    if (t.id === 'f-com') { state.comMin = Number(t.value); return render(); }
    if (t.id === 'f-ord') { state.ordem = t.value; prefSet('ordem', t.value); state.plimit = P_PAGE; return render(); }
    if (t.id === 'f-flag') { state.pflag = t.value; state.plimit = P_PAGE; return render(); }
    if (t.id === 'f-days') { state.days = Number(t.value); return reload(); }
    if (t.dataset.earnStatus) return api('PATCH', '/api/earnings/' + t.dataset.earnStatus, { status: t.value }).then(reload);
    if (t.id === 'links-sheet' && t.files[0] && links) {
      links.busy = true; renderLinks();
      return t.files[0].text().then(function (txt) { return api('POST', '/api/garimpo/from-shopee-csv', undefined, txt); })
        .then(function (r) {
          links.items = r.items;
          var noImg = r.items.filter(function (x) { return !x.image_url; }).length;
          toast(r.items.length + ' produtos lidos da planilha' + (noImg ? ' (' + noImg + ' sem foto)' : ''));
        })
        .finally(function () { if (links) { links.busy = false; renderLinks(); } });
    }
    if (t.dataset.pupload && t.files.length && post) {
      // envia um arquivo por vez; cada um entra marcado no post (até o limite de 10)
      var files = Array.prototype.slice.call(t.files);
      post.busy = true; renderPost();
      return files.reduce(function (chain, f) {
        return chain.then(function () {
          return uploadFile(f).then(function (r) {
            if (!post) return;
            post.uploads.push({ type: r.media_type, url: r.url });
            if (post.channel === 'whatsapp' && r.media_type === 'image') post.waPhoto = r.url;
            if (post.media.length < MAX_MEDIA) post.media.push({ type: r.media_type, url: r.url });
            post.customMedia = true;
          });
        });
      }, Promise.resolve()).finally(function () { if (post) { post.busy = false; renderPost(); } });
    }
    if (t.id === 'cover-cta' && post && post.cover) { post.cover.cta = t.value; prefSet('coverCta', t.value); drawCoverSoon(); return null; }
    if ((t.id === 'cover-opt-off' || t.id === 'cover-opt-seals') && post && post.cover) {
      post.cover.opts = Object.assign({}, post.cover.opts); post.cover.opts[t.id === 'cover-opt-off' ? 'off' : 'seals'] = t.checked; drawCoverSoon(); return null;
    }
    if (t.id === 'cover-save' && post && post.cover) { post.cover.saveDefault = t.checked; return null; }
    if (t.dataset.psel) {
      if (t.checked && groupSelected().length >= MAX_MEDIA) { t.checked = false; throw new Error('Dá para juntar no máximo 10 produtos num carrossel.'); }
      state.psel[t.dataset.psel] = t.checked;
      return render();
    }
    if (t.dataset.autoToggle) {
      return api('PATCH', '/api/automations/' + t.dataset.autoToggle, { active: t.checked }).then(function () { toast(t.checked ? 'Piloto ligado' : 'Piloto pausado'); return reload(); })
        .catch(function (err) { return reload().then(function () { throw err; }); });
    }
    if (t.dataset.cpsel !== undefined && state.cp.parsed) { state.cp.parsed[Number(t.dataset.cpsel)]._skip = !t.checked; return null; }
    if (t.id === 'cp-mk') { state.cp.mk = t.value; return null; }
    if (t.dataset.cpf && t.tagName === 'SELECT' && state.cp.parsed) { state.cp.parsed[Number(t.dataset.cpi)][t.dataset.cpf] = t.value; return null; }
    if (t.id === 'dm-q') { state.dm.q = t.value; return loadDmPeople().then(render); }
    if (t.id === 'g-ams') { state.g.ams = t.checked; return null; }
    if (t.id === 'g-key') { state.g.keySeller = t.checked; return null; }
    if (t.id === 'sh-sort') { state.g.shopsSort = t.value; state.g.shops = null; return render(); }
    if (t.id === 'g-sort') { state.g.sort = t.value; return render(); } // ordena na hora, sem buscar de novo
    if (t.id === 'g-onlycom') { state.g.onlyCom = t.checked; return render(); }
    if (t.id === 'g-official') { state.g.official = t.checked; return render(); }
    if (t.id === 'g-pmin') { state.g.priceMin = Number(String(t.value).replace(/\./g, '').replace(',', '.')) || 0; return render(); }
    if (t.id === 'g-sheet' && t.files[0]) {
      var gs2 = state.g;
      gs2.sheetBusy = true; render();
      return t.files[0].text().then(function (txt) { return api('POST', '/api/garimpo/from-shopee-csv', undefined, txt); })
        .then(function (r) {
          gs2.mkt = 'SH'; gs2.results = r.items.map(scoreOf); gs2.sel = {}; gs2.done = true; gs2.more = false;
          if (gs2.sort === 'relevancia') gs2.sort = 'ganho';
          var n = r.items.length, saved = r.items.filter(function (x) { return x.saved_id; }).length;
          toast(n + ' produtos da planilha' + (saved ? ' · ' + saved + ' já salvos' : '') + (r.updated ? ' · ' + r.updated + ' atualizados com comissão/vendas' : ''));
          return r.updated ? loadAll() : null;
        })
        .finally(function () { gs2.sheetBusy = false; render(); });
    }
    if (t.dataset.gpick !== undefined) { state.g.sel[t.dataset.gpick] = t.checked; return render(); }
    if (t.id === 'g-cat') {
      state.g.category = t.value;
      if (!t.value) return render();
      state.g.q = '';
      return garimpar(1);
    }
    if (t.id === 'g-ship') { state.g.ship = t.value; return state.g.done ? garimpar(1) : render(); }
    if (t.form && t.form.id === 'g-form' && t.tagName === 'SELECT') {
      var gs = state.g;
      gs[t.name] = t.name === 'sort' ? t.value : Number(t.value);
      return gs.done && (gs.q || gs.category) ? garimpar(1) : render();
    }
    if (t.id === 'f-ship') { state.shipFilter = t.value; return render(); }
    if (t.dataset.upload && t.files[0]) {
      var id = t.dataset.upload;
      return uploadFile(t.files[0]).then(function (r) { return saveQueue(id, { media_type: r.media_type, media_url: r.url }); }).then(function () { toast('Mídia atualizada'); return reload(); });
    }
  }));

  document.addEventListener('input', function (e) {
    var t = e.target;
    // cupons: guarda o que é digitado sem redesenhar
    if (t.dataset && t.dataset.cpf && state.cp.parsed) { var cpi = state.cp.parsed[Number(t.dataset.cpi)]; if (cpi) cpi[t.dataset.cpf] = t.dataset.cpf === 'code' ? t.value.toUpperCase() : t.value; return; }
    if (t.id === 'cp-text') { state.cp.text = t.value; return; }
    if (t.id === 'cp-link') { state.cp.link = t.value; return; }
    // busca em Produtos: redesenha só a lista, para não perder o foco do campo
    if (t.id === 'f-q') { state.pq = t.value; state.plimit = P_PAGE; var pl = $('#plist'); if (pl) pl.innerHTML = productsList(); return; }
    if (t.dataset && t.dataset.caption) { var c = $('#cnt-' + t.dataset.caption); if (c) c.textContent = t.value.length; }
    // cadastro por links: guarda o que o usuário digita sem redesenhar (não perde o foco)
    if (links && links.items && t.dataset && t.dataset.li !== undefined) {
      var li = links.items[Number(t.dataset.li)];
      if (li) li[t.dataset.lf] = t.dataset.lf === 'title' ? t.value : linkNum(t.value);
    }
    if (t.id === 'post-cap' && post) { post.caption = t.value; var pc = $('#post-cnt'); if (pc) pc.textContent = t.value.length; }
    // editor de capa: atualiza a prévia sem redesenhar a janela (não perde o foco do campo)
    if (post && post.cover && t.id === 'cover-radius') {
      post.cover.radius = Number(t.value); prefSet('coverRadius', t.value);
      var rv = $('#cover-radius-v'); if (rv) rv.textContent = t.value;
      drawCover();
      return;
    }
    if (post && post.cover && (t.id === 'cover-title' || t.id === 'cover-color' || t.id === 'cover-handle')) {
      if (t.id === 'cover-title') post.cover.title = t.value;
      if (t.id === 'cover-color') post.cover.color = t.value;
      if (t.id === 'cover-handle') post.cover.handle = t.value.replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '');
      drawCoverSoon();
    }
  });

  document.addEventListener('submit', function (e) {
    if (e.target.id === 'auth-form') {
      e.preventDefault();
      var f = Object.fromEntries(new FormData(e.target).entries());
      var url = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      api('POST', url, f).then(function (r) { state.user = r.user; return api('GET', '/api/auth/me').then(function (m) { state.ai = m.ai; state.signup = m.signup; state.brand = m.brand || state.brand; state.shipZip = m.ship_zip || null; return reload(); }); })
        .catch(function (err) { var el = $('#auth-err'); if (el) el.textContent = err.message; });
    } else if (e.target.id === 'ig-form') {
      e.preventDefault();
      var g = Object.fromEntries(new FormData(e.target).entries());
      api('PUT', '/api/connections/instagram', g).then(function (r) { toast('Instagram conectado' + (r.username ? ': @' + r.username : '')); return reload(); })
        .catch(function (err) { var el = $('#ig-err'); if (el) el.textContent = err.message; });
    } else if (e.target.id === 'tg-form' || e.target.id === 'tgchat-form') {
      e.preventDefault();
      var isTok = e.target.id === 'tg-form';
      var tv = e.target.querySelector('input').value.trim();
      var tb = e.target.querySelector('button[type="submit"]'); tb.disabled = true;
      var errEl = e.target.querySelector('.err');
      (isTok ? api('PUT', '/api/connections/telegram', { token: tv }) : api('PUT', '/api/connections/telegram/chat', { chat_id: tv }))
        .then(function (r) {
          if (isTok) { state.tgChats = null; toast('Bot @' + (r.bot || '') + ' conectado. Agora escolha o grupo ou canal.'); }
          else { state.tgChats = null; toast('Pronto! Mandei uma mensagem de teste em ' + r.chat_title); }
          return reload();
        })
        .catch(function (err) { tb.disabled = false; if (errEl) errEl.textContent = err.message; });
    } else if (e.target.id === 'sh-shops-form') {
      e.preventDefault();
      state.g.shopsQ = $('#sh-shops-q').value.trim(); state.g.shops = null; render();
    } else if (e.target.id === 'sh-link-form') {
      e.preventDefault();
      var lb = e.target.querySelector('button[type="submit"]'); lb.disabled = true;
      api('POST', '/api/garimpo/shopee/link', { url: $('#sh-link-url').value.trim(), sub_ids: [$('#sh-link-sub').value] })
        .then(function (r) { state.g.linkOut = r.link; copyText(r.link); toast('Link gerado e copiado'); render(); })
        .catch(function (err) { lb.disabled = false; toast(err.message); });
    } else if (e.target.id === 'dm-form') {
      e.preventDefault();
      var df = e.target;
      api('PUT', '/api/direct/settings', { auto: df.auto.checked, keywords: df.keywords.value, template: df.template.value, public_reply: df.public_reply.checked, track_links: df.track_links.checked })
        .then(function (r) { state.dm.settings = r.settings; toast(r.settings.auto ? 'Respostas automáticas ligadas' : 'Configuração salva (envio manual)'); render(); })
        .catch(function (err) { toast(err.message); });
    } else if (e.target.id === 'cp-auto') {
      e.preventDefault();
      var fa = e.target;
      api('PUT', '/api/coupons/settings', { auto: fa.auto.checked, time: fa.time.value, channels: { telegram: fa.telegram.checked, whatsapp: fa.whatsapp.checked } })
        .then(function (r) { state.cp.settings = r.settings; toast(r.settings.auto ? 'Cupons automáticos às ' + r.settings.time : 'Postagem automática de cupons desligada'); })
        .catch(function (err) { toast(err.message); });
    } else if (e.target.id === 'g-form') {
      e.preventDefault();
      state.g.q = $('#g-q').value.trim();
      state.g.category = '';
      state.g.top = false;
      guard(function () { return garimpar(1); })();
    } else if (e.target.id === 'sh-form') {
      e.preventDefault();
      var s = Object.fromEntries(new FormData(e.target).entries());
      var btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true; btn.textContent = 'Testando…';
      api('PUT', '/api/connections/shopee', s).then(function () { toast('Shopee conectada'); return reload(); })
        .catch(function (err) { btn.disabled = false; btn.textContent = 'Salvar e testar'; var el = $('#sh-err'); if (el) el.textContent = err.message; });
    } else if (e.target.id === 'ship-form') {
      e.preventDefault();
      api('PUT', '/api/auth/shipping', { zip: $('#ship-zip').value }).then(function (r) {
        state.shipZip = r.ship_zip;
        toast(r.ship_zip ? 'CEP salvo. Use "Atualizar todos os preços" em Produtos para recalcular o frete.' : 'CEP removido: o frete não será estimado.');
        render();
      }).catch(function (err) { var el = $('#ship-err'); if (el) el.textContent = err.message; });
    } else if (e.target.id === 'mlcom-form') {
      e.preventDefault();
      var table = Object.fromEntries(new FormData(e.target).entries());
      api('PUT', '/api/connections/mercadolivre/commissions', { table: table }).then(function (r) {
        toast('Comissões salvas' + (r.updated ? '. ' + r.updated + ' produto' + (r.updated === 1 ? '' : 's') + ' recalculado' + (r.updated === 1 ? '' : 's') : ''));
        return reload();
      }).catch(function (err) { var el = $('#mlcom-err'); if (el) el.textContent = err.message; });
    } else if (e.target.id === 'ml-form') {
      e.preventDefault();
      var mfd = Object.fromEntries(new FormData(e.target).entries());
      api('PUT', '/api/connections/mercadolivre', mfd).then(function (r) {
        if (r.authorize) { window.location.href = r.authorize; return null; }
        toast('Comissão padrão salva' + (r.updated ? '. ' + r.updated + ' produto(s) recalculado(s)' : '')); return reload();
      }).catch(function (err) { var el = $('#ml-err'); if (el) el.textContent = err.message; });
    }
  });

  /* Enquanto houver Reels/carrossel processando e a Fila estiver aberta, confere a cada 60 segundos (poupa a cota da Meta). */
  setInterval(function () {
    if (!state.user || state.tab !== 'fila' || document.hidden) return;
    var pend = state.queue.filter(function (q) { return q.status === 'processing'; });
    if (!pend.length) return;
    Promise.all(pend.map(function (q) { return api('POST', '/api/queue/' + q.id + '/check').catch(function () {}); })).then(reload).catch(function () {});
  }, 60000);

  /* ---------- início ---------- */
  // Volta da autorização do Mercado Livre: /?ml=ok#conexoes ou /?ml=erro&msg=...#conexoes
  var qs = new URLSearchParams(location.search);
  var mlBack = qs.get('ml'), mlMsg = qs.get('msg');
  if (location.hash === '#conexoes') state.tab = 'conexoes';
  if (mlBack || location.hash) history.replaceState(null, '', location.pathname);

  api('GET', '/api/auth/me').then(function (m) {
    state.user = m.user; state.ai = m.ai; state.signup = m.signup; state.brand = m.brand || state.brand; state.shipZip = m.ship_zip || null;
    return loadAll();
  }).catch(function () { state.user = null; return fetch('/api/health').catch(function () {}); }).then(function () {
    state.loading = false;
    if (!state.user) {
      // descobre se o cadastro está aberto sem estar logado
      return fetch('/api/auth/signup-open').then(function (r) { return r.ok ? r.json() : { signup: true }; }).catch(function () { return { signup: true }; }).then(function (s) { state.signup = s.signup; });
    }
  }).then(function () {
    render();
    if (mlBack === 'ok') toast('Mercado Livre autorizado. Já pode garimpar!');
    else if (mlBack) toast('Mercado Livre: ' + (mlMsg || 'não foi possível autorizar.'));
  });
})();
