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
    clearTimeout(toast.h); toast.h = setTimeout(function () { t.hidden = true; }, 2400);
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
    user: null, loading: true, tab: 'descobrir', signup: false, ai: false,
    products: [], queue: [], summary: null, earnings: [], conn: null,
    mkt: 'todos', cat: 'todas', comMin: 0, ordem: 'score', days: 14, authMode: 'login',
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
      api('GET', '/api/connections/instagram'),
    ]).then(function (r) {
      state.products = r[0].products; state.queue = r[1].items; state.summary = r[2];
      state.earnings = r[3].earnings; state.conn = r[4];
    });
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
    var tabs = [['descobrir', 'Descobrir', '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'],
      ['fila', 'Fila', '<path d="M4 6h16M4 12h16M4 18h10"/>'],
      ['ganhos', 'Ganhos', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
      ['conexoes', 'Conexões', '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/>']];
    return '<header class="top"><div class="brand"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.7 6.7 19.6l1.1-6L3.4 9.4l6-.8z"/></svg></div><h1>Garimpo</h1></div>' +
      '<div class="top-actions"><span class="who">' + esc(state.user.name || state.user.email) + '</span><button class="btn small ghost" data-act="logout">Sair</button></div></header>' +
      '<nav class="tabs" role="tablist" aria-label="Seções">' + tabs.map(function (t) {
        return '<button role="tab" aria-selected="' + (state.tab === t[0]) + '" data-tab="' + t[0] + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + t[2] + '</svg>' + t[1] + (t[0] === 'fila' && pend ? '<span class="badge">' + pend + '</span>' : '') + '</button>';
      }).join('') + '</nav><main>' + body + '</main>';
  }

  function viewDescobrir() {
    var cats = ['todas'].concat(Array.from(new Set(state.products.map(function (p) { return p.category; }).filter(Boolean))));
    var list = state.products.filter(function (p) {
      return (state.mkt === 'todos' || p.marketplace === state.mkt) && (state.cat === 'todas' || p.category === state.cat) && (p.commission_pct || 0) >= state.comMin;
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
        '<div class="price"><strong class="num">' + brl(p.price) + '</strong>' + (p.original_price ? '<s class="num">' + brl(p.original_price) + '</s>' : '') + (p.desc ? '<span class="off num">−' + p.desc + '%</span>' : '') + '</div>' +
        '<div class="stats"><div><span>Comissão</span><b class="num">' + (p.commission_pct != null ? p.commission_pct + '%' : '—') + '</b></div><div><span>Ganho/venda</span><b class="num">' + brl(p.earn_per_sale) + '</b></div><div><span>Avaliação</span><b class="num">' + (p.rating ? '★ ' + p.rating.toFixed(1) : '—') + (p.sales_k ? ' · ' + p.sales_k + ' mil' : '') + '</b></div></div>' +
        '<div class="row"><button class="btn small primary" data-add="' + p.id + '" data-channel="instagram">+ Instagram</button><button class="btn small" data-add="' + p.id + '" data-channel="whatsapp">+ WhatsApp</button><span class="grow"></span>' +
        (p.product_url ? '<a class="btn small ghost" href="' + esc(safeUrl(p.product_url)) + '" target="_blank" rel="noopener noreferrer">Abrir</a>' : '') +
        '<button class="btn small ghost" data-edit-product="' + p.id + '">Editar</button></div></article>';
    }).join('');
    return '<div class="pagehead"><h2>Descobrir</h2><p>Seus produtos, ordenados pela nota de prioridade.</p></div>' +
      '<div class="toolbar"><button class="btn primary" data-act="new-product">Novo produto</button><button class="btn" data-act="import-products">Importar CSV</button></div>' +
      '<div class="rule">Nota de 0 a 100: 30% desconto, 30% comissão, 20% avaliação, 20% volume de vendas.</div>' +
      '<div class="filters">' + chips + '<span class="sep"></span>' +
      sel('f-cat', 'Categoria', cats.map(function (c) { return [c, c === 'todas' ? 'Todas as categorias' : c]; }), state.cat) +
      sel('f-com', 'Comissão mínima', [[0, 'Qualquer comissão'], [8, 'A partir de 8%'], [10, 'A partir de 10%'], [12, 'A partir de 12%']], state.comMin) +
      sel('f-ord', 'Ordenar por', [['score', 'Maior prioridade'], ['ganho', 'Maior ganho por venda'], ['desc', 'Maior desconto']], state.ordem) + '</div>' +
      (list.length ? '<div class="grid three">' + cards + '</div>' :
        '<div class="empty centered-empty">' + (state.products.length ? 'Nenhum produto com esses filtros.' : 'Nenhum produto ainda. Toque em Novo produto ou importe um CSV.') + '</div>');
  }

  var STATUS = { draft: 'Rascunho', scheduled: 'Agendado', publishing: 'Publicando', processing: 'Processando', posted: 'Postado', failed: 'Falhou' };

  function viewFila() {
    var items = state.queue.map(function (q) {
      var editable = q.status === 'draft' || q.status === 'scheduled' || q.status === 'failed';
      var isIg = q.channel === 'instagram';
      var media = '';
      if (isIg) {
        var u = safeUrl(q.media_url);
        media = '<div class="qmedia"><div class="thumb">' +
          (q.media_type === 'video' && u ? '<video src="' + esc(u) + '" muted playsinline preload="metadata"></video>' : (u ? '<img src="' + esc(u) + '" alt="" referrerpolicy="no-referrer">' : '<span class="hint" style="padding:8px">sem mídia</span>')) +
          '</div><div class="stack" style="display:flex;flex-direction:column;gap:6px"><span class="hint">' + (q.media_type === 'none' ? 'O Instagram exige foto (JPEG) ou vídeo.' : (q.media_type === 'video' ? 'Reels em vídeo' : 'Foto')) + '</span>' +
          (editable ? '<label class="btn small" for="up-' + q.id + '">Trocar mídia</label><input id="up-' + q.id + '" class="file-input" type="file" accept="image/jpeg,image/png,video/mp4" data-upload="' + q.id + '" hidden>' : '') + '</div></div>';
      }
      return '<article class="card qitem" data-q="' + q.id + '"><header><div><h3>' + esc(q.product_title || 'Produto removido') + '</h3>' +
        '<div class="meta">' + (q.product_marketplace ? mktTag(q.product_marketplace) : '') + '<span>' + (isIg ? 'Instagram' : 'WhatsApp') + '</span>' +
        (q.scheduled_at && q.status === 'scheduled' ? '<span class="num">· ' + fmtWhen(q.scheduled_at) + '</span>' : '') + '</div></div>' +
        '<span class="pill ' + q.status + '">' + STATUS[q.status] + '</span></header>' + media +
        '<textarea id="cap-' + q.id + '" data-caption="' + q.id + '" ' + (editable ? '' : 'readonly') + ' aria-label="Texto da postagem">' + esc(q.caption) + '</textarea>' +
        (isIg ? '<p class="hint"><span id="cnt-' + q.id + '">' + q.caption.length + '</span>/2200 caracteres</p>' : '') +
        (q.status === 'processing' ? '<p class="hint">O Instagram está processando o vídeo. Ele será publicado automaticamente quando ficar pronto.</p><div class="actions"><button class="btn small" data-check="' + q.id + '">Verificar agora</button></div>' : '') +
        (q.error ? '<p class="err">' + esc(q.error) + '</p>' : '') +
        (q.permalink ? '<p class="ok"><a href="' + esc(safeUrl(q.permalink)) + '" target="_blank" rel="noopener noreferrer">Ver no Instagram</a></p>' : '') +
        (editable ? '<div class="actions"><button class="btn small" data-save="' + q.id + '">Salvar texto</button><button class="btn small" data-regen="' + q.id + '">Refazer texto</button>' + (state.ai ? '<button class="btn small" data-regen="' + q.id + '" data-ai="1">Refazer com IA</button>' : '') + '</div>' : '') +
        (editable ? '<div class="row"><input type="datetime-local" id="when-' + q.id + '" value="' + localInput(q.scheduled_at) + '" aria-label="Data e hora"><button class="btn small" data-schedule="' + q.id + '">' + (isIg ? 'Agendar' : 'Lembrar') + '</button></div>' : '') +
        '<div class="actions">' +
        '<button class="btn small" data-copy="' + q.id + '">Copiar texto</button>' +
        (editable && isIg ? '<button class="btn small primary" data-publish="' + q.id + '"' + (state.conn && state.conn.connected ? '' : ' disabled title="Conecte o Instagram na aba Conexões"') + '>Publicar agora</button>' : '') +
        (editable ? '<button class="btn small" data-posted="' + q.id + '">Marcar como postado</button>' : '') +
        (q.status === 'posted' && !q.external_id ? '<button class="btn small" data-reopen="' + q.id + '">Voltar para fila</button>' : '') +
        (q.status !== 'publishing' ? '<button class="btn small ghost danger" data-del-queue="' + q.id + '">Excluir</button>' : '') + '</div></article>';
    }).join('');
    return '<div class="pagehead"><h2>Fila de divulgação</h2><p>Edite o texto, escolha o horário e publique. No WhatsApp, copie e cole no grupo.</p></div>' +
      (items ? '<div class="grid">' + items + '</div>' : '<div class="empty centered-empty">A fila está vazia. Em Descobrir, use + Instagram ou + WhatsApp nos produtos que quer divulgar.</div>');
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

  function viewConexoes() {
    var c = state.conn || {};
    return '<div class="pagehead"><h2>Conexões</h2><p>Instagram para publicar direto do painel.</p></div><div class="conn">' +
      '<section class="card"><h3>Instagram</h3>' +
      (c.connected ? '<p class="ok">Conectado (conta ' + esc(c.ig_user_id) + ').</p><div class="actions row"><button class="btn small" data-act="test-ig">Testar conexão</button><button class="btn small danger" data-act="disconnect-ig">Desconectar</button></div>' : '<p class="hint">Não conectado. Sem conexão você ainda pode copiar os textos e postar manualmente.</p>') +
      (c.public_media === false ? '<p class="err">Este servidor está em endereço local. O Instagram só consegue ler fotos e vídeos de uma URL pública, então a publicação vai falhar até você configurar APP_URL com o seu domínio.</p>' : '') +
      '<form class="stack" id="ig-form"><div class="field"><label for="ig-id">ID da conta do Instagram</label><input id="ig-id" name="ig_user_id" type="text" inputmode="numeric" placeholder="17841400000000000" required></div>' +
      '<div class="field"><label for="ig-token">Token de acesso</label><input id="ig-token" name="access_token" type="password" autocomplete="off" required></div>' +
      '<p class="err" id="ig-err" role="alert"></p><button class="btn primary" type="submit">' + (c.connected ? 'Atualizar credenciais' : 'Conectar') + '</button></form></section>' +
      '<section class="card"><h3>Como conseguir as credenciais</h3><ol class="steps"><li>Transforme o Instagram em conta profissional (comercial ou criador).</li><li>Crie um app em developers.facebook.com e adicione o produto Instagram.</li><li>Autorize a permissão de publicação de conteúdo para a sua conta.</li><li>Copie o ID da conta e gere um token de acesso de longa duração.</li></ol><p class="hint">O token é guardado criptografado no banco e nunca volta para esta tela.</p></section></div>';
  }

  function render() {
    var scroll = window.scrollY;
    if (state.loading) { app.innerHTML = '<p class="hint" style="padding-top:40vh;text-align:center">Carregando…</p>'; return; }
    if (!state.user) { app.innerHTML = viewLogin(); return; }
    var body = state.tab === 'descobrir' ? viewDescobrir() : state.tab === 'fila' ? viewFila() : state.tab === 'ganhos' ? viewGanhos() : viewConexoes();
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
          toast(r.imported + ' importados' + (r.errors.length ? ', ' + r.errors.length + ' com erro (linha ' + r.errors[0].line + ': ' + r.errors[0].error + ')' : ''));
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
  };

  function queueItem(id) { return state.queue.filter(function (q) { return q.id === Number(id); })[0]; }
  function capValue(id) { var el = $('#cap-' + id); return el ? el.value : ''; }
  function saveQueue(id, extra) { return api('PATCH', '/api/queue/' + id, Object.assign({ caption: capValue(id) }, extra || {})); }

  document.addEventListener('click', guard(function (e) {
    var t = e.target.closest('button, label');
    if (!t) return;
    var d = t.dataset;
    if (d.act && actions[d.act]) return actions[d.act]();
    if (d.tab) { state.tab = d.tab; render(); window.scrollTo(0, 0); return; }
    if (d.mkt) { state.mkt = d.mkt; return render(); }
    if (d.add) return api('POST', '/api/queue', { product_id: Number(d.add), channel: d.channel }).then(function (r) { toast(r.warning || 'Adicionado à fila'); return reload(); });
    if (d.editProduct) { var p = state.products.filter(function (x) { return x.id === Number(d.editProduct); })[0]; return productDialog(p); }
    if (d.delProduct) { return api('DELETE', '/api/products/' + d.delProduct).then(function () { dlg.close(); toast('Produto excluído'); return reload(); }); }
    if (d.save) return saveQueue(d.save).then(function () { toast('Texto salvo'); return reload(); });
    if (d.regen) return api('POST', '/api/queue/' + d.regen + '/regenerate', { ai: Boolean(d.ai) }).then(function (r) { toast(r.warning || 'Texto refeito'); return reload(); });
    if (d.schedule) {
      var v = $('#when-' + d.schedule).value;
      if (!v) throw new Error('Escolha a data e a hora.');
      return saveQueue(d.schedule, { scheduled_at: new Date(v).toISOString() }).then(function () { toast('Agendado'); return reload(); });
    }
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
    if (t.dataset.upload && t.files[0]) {
      var id = t.dataset.upload;
      return uploadFile(t.files[0]).then(function (r) { return saveQueue(id, { media_type: r.media_type, media_url: r.url }); }).then(function () { toast('Mídia atualizada'); return reload(); });
    }
  }));

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.caption) { var c = $('#cnt-' + t.dataset.caption); if (c) c.textContent = t.value.length; }
  });

  document.addEventListener('submit', function (e) {
    if (e.target.id === 'auth-form') {
      e.preventDefault();
      var f = Object.fromEntries(new FormData(e.target).entries());
      var url = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      api('POST', url, f).then(function (r) { state.user = r.user; return api('GET', '/api/auth/me').then(function (m) { state.ai = m.ai; state.signup = m.signup; return reload(); }); })
        .catch(function (err) { var el = $('#auth-err'); if (el) el.textContent = err.message; });
    } else if (e.target.id === 'ig-form') {
      e.preventDefault();
      var g = Object.fromEntries(new FormData(e.target).entries());
      api('PUT', '/api/connections/instagram', g).then(function (r) { toast('Instagram conectado' + (r.username ? ': @' + r.username : '')); return reload(); })
        .catch(function (err) { var el = $('#ig-err'); if (el) el.textContent = err.message; });
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
  api('GET', '/api/auth/me').then(function (m) {
    state.user = m.user; state.ai = m.ai; state.signup = m.signup;
    return loadAll();
  }).catch(function () { state.user = null; return fetch('/api/health').catch(function () {}); }).then(function () {
    state.loading = false;
    if (!state.user) {
      // descobre se o cadastro está aberto sem estar logado
      return fetch('/api/auth/signup-open').then(function (r) { return r.ok ? r.json() : { signup: true }; }).catch(function () { return { signup: true }; }).then(function (s) { state.signup = s.signup; });
    }
  }).then(render);
})();
