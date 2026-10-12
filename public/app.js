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
    mkt: 'todos', cat: 'todas', comMin: 0, ordem: 'score', days: 14, authMode: 'login',
    // garimpo sob demanda: filtros, resultados da última busca e itens marcados
    g: { mkt: 'ML', q: '', category: '', freeShip: false, sort: 'relevancia', minDesc: 0, minCom: 0, minRat: 0, results: [], page: 1, more: false, busy: false, done: false, sel: {}, trends: null, cats: null },
    onlyFree: false,
    psel: {}, // produtos marcados para postar juntos (carrossel)
    brand: { color: null, handle: null }, // identidade das capas (cor e @)
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
    ]).then(function (r) {
      state.products = r[0].products; state.queue = r[1].items; state.summary = r[2];
      state.earnings = r[3].earnings; state.conn = r[4]; state.mkts = r[5];
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
      '</div>';
  }

  function shell(body) {
    var pend = state.queue.filter(function (q) { return q.status === 'draft' || q.status === 'scheduled' || q.status === 'failed'; }).length;
    var tabs = [['garimpar', 'Garimpar', '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'],
      ['descobrir', 'Produtos', '<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 016 0v2"/>'],
      ['fila', 'Fila', '<path d="M4 6h16M4 12h16M4 18h10"/>'],
      ['ganhos', 'Ganhos', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
      ['conexoes', 'Conexões', '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/>']];
    return '<header class="top"><div class="brand"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.7 6.7 19.6l1.1-6L3.4 9.4l6-.8z"/></svg></div><h1>Garimpo</h1></div>' +
      '<div class="top-actions"><span class="who">' + esc(state.user.name || state.user.email) + '</span><button class="btn small ghost" data-act="logout">Sair</button></div></header>' +
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
  function statsBlock(p) {
    var hasCom = p.commission_pct != null;
    var fix = p.marketplace === 'ML' ? '<button class="link small" data-tab="conexoes" title="Preencha a tabela de comissão por categoria em Conexões">definir</button>' : '—';
    return '<div class="stats"><div><span>Comissão</span><b class="num">' + (hasCom ? p.commission_pct + '%' : fix) + '</b></div>' +
      '<div><span>Você ganha</span><b class="num earn">' + (hasCom ? brl(p.earn_per_sale) : '—') + '</b><small class="hint">' + (hasCom ? 'por venda' : 'sem comissão') + '</small></div>' +
      '<div><span>Avaliação</span><b class="num">' + (p.rating ? '★ ' + Number(p.rating).toFixed(1) : '—') + (p.sales_k ? ' · ' + p.sales_k + ' mil' : '') + '</b></div></div>';
  }
  /** Selos da oferta: ranking, frete grátis, Full, loja oficial, nº de vendedores. */
  function badges(p) {
    var b = [];
    if (p.best_seller_rank) b.push('<span class="tag top">' + p.best_seller_rank + 'º mais vendido</span>');
    if (p.free_shipping) b.push('<span class="tag free">Frete grátis</span>');
    if (p.full) b.push('<span class="tag full">⚡ Full</span>');
    if (p.official_store) b.push('<span class="tag off">Loja oficial</span>');
    if (p.sellers > 1) b.push('<span class="tag plain">' + p.sellers + ' vendedores</span>');
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
  function priceBlock(p) {
    return '<div class="price"><strong class="num">' + brl(p.price) + '</strong>' + (p.original_price ? '<s class="num">' + brl(p.original_price) + '</s>' : '') + (p.desc ? '<span class="off num">−' + p.desc + '%</span>' : '') + '</div>';
  }

  function viewGarimpar() {
    var g = state.g;
    var ready = mktReady(g.mkt);
    var chips = [['ML', 'Mercado Livre'], ['SH', 'Shopee']].map(function (m) {
      return '<button type="button" class="chip" data-gmkt="' + m[0] + '" aria-pressed="' + (g.mkt === m[0]) + '">' + m[1] + (mktReady(m[0]) ? '' : ' · desconectado') + '</button>';
    }).join('');
    var sorts = [['relevancia', 'Mais relevantes'], ['vendidos', 'Mais vendidos'], ['comissao', 'Maior comissão'], ['preco', 'Menor preço'], ['nota', 'Maior nota']];
    var form = '<form class="card" id="g-form"><div class="filters" style="padding:0">' + chips + '</div>' +
      '<div class="row"><input id="g-q" name="q" type="search" class="grow gq" placeholder="O que você quer garimpar? Ex.: air fryer, fone bluetooth" value="' + esc(g.q) + '" required minlength="2" aria-label="Busca"' + (ready ? '' : ' disabled') + '>' +
      '<button class="btn primary" type="submit"' + (ready && !g.busy ? '' : ' disabled') + '>' + (g.busy ? 'Garimpando…' : 'Garimpar agora') + '</button></div>' +
      '<div class="filters" style="padding:0">' + selectEl('g-sort', 'sort', 'Ordenar por', sorts, g.sort) +
      selectEl('g-desc', 'minDesc', 'Desconto mínimo', [[0, 'Qualquer desconto'], [10, 'Desconto de 10%+'], [20, 'Desconto de 20%+'], [30, 'Desconto de 30%+'], [50, 'Desconto de 50%+']], g.minDesc) +
      (g.mkt === 'SH' ? selectEl('g-com', 'minCom', 'Comissão mínima', [[0, 'Qualquer comissão'], [5, 'Comissão de 5%+'], [8, 'Comissão de 8%+'], [10, 'Comissão de 10%+'], [15, 'Comissão de 15%+']], g.minCom) +
        selectEl('g-rat', 'minRat', 'Avaliação mínima', [[0, 'Qualquer avaliação'], [4, '★ 4,0+'], [4.5, '★ 4,5+'], [4.8, '★ 4,8+']], g.minRat) :
        '<label class="pick"><input type="checkbox" id="g-free"' + (g.freeShip ? ' checked' : '') + '> Só frete grátis</label>') + '</div>' +
      (g.mkt === 'ML' && ready ? mlExplore(g) : '') + '</form>';

    var note = g.mkt === 'ML' ? '<div class="rule">Primeiro vêm os mais vendidos da categoria (com a posição no ranking), depois os demais produtos com vendedor ativo. O preço é o da oferta mais barata. O Mercado Livre não informa a comissão de afiliado, a avaliação nem o seu link de afiliado: a comissão usa o padrão de Conexões e o link você gera no portal de Afiliados e cola no produto (botão Editar).</div>' : '';
    if (!ready) {
      return '<div class="pagehead"><h2>Garimpar</h2><p>Busque produtos nas lojas na hora que quiser e salve os melhores.</p></div>' + form +
        '<div class="empty centered-empty" style="margin-top:12px">Para garimpar no ' + mktName(g.mkt) + ', conecte a sua conta primeiro.<div class="row" style="justify-content:center;margin-top:10px"><button class="btn primary" data-tab="conexoes">Ir para Conexões</button></div></div>';
    }
    var nsel = Object.keys(g.sel).filter(function (k) { return g.sel[k]; }).length;
    var cards = g.results.map(function (p, i) {
      var picked = Boolean(g.sel[i]);
      return '<article class="card' + (picked ? ' picked' : '') + '">' + thumb(p) +
        '<div class="prod"><div><h3>' + esc(p.title) + '</h3><div class="meta">' + mktTag(p.marketplace) + (p.shop ? '<span>' + esc(p.shop) + '</span>' : '') + '</div></div>' +
        '<div class="score" title="Nota de prioridade"><div><b class="num">' + p.score + '</b><small>nota</small></div></div></div>' +
        badges(p) + priceBlock(p) + statsBlock(p) +
        '<div class="row">' + (p.saved_id ? '<span class="pill posted">Já salvo</span>' : '<label class="pick"><input type="checkbox" data-gpick="' + i + '"' + (picked ? ' checked' : '') + '> Selecionar</label>') +
        '<span class="grow"></span>' + (p.product_url ? '<a class="btn small ghost" href="' + esc(safeUrl(p.product_url)) + '" target="_blank" rel="noopener noreferrer">Ver na loja</a>' : '') + '</div></article>';
    }).join('');
    var results = g.results.length ? '<div class="grid three" style="margin-top:12px">' + cards + '</div>' :
      (g.done && !g.busy ? '<div class="empty centered-empty" style="margin-top:12px">Nada encontrado com esses filtros. Tente outra palavra ou afrouxe os filtros.</div>' : '');
    var bar = g.results.length ? '<div class="gbar"><span class="hint">' + g.results.length + ' resultados · ' + nsel + ' selecionados</span><span class="grow"></span>' +
      '<button class="btn small" data-act="g-all">Selecionar todos</button>' +
      (g.more ? '<button class="btn small" data-act="g-more"' + (g.busy ? ' disabled' : '') + '>Carregar mais</button>' : '') +
      '<button class="btn small primary" data-act="g-save"' + (nsel ? '' : ' disabled') + '>Salvar selecionados (' + nsel + ')</button></div>' : '';
    return '<div class="pagehead"><h2>Garimpar</h2><p>Busque produtos nas lojas na hora que quiser e salve os melhores.</p></div>' + form + note + results + bar;
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
      free_shipping: g.mkt === 'ML' && g.freeShip,
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

  function viewDescobrir() {
    var cats = ['todas'].concat(Array.from(new Set(state.products.map(function (p) { return p.category; }).filter(Boolean))));
    var list = state.products.filter(function (p) {
      return (state.mkt === 'todos' || p.marketplace === state.mkt) && (state.cat === 'todas' || p.category === state.cat) && (p.commission_pct || 0) >= state.comMin && (!state.onlyFree || p.free_shipping);
    });
    list.sort(function (a, b) {
      if (state.ordem === 'ganho') return b.earn_per_sale - a.earn_per_sale;
      if (state.ordem === 'desc') return b.desc - a.desc;
      return b.score - a.score;
    });
    var chips = [['todos', 'Todos'], ['ML', 'Mercado Livre'], ['SH', 'Shopee']].map(function (m) {
      return '<button class="chip" data-mkt="' + m[0] + '" aria-pressed="' + (state.mkt === m[0]) + '">' + m[1] + '</button>';
    }).join('');
    function sel(id, label, opts, cur) {
      return '<select id="' + id + '" aria-label="' + label + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    }
    var cards = list.map(function (p) {
      return '<article class="card">' + thumb(p) +
        '<div class="prod"><div><h3>' + esc(p.title) + '</h3><div class="meta">' + mktTag(p.marketplace) + (p.category ? '<span>' + esc(p.category) + '</span>' : '') + '</div></div>' +
        '<div class="score" title="Nota de prioridade"><div><b class="num">' + p.score + '</b><small>nota</small></div></div></div>' +
        badges(p) + priceBlock(p) + priceTrend(p) + statsBlock(p) +
        '<p class="hint' + (staleHours(p) > 24 ? ' stale' : '') + '">Preço conferido ' + ago(p.price_checked_at) +
        (p.price_stats && p.price_stats.count > 1 ? ' · <button class="link" data-history="' + p.id + '">Histórico</button>' : '') +
        (p.external_id && mktReady(p.marketplace) ? ' · <button class="link" data-refresh="' + p.id + '">Atualizar preço</button>' : '') + '</p>' +
        (p.affiliate_url ? '' : '<p class="err small">Sem link de afiliado: o post vai sem o seu link. Use Editar para colar.</p>') +
        '<div class="row"><button class="btn small primary" data-post="' + p.id + '">Postar agora</button>' +
        '<label class="pick" title="Marque vários para postar juntos num carrossel"><input type="checkbox" data-psel="' + p.id + '"' + (state.psel[p.id] ? ' checked' : '') + '> Juntar</label><span class="grow"></span>' +
        (p.product_url ? '<a class="btn small ghost" href="' + esc(safeUrl(p.product_url)) + '" target="_blank" rel="noopener noreferrer">Abrir</a>' : '') +
        '<button class="btn small ghost" data-edit-product="' + p.id + '">Editar</button></div>' +
        '<div class="row later"><span class="hint">Guardar para depois:</span><button class="btn small ghost" data-add="' + p.id + '" data-channel="instagram">Fila Instagram</button><button class="btn small ghost" data-add="' + p.id + '" data-channel="whatsapp">Fila WhatsApp</button></div></article>';
    }).join('');
    return '<div class="pagehead"><h2>Produtos</h2><p>Seus produtos salvos, ordenados pela nota de prioridade.</p></div>' +
      '<div class="toolbar"><button class="btn primary" data-act="new-product">Novo produto</button><button class="btn" data-act="import-products">Importar CSV</button>' +
      (state.products.some(function (p) { return p.external_id && mktReady(p.marketplace); }) ? '<button class="btn" data-act="refresh-all">Atualizar todos os preços</button>' : '') + '</div>' +
      '<div class="rule">Nota de 0 a 100: 30% desconto, 30% comissão, 20% avaliação, 20% volume de vendas.</div>' +
      '<div class="filters">' + chips + '<span class="sep"></span>' +
      sel('f-cat', 'Categoria', cats.map(function (c) { return [c, c === 'todas' ? 'Todas as categorias' : c]; }), state.cat) +
      sel('f-com', 'Comissão mínima', [[0, 'Qualquer comissão'], [8, 'A partir de 8%'], [10, 'A partir de 10%'], [12, 'A partir de 12%']], state.comMin) +
      sel('f-ord', 'Ordenar por', [['score', 'Maior prioridade'], ['ganho', 'Maior ganho por venda'], ['desc', 'Maior desconto']], state.ordem) +
      '<label class="pick"><input type="checkbox" id="f-free"' + (state.onlyFree ? ' checked' : '') + '> Só frete grátis</label></div>' +
      (list.length ? '<div class="grid three">' + cards + '</div>' + groupBar() :
        '<div class="empty centered-empty">' + (state.products.length ? 'Nenhum produto com esses filtros.' : 'Nenhum produto ainda. Use a aba Garimpar, Novo produto ou importe um CSV.') + '</div>');
  }

  var STATUS = { draft: 'Rascunho', scheduled: 'Agendado', publishing: 'Publicando', processing: 'Processando', posted: 'Postado', failed: 'Falhou' };

  function viewFila() {
    var items = state.queue.map(function (q) {
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
      }
      var nProd = 1;
      try { nProd = q.product_ids ? JSON.parse(q.product_ids).length : 1; } catch (_) { nProd = 1; }
      return '<article class="card qitem" data-q="' + q.id + '"><header><div><h3>' + esc(q.product_title || 'Produto removido') + (nProd > 1 ? ' <span class="hint">+ ' + (nProd - 1) + ' produto' + (nProd > 2 ? 's' : '') + '</span>' : '') + '</h3>' +
        '<div class="meta">' + (q.product_marketplace ? mktTag(q.product_marketplace) : '') + '<span>' + (isIg ? 'Instagram' : 'WhatsApp') + '</span>' +
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
        (!isIg && editable ? '<button class="btn small primary" data-wa="' + q.id + '">Abrir no WhatsApp</button>' : '') +
        '<button class="btn small" data-copy="' + q.id + '">Copiar texto</button>' +
        (editable && isIg ? '<button class="btn small primary" data-publish="' + q.id + '"' + (state.conn && state.conn.connected ? '' : ' disabled title="Conecte o Instagram na aba Conexões"') + '>Publicar agora</button>' : '') +
        (editable ? '<button class="btn small" data-posted="' + q.id + '">Marcar como postado</button>' : '') +
        (q.status === 'posted' && !q.external_id ? '<button class="btn small" data-reopen="' + q.id + '">Voltar para fila</button>' : '') +
        (q.status !== 'publishing' ? '<button class="btn small ghost danger" data-del-queue="' + q.id + '">Excluir</button>' : '') + '</div></article>';
    }).join('');
    return '<div class="pagehead"><h2>Fila e histórico</h2><p>Posts guardados para depois e tudo o que já foi postado. Publique quando quiser; agendar é opcional. Para postar na hora, use Postar agora na aba Produtos.</p></div>' +
      (items ? '<div class="grid">' + items + '</div>' : '<div class="empty centered-empty">Nada por aqui ainda. Em Produtos, use Postar agora, ou Fila Instagram/WhatsApp para guardar e publicar depois.</div>');
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
      (ml.authorized ? commissionTableCard(ml) : '') + '</section>';
    return '<div class="pagehead"><h2>Conexões</h2><p>Lojas para garimpar e Instagram para publicar direto do painel.</p></div><div class="conn">' + mlCard + shCard +
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
    var body = state.tab === 'garimpar' ? viewGarimpar() : state.tab === 'descobrir' ? viewDescobrir() : state.tab === 'fila' ? viewFila() : state.tab === 'ganhos' ? viewGanhos() : viewConexoes();
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
      '<div class="cols">' + field('price', 'Preço (R$)', p.price, 'inputmode="decimal" required') + field('original_price', 'Preço original (R$)', p.original_price, 'inputmode="decimal"') + '</div>' +
      '<div class="cols">' + field('commission_pct', 'Comissão (%)', p.commission_pct, 'inputmode="decimal"') + field('rating', 'Avaliação (0 a 5)', p.rating, 'inputmode="decimal"') + '</div>' +
      field('sales_k', 'Vendidos (em milhares)', p.sales_k, 'inputmode="decimal"') +
      field('product_url', 'Link do anúncio', p.product_url, 'inputmode="url"') + field('affiliate_url', 'Seu link de afiliado', p.affiliate_url, 'inputmode="url"') +
      field('image_url', 'Foto (endereço)', p.image_url, 'inputmode="url"') + field('video_url', 'Vídeo (endereço)', p.video_url, 'inputmode="url"') +
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
  function uploadFile(file) {
    return api('POST', '/api/media/sign', { content_type: file.type, size: file.size }).then(function (s) {
      if (s.driver === 'local') {
        var fd = new FormData(); fd.append('file', file);
        return api('POST', '/api/queue/upload', undefined, fd);
      }
      return loadSupabase().then(function () {
        var sb = window.supabase.createClient(s.supabase_url, s.anon_key);
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

  /* ---------- Postar agora: direto do produto, sem fila e sem agendador ---------- */
  // { products, product, group, channel, caption, media: [{type,url}], uploads, busy, sending, status, permalink, note, error, waOpened, customMedia }
  var post = null;
  var MAX_MEDIA = 10;

  function waLink(text) { return 'https://wa.me/?text=' + encodeURIComponent(text); }
  function copyText(text) {
    try { return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; }); } catch (_) { return Promise.resolve(false); }
  }

  /** Abre o Postar agora para um produto ou para vários (carrossel com um texto numerado). */
  function openPost(arg) {
    var list = (Array.isArray(arg) ? arg : [arg]).filter(Boolean);
    if (!list.length) return null;
    post = { products: list, product: list[0], group: list.length > 1, channel: state.conn && state.conn.connected ? 'instagram' : 'whatsapp', caption: '', media: [], uploads: [], busy: true };
    renderPost();
    if (!dlg.open) dlg.showModal();
    return (post.group ? Promise.resolve(null) : freshBeforeQueue(list[0])).then(function (msg) { if (post) post.note = msg; return loadPreview(false); });
  }

  function loadPreview(ai) {
    if (!post) return null;
    post.busy = true; post.error = null; renderPost();
    var req = post.group
      ? api('POST', '/api/queue/preview-group', { product_ids: post.products.map(function (p) { return p.id; }), channel: post.channel, ai: ai })
      : api('POST', '/api/queue/preview', { product_id: post.product.id, channel: post.channel, ai: ai });
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
      '</div>' : '';
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
      actions = (post.waOpened ? '<p class="hint">Escolha o grupo ou contato no WhatsApp e envie (o texto também foi copiado). Depois toque em "Já enviei" para guardar no histórico.</p>' : '') +
        '<div class="row end"><button class="btn" data-act="post-close">Cancelar</button>' +
        (post.waOpened ? '<button class="btn" data-act="post-wa">Abrir de novo</button><button class="btn primary" data-act="post-wa-done"' + (post.busy ? ' disabled' : '') + '>Já enviei</button>'
          : '<button class="btn primary" data-act="post-wa"' + (post.busy ? ' disabled' : '') + '>Abrir no WhatsApp</button>') + '</div>';
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
      (post.status ? '' : '<div class="row"><button class="btn small" data-act="post-regen"' + (post.busy ? ' disabled' : '') + '>Refazer texto</button>' +
        (state.ai ? '<button class="btn small" data-act="post-regen-ai"' + (post.busy ? ' disabled' : '') + '>Refazer com IA</button>' : '') + '</div>') +
      '<p class="err" role="alert">' + esc(post.error || '') + '</p>' + actions + '</div>';
    if (post.cover && post.cover.open) drawCover();
  }

  /* ---------- capa (1ª imagem do post), desenhada por cover.js ---------- */
  var DEFAULT_COLOR = '#E8457A';
  function coverDefaultTitle(tpl) {
    return tpl === 'lista' ? post.products.length + ' achadinhos' : tpl === 'achadinho' ? 'Achadinho' : 'Achadinho do dia';
  }
  /** Foto usada nos modelos de 1 produto: a escolhida, senão a 1ª marcada no post (que não seja a capa), senão a do produto. */
  function coverPhoto() {
    var cv = post.cover;
    if (cv.photo) return cv.photo;
    var first = post.media.filter(function (m) { return m.type === 'image' && m.url !== cv.url; })[0];
    return first ? first.url : post.product.image_url;
  }
  function coverPanel() {
    var cv = post.cover;
    var tpls = post.group ? [['lista', 'Top ' + post.products.length], ['oferta', 'Oferta'], ['achadinho', 'Achadinho']] : [['oferta', 'Oferta'], ['achadinho', 'Achadinho do dia']];
    var photos = post.group || cv.tpl === 'lista' ? [] : mediaPool().filter(function (m) { return m.type === 'image' && m.url !== cv.url; });
    var cur = coverPhoto();
    return '<div class="coverbox"><canvas id="cover-canvas" width="1080" height="1350" aria-label="Prévia da capa"></canvas><div class="coverctl">' +
      '<div class="seg" role="group" aria-label="Modelo">' + tpls.map(function (t) { return '<button type="button" data-ctpl="' + t[0] + '" aria-pressed="' + (cv.tpl === t[0]) + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div class="field"><label for="cover-title">Título</label><input id="cover-title" type="text" maxlength="40" value="' + esc(cv.title) + '"></div>' +
      (photos.length > 1 ? '<div class="field"><label>Foto do produto</label><div class="gallery">' + photos.map(function (m) {
        return '<button type="button" class="gpic' + (cur === m.url ? ' on' : '') + '" data-cphoto="' + esc(m.url) + '"><img src="' + esc(safeUrl(m.url)) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></button>';
      }).join('') + '</div></div>' : '') +
      '<div class="cols"><div class="field"><label for="cover-color">Cor da marca</label><input id="cover-color" type="color" value="' + esc(cv.color) + '"></div>' +
      '<div class="field"><label for="cover-handle">Seu @ no rodapé</label><input id="cover-handle" type="text" maxlength="31" autocomplete="off" value="' + esc(cv.handle) + '" placeholder="seuperfil"></div></div>' +
      '<label class="pick"><input type="checkbox" id="cover-save"' + (cv.saveDefault ? ' checked' : '') + '> Usar esta cor e este @ nas próximas capas</label>' +
      '<div class="row end"><button type="button" class="btn small" data-act="cover-close">Fechar</button>' +
      '<button type="button" class="btn small primary" data-act="cover-use"' + (cv.busy ? ' disabled' : '') + '>' + (cv.busy ? 'Gerando…' : cv.url ? 'Atualizar capa' : 'Usar como 1ª imagem') + '</button></div></div></div>';
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
      window.GarimpoCover.render(canvas, { template: cv.tpl, title: cv.title, color: cv.color, handle: cv.handle, products: post.products, images: r[1] });
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

  /** Reels: confere a cada 5 s, por até 5 minutos, enquanto a janela estiver aberta. */
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
    }, 5000);
  }

  Object.assign(actions, {
    'cover-open': function () {
      if (!window.GarimpoCover) throw new Error('O editor de capa não carregou. Atualize a página (Ctrl+F5).');
      if (!post.cover) {
        var tpl = post.group ? 'lista' : 'oferta';
        post.cover = {
          tpl: tpl, title: coverDefaultTitle(tpl), saveDefault: true,
          color: state.brand.color || DEFAULT_COLOR,
          handle: state.brand.handle || (state.conn && state.conn.username) || '',
        };
      }
      post.cover.open = true;
      renderPost();
    },
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
        post.uploads = [{ type: 'image', url: r.url }].concat(post.uploads.filter(function (m) { return m.url !== old; }));
        post.media = [{ type: 'image', url: r.url }].concat(post.media.filter(function (m) { return m.url !== old && m.url !== r.url; })).slice(0, MAX_MEDIA);
        post.customMedia = true;
        cv.open = false;
        toast('Capa pronta: é a 1ª imagem do post');
        if (!cv.saveDefault) return null;
        return api('PUT', '/api/auth/brand', { color: cv.color, handle: cv.handle }).then(function (b) { state.brand = b.brand; }).catch(function () {});
      }).finally(function () { if (post && post.cover) { post.cover.busy = false; renderPost(); } });
    },
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
        if (post.status === 'posted') toast('Publicado no Instagram'); else pollPost(r.item.id, 60);
      }).catch(function (e) {
        post.error = e.message + (e.status === 502 ? ' O post ficou na Fila como "Falhou" para tentar de novo.' : '');
      }).finally(function () { if (post) { post.busy = false; post.sending = false; renderPost(); } });
    },
    'post-wa': function () {
      copyText(post.caption);
      window.open(waLink(post.caption), '_blank', 'noopener');
      post.waOpened = true; renderPost();
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
    if (d.tab) { state.tab = d.tab; render(); window.scrollTo(0, 0); return; }
    if (d.mkt) { state.mkt = d.mkt; return render(); }
    if (d.trend) { state.g.q = d.trend; state.g.category = ''; return garimpar(1); }
    if (d.history) return showHistory(state.products.filter(function (x) { return x.id === Number(d.history); })[0]);
    if (d.pmedia && post) return toggleMedia(d.ptype === 'video' ? 'video' : 'image', d.pmedia);
    if (d.ctpl && post && post.cover) {
      var cv = post.cover;
      if (cv.title === coverDefaultTitle(cv.tpl)) cv.title = coverDefaultTitle(d.ctpl); // título padrão acompanha o modelo
      cv.tpl = d.ctpl;
      return renderPost();
    }
    if (d.cphoto && post && post.cover) { post.cover.photo = d.cphoto; return renderPost(); }
    if (d.post) { return openPost(state.products.filter(function (x) { return x.id === Number(d.post); })[0]); }
    if (d.pchan && post && post.channel !== d.pchan) { post.channel = d.pchan; post.waOpened = false; post.note = null; return loadPreview(false); }
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
    if (t.id === 'f-cat') { state.cat = t.value; return render(); }
    if (t.id === 'f-com') { state.comMin = Number(t.value); return render(); }
    if (t.id === 'f-ord') { state.ordem = t.value; return render(); }
    if (t.id === 'f-days') { state.days = Number(t.value); return reload(); }
    if (t.dataset.earnStatus) return api('PATCH', '/api/earnings/' + t.dataset.earnStatus, { status: t.value }).then(reload);
    if (t.dataset.pupload && t.files.length && post) {
      // envia um arquivo por vez; cada um entra marcado no post (até o limite de 10)
      var files = Array.prototype.slice.call(t.files);
      post.busy = true; renderPost();
      return files.reduce(function (chain, f) {
        return chain.then(function () {
          return uploadFile(f).then(function (r) {
            if (!post) return;
            post.uploads.push({ type: r.media_type, url: r.url });
            if (post.media.length < MAX_MEDIA) post.media.push({ type: r.media_type, url: r.url });
            post.customMedia = true;
          });
        });
      }, Promise.resolve()).finally(function () { if (post) { post.busy = false; renderPost(); } });
    }
    if (t.id === 'cover-save' && post && post.cover) { post.cover.saveDefault = t.checked; return null; }
    if (t.dataset.psel) {
      if (t.checked && groupSelected().length >= MAX_MEDIA) { t.checked = false; throw new Error('Dá para juntar no máximo 10 produtos num carrossel.'); }
      state.psel[t.dataset.psel] = t.checked;
      return render();
    }
    if (t.dataset.gpick !== undefined) { state.g.sel[t.dataset.gpick] = t.checked; return render(); }
    if (t.id === 'g-cat') {
      state.g.category = t.value;
      if (!t.value) return render();
      state.g.q = '';
      return garimpar(1);
    }
    if (t.id === 'g-free') { state.g.freeShip = t.checked; return state.g.done ? garimpar(1) : render(); }
    if (t.form && t.form.id === 'g-form' && t.tagName === 'SELECT') {
      var gs = state.g;
      gs[t.name] = t.name === 'sort' ? t.value : Number(t.value);
      return gs.done && (gs.q || gs.category) ? garimpar(1) : render();
    }
    if (t.id === 'f-free') { state.onlyFree = t.checked; return render(); }
    if (t.dataset.upload && t.files[0]) {
      var id = t.dataset.upload;
      return uploadFile(t.files[0]).then(function (r) { return saveQueue(id, { media_type: r.media_type, media_url: r.url }); }).then(function () { toast('Mídia atualizada'); return reload(); });
    }
  }));

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.caption) { var c = $('#cnt-' + t.dataset.caption); if (c) c.textContent = t.value.length; }
    if (t.id === 'post-cap' && post) { post.caption = t.value; var pc = $('#post-cnt'); if (pc) pc.textContent = t.value.length; }
    // editor de capa: atualiza a prévia sem redesenhar a janela (não perde o foco do campo)
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
      api('POST', url, f).then(function (r) { state.user = r.user; return api('GET', '/api/auth/me').then(function (m) { state.ai = m.ai; state.signup = m.signup; state.brand = m.brand || state.brand; return reload(); }); })
        .catch(function (err) { var el = $('#auth-err'); if (el) el.textContent = err.message; });
    } else if (e.target.id === 'ig-form') {
      e.preventDefault();
      var g = Object.fromEntries(new FormData(e.target).entries());
      api('PUT', '/api/connections/instagram', g).then(function (r) { toast('Instagram conectado' + (r.username ? ': @' + r.username : '')); return reload(); })
        .catch(function (err) { var el = $('#ig-err'); if (el) el.textContent = err.message; });
    } else if (e.target.id === 'g-form') {
      e.preventDefault();
      state.g.q = $('#g-q').value.trim();
      state.g.category = '';
      guard(function () { return garimpar(1); })();
    } else if (e.target.id === 'sh-form') {
      e.preventDefault();
      var s = Object.fromEntries(new FormData(e.target).entries());
      var btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true; btn.textContent = 'Testando…';
      api('PUT', '/api/connections/shopee', s).then(function () { toast('Shopee conectada'); return reload(); })
        .catch(function (err) { btn.disabled = false; btn.textContent = 'Salvar e testar'; var el = $('#sh-err'); if (el) el.textContent = err.message; });
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

  /* Enquanto houver Reels processando e a Fila estiver aberta, confere a cada 20 segundos. */
  setInterval(function () {
    if (!state.user || state.tab !== 'fila' || document.hidden) return;
    var pend = state.queue.filter(function (q) { return q.status === 'processing'; });
    if (!pend.length) return;
    Promise.all(pend.map(function (q) { return api('POST', '/api/queue/' + q.id + '/check').catch(function () {}); })).then(reload).catch(function () {});
  }, 20000);

  /* ---------- início ---------- */
  // Volta da autorização do Mercado Livre: /?ml=ok#conexoes ou /?ml=erro&msg=...#conexoes
  var qs = new URLSearchParams(location.search);
  var mlBack = qs.get('ml'), mlMsg = qs.get('msg');
  if (location.hash === '#conexoes') state.tab = 'conexoes';
  if (mlBack || location.hash) history.replaceState(null, '', location.pathname);

  api('GET', '/api/auth/me').then(function (m) {
    state.user = m.user; state.ai = m.ai; state.signup = m.signup; state.brand = m.brand || state.brand;
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
