/*
 * Capas para o Instagram (1080x1350, 4:5), desenhadas no navegador com <canvas>.
 * Modelos: "oferta" (foto + selo de desconto + preço grande), "achadinho" (título forte + etiqueta de preço)
 * e "lista" (vários produtos em grade, para carrossel). As fotos da loja passam por /api/media/proxy para
 * o canvas poder ser exportado como JPEG.
 */
(function () {
  'use strict';
  var W = 1080, H = 1350;
  var DISPLAY = '"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif';
  var BODY = 'Figtree, "Segoe UI", system-ui, sans-serif';
  var INK = '#1B1B1F', MUTED = '#6B6B76', GOLD = '#FFC93C';

  function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
  function discount(p) {
    var o = Number(p.original_price) || 0, v = Number(p.price) || 0;
    return o > v && o > 0 ? Math.round((1 - v / o) * 100) : 0;
  }

  /* ---------- cores ---------- */
  function rgb(hex) { var n = parseInt(String(hex).slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function hex(c) { return '#' + c.map(function (x) { return ('0' + Math.max(0, Math.min(255, Math.round(x))).toString(16)).slice(-2); }).join(''); }
  /** Mistura a cor com branco (t>0) ou preto (t<0). */
  function shade(color, t) {
    var c = rgb(color), to = t > 0 ? 255 : 0, k = Math.abs(t);
    return hex(c.map(function (x) { return x + (to - x) * k; }));
  }
  function onColor(color) {
    var c = rgb(color), l = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
    return l > 0.62 ? INK : '#FFFFFF';
  }

  /* ---------- imagens e fontes ---------- */
  function loadImage(url) {
    return new Promise(function (resolve) {
      if (!url) return resolve(null);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = /^\//.test(url) ? url : '/api/media/proxy?url=' + encodeURIComponent(url);
    });
  }
  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('700 100px "Bricolage Grotesque"'),
      document.fonts.load('600 40px Figtree'),
      document.fonts.load('400 40px Figtree'),
      document.fonts.load('600 54px "Playfair Display"'),
      document.fonts.load('400 90px "Great Vibes"'),
      document.fonts.load('500 80px "Playfair Display"'),
    ]).catch(function () {});
  }

  /* ---------- desenho ---------- */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function font(weight, size, family) { return weight + ' ' + Math.round(size) + 'px ' + family; }
  /** Maior tamanho (até max) em que o texto cabe em uma linha de largura maxW. */
  function fit(ctx, text, maxW, max, min, weight, family) {
    for (var s = max; s > min; s -= 2) { ctx.font = font(weight, s, family); if (ctx.measureText(text).width <= maxW) return s; }
    ctx.font = font(weight, min, family); return min;
  }
  /** Quebra em linhas (no máximo maxLines; a última ganha reticências se sobrar texto). */
  function wrap(ctx, text, maxW, maxLines) {
    var words = String(text || '').split(/\s+/), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width <= maxW || !cur) { cur = test; continue; }
      lines.push(cur); cur = words[i];
      if (lines.length === maxLines) { cur = ''; break; }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    var used = lines.join(' ').split(/\s+/).length;
    if (used < words.length && lines.length) {
      var last = lines[lines.length - 1];
      while (last && ctx.measureText(last + '…').width > maxW) last = last.replace(/\s*\S+$/, '');
      lines[lines.length - 1] = last + '…';
    }
    return lines;
  }
  /** Imagem inteira dentro da área (sem cortar), centralizada. */
  function contain(ctx, img, x, y, w, h) {
    if (!img) return;
    var k = Math.min(w / img.width, h / img.height), iw = img.width * k, ih = img.height * k;
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  }
  /** Arredondamento escolhido pelo usuário (controle deslizante) ou o padrão do modelo. */
  function rad(d, def) { return d && d.radius != null && d.radius !== '' ? Math.max(0, Math.min(300, Number(d.radius) || 0)) : def; }
  /** Desenha dentro de um retângulo de cantos arredondados (o que passar da borda é cortado). */
  function clipped(ctx, x, y, w, h, r, fn) { ctx.save(); roundRect(ctx, x, y, w, h, r); ctx.clip(); fn(); ctx.restore(); }
  /** Foto inteira com os cantos da própria foto arredondados (modelos sem cartão). */
  function roundedContain(ctx, img, x, y, w, h, r) {
    if (!img) return;
    if (!r) return contain(ctx, img, x, y, w, h);
    var k = Math.min(w / img.width, h / img.height), iw = img.width * k, ih = img.height * k, ix = x + (w - iw) / 2, iy = y + (h - ih) / 2;
    clipped(ctx, ix, iy, iw, ih, r, function () { ctx.drawImage(img, ix, iy, iw, ih); });
  }
  /** Pílula com texto; alinhamento "left" a partir de x ou "right" terminando em x. Devolve a largura. */
  function pill(ctx, text, x, y, o) {
    ctx.font = font(o.weight || 700, o.size || 32, o.family || BODY);
    var w = ctx.measureText(text).width + (o.padX || 26) * 2, h = o.h || Math.round((o.size || 32) * 1.7);
    var left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = o.bg; roundRect(ctx, left, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = o.fg; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(text, left + w / 2, y + h / 2 + 1);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    return w;
  }
  function shadow(ctx, on) {
    ctx.shadowColor = on ? 'rgba(0,0,0,0.16)' : 'transparent';
    ctx.shadowBlur = on ? 40 : 0; ctx.shadowOffsetY = on ? 14 : 0;
  }
  function strike(ctx, text, x, y) {
    ctx.fillText(text, x, y);
    var w = ctx.measureText(text).width, size = parseInt(ctx.font.match(/(\d+)px/)[1], 10);
    ctx.fillRect(x, y - size * 0.32, w, Math.max(3, size * 0.07));
    return w;
  }
  /** Seta "➜" desenhada (não depende de fonte com o símbolo). */
  function arrow(ctx, x, y, size, color) {
    ctx.strokeStyle = color; ctx.lineWidth = size * 0.16; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + size, y); ctx.moveTo(x + size * 0.6, y - size * 0.38);
    ctx.lineTo(x + size, y); ctx.lineTo(x + size * 0.6, y + size * 0.38); ctx.stroke();
  }
  /** Opções ligadas por padrão: desconto (selo e preço "de") e selos (frete, loja oficial, ranking). */
  function opt(d, k) { return !d.opts || d.opts[k] !== false; }
  function offOf(p, d) { return opt(d, 'off') ? discount(p) : 0; }
  function rankOf(p, d) { return opt(d, 'seals') ? p.best_seller_rank : null; }
  function seals(p, d) {
    var s = [];
    if (d && !opt(d, 'seals')) return s;
    if (p.free_shipping) s.push(p.full ? 'FRETE GRÁTIS · FULL' : 'FRETE GRÁTIS');
    if (p.official_store) s.push('LOJA OFICIAL');
    return s;
  }
  function footer(ctx, d, color) {
    var fg = onColor(color);
    ctx.fillStyle = color; ctx.fillRect(0, H - 86, W, 86);
    ctx.fillStyle = fg; ctx.font = font(700, 34, DISPLAY); ctx.textBaseline = 'middle';
    var label = d.cta || 'LINK NA BIO';
    ctx.fillText(label, 60, H - 42);
    arrow(ctx, 60 + ctx.measureText(label).width + 18, H - 43, 34, fg);
    if (d.handle) { ctx.textAlign = 'right'; ctx.font = font(600, 30, BODY); ctx.fillText('@' + d.handle, W - 60, H - 42); ctx.textAlign = 'left'; }
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------- modelos ---------- */
  var T = {};

  /** Oferta: foto grande num cartão, selo de desconto, nome, "de/por" e preço em destaque. */
  T.oferta = function (ctx, d) {
    var p = d.products[0], c = d.color, off = offOf(p, d);
    ctx.fillStyle = shade(c, 0.9); ctx.fillRect(0, 0, W, H);
    pill(ctx, (d.title || 'ACHADINHO DO DIA').toUpperCase(), W / 2, 52, { bg: c, fg: onColor(c), size: 42, family: DISPLAY, padX: 40, align: 'center' });
    var r1 = rad(d, 44);
    shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, 60, 160, 960, 740, r1); ctx.fill(); shadow(ctx, false);
    clipped(ctx, 60, 160, 960, 740, r1, function () { contain(ctx, d.images[0], 100, 195, 880, 670); });
    if (off > 0) {
      ctx.fillStyle = shade(c, -0.12); ctx.beginPath(); ctx.arc(905, 230, 118, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = onColor(shade(c, -0.12)); ctx.textAlign = 'center';
      ctx.font = font(700, fit(ctx, '-' + off + '%', 200, 86, 50, 700, DISPLAY), DISPLAY); ctx.fillText('-' + off + '%', 905, 238);
      ctx.font = font(700, 34, BODY); ctx.fillText('OFF', 905, 285); ctx.textAlign = 'left';
    }
    if (rankOf(p, d)) pill(ctx, p.best_seller_rank + 'º MAIS VENDIDO', 92, 832, { bg: GOLD, fg: INK, size: 30 });
    // bloco de baixo (nome + preço) centralizado entre o cartão (y 900) e o rodapé (y 1264)
    ctx.font = font(600, 44, BODY);
    var lines = wrap(ctx, p.title, 960, 2);
    var range = Number(p.price_max) > Number(p.price); // opções/kits: preço "a partir de"
    var block = lines.length * 54 + 16 + (off > 0 ? 52 : 0) + (range ? 40 : 0) + 118;
    var top = 912 + Math.max(0, (340 - block) / 2);
    ctx.fillStyle = INK;
    lines.forEach(function (l, i) { ctx.fillText(l, 60, top + 42 + i * 54); });
    var y = top + lines.length * 54 + 16;
    if (off > 0) { ctx.fillStyle = MUTED; ctx.font = font(500, 40, BODY); strike(ctx, 'de ' + brl(p.original_price), 60, y + 38); y += 52; }
    if (range) { ctx.fillStyle = MUTED; ctx.font = font(600, 34, BODY); ctx.fillText('a partir de', 60, y + 34); y += 40; }
    ctx.fillStyle = shade(c, -0.18);
    ctx.font = font(700, fit(ctx, brl(p.price), 560, 128, 70, 700, DISPLAY), DISPLAY);
    ctx.fillText(brl(p.price), 56, y + 112);
    seals(p, d).slice(0, 2).forEach(function (s, i, all) {
      pill(ctx, s, 1020, y + 112 - (all.length - i) * 66 + 8, { bg: '#FFFFFF', fg: shade(c, -0.25), size: 28, align: 'right' });
    });
    footer(ctx, d, c);
  };

  /** Achadinho: fundo na cor da marca, título grande, foto central e etiqueta de preço inclinada. */
  T.achadinho = function (ctx, d) {
    var p = d.products[0], c = d.color, fg = onColor(c), off = offOf(p, d);
    ctx.fillStyle = c; ctx.fillRect(0, 0, W, H);
    var g = ctx.createRadialGradient(W / 2, 640, 80, W / 2, 640, 720);
    g.addColorStop(0, shade(c, 0.35)); g.addColorStop(1, c); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    var title = (d.title || 'ACHADINHO').toUpperCase();
    ctx.fillStyle = fg; ctx.textAlign = 'center';
    ctx.font = font(700, fit(ctx, title, 960, 132, 60, 700, DISPLAY), DISPLAY); ctx.fillText(title, W / 2, 168);
    ctx.font = font(500, 36, BODY); ctx.fillText(wrap(ctx, p.title, 900, 1)[0] || '', W / 2, 228); ctx.textAlign = 'left';
    var r2 = rad(d, 60);
    shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, 130, 280, 820, 820, r2); ctx.fill(); shadow(ctx, false);
    clipped(ctx, 130, 280, 820, 820, r2, function () { contain(ctx, d.images[0], 175, 325, 730, 730); });
    // etiqueta de preço
    ctx.save(); ctx.translate(800, 1085); ctx.rotate(-0.1);
    shadow(ctx, true); ctx.fillStyle = GOLD; roundRect(ctx, -235, -120, 470, 240, 34); ctx.fill(); shadow(ctx, false);
    if (Number(p.price_max) > Number(p.price)) pill(ctx, 'A PARTIR DE', 0, -150, { bg: INK, fg: GOLD, size: 26, align: 'center' });
    ctx.fillStyle = INK; ctx.textAlign = 'left';
    if (off > 0) { ctx.font = font(500, 34, BODY); var t = 'de ' + brl(p.original_price); var tw = ctx.measureText(t).width; strike(ctx, t, -tw / 2, -50); }
    ctx.font = font(700, fit(ctx, brl(p.price), 420, 104, 56, 700, DISPLAY), DISPLAY);
    var pw = ctx.measureText(brl(p.price)).width; ctx.fillText(brl(p.price), -pw / 2, off > 0 ? 40 : 30);
    if (off > 0) pill(ctx, '-' + off + '% OFF', 0, 78, { bg: INK, fg: GOLD, size: 28, align: 'center' });
    ctx.restore();
    // selos à esquerda, só os que cabem antes da etiqueta de preço (que começa em x ~560)
    var sx = 60;
    seals(p, d).concat(rankOf(p, d) ? [p.best_seller_rank + 'º MAIS VENDIDO'] : []).slice(0, 2).forEach(function (s) {
      ctx.font = font(700, 28, BODY);
      if (sx + ctx.measureText(s).width + 52 > 540) return;
      sx += pill(ctx, s, sx, 1130, { bg: '#FFFFFF', fg: shade(c, -0.3), size: 28 }) + 14;
    });
    footer(ctx, d, shade(c, -0.22));
  };

  /** Lista: vários produtos em grade (até 4 na capa), número e preço em cada um, convite para arrastar. */
  T.lista = function (ctx, d) {
    var c = d.color, list = d.products.slice(0, 4), n = d.products.length;
    ctx.fillStyle = shade(c, 0.9); ctx.fillRect(0, 0, W, H);
    var title = (d.title || n + ' ACHADINHOS').toUpperCase();
    ctx.fillStyle = shade(c, -0.2); ctx.textAlign = 'center';
    ctx.font = font(700, fit(ctx, title, 960, 104, 56, 700, DISPLAY), DISPLAY); ctx.fillText(title, W / 2, 150);
    ctx.fillStyle = MUTED; ctx.font = font(500, 36, BODY); ctx.fillText('que valem a pena hoje', W / 2, 205); ctx.textAlign = 'left';
    var cols = list.length === 1 ? 1 : 2, rows = list.length > 2 ? 2 : 1;
    var gx = 60, gy = 250, gw = 960, gh = 950, gap = 30;
    var cw = (gw - gap * (cols - 1)) / cols, ch = (gh - gap * (rows - 1)) / rows;
    list.forEach(function (p, i) {
      var x = gx + (i % cols) * (cw + gap), y = gy + Math.floor(i / cols) * (ch + gap);
      if (list.length === 3 && i === 2) x = gx + (gw - cw) / 2;
      var r3 = rad(d, 36);
      shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, x, y, cw, ch, r3); ctx.fill(); shadow(ctx, false);
      clipped(ctx, x, y, cw, ch, r3, function () { contain(ctx, d.images[i], x + 24, y + 24, cw - 48, ch - 120); });
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x + 46, y + 46, 34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = onColor(c); ctx.textAlign = 'center'; ctx.font = font(700, 38, DISPLAY); ctx.fillText(String(i + 1), x + 46, y + 59); ctx.textAlign = 'left';
      var off = offOf(p, d);
      var range = Number(p.price_max) > Number(p.price);
      var w = pill(ctx, (range ? 'a partir de ' : '') + brl(p.price), x + 24, y + ch - 84, { bg: shade(c, -0.15), fg: onColor(shade(c, -0.15)), size: range ? 26 : 34, family: DISPLAY });
      if (off > 0) pill(ctx, '-' + off + '%', x + 24 + w + 10, y + ch - 80, { bg: GOLD, fg: INK, size: 28 });
    });
    if (n > list.length) pill(ctx, '+' + (n - list.length) + ' no carrossel', W - 60, 1212, { bg: INK, fg: '#FFFFFF', size: 28, align: 'right' });
    footer(ctx, { handle: d.handle, cta: 'ARRASTA PRO LADO' }, c);
  };

  /** Foto em destaque: foto grande no fundo branco, faixa na cor da marca com nome e preço. */
  T.foto = function (ctx, d) {
    var p = d.products[0], c = d.color, fg = onColor(c), off = offOf(p, d);
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
    roundedContain(ctx, d.images[0], 50, 120, 980, 760, rad(d, 0));
    if (d.title) pill(ctx, d.title.toUpperCase(), 60, 40, { bg: c, fg: fg, size: 34, family: DISPLAY, padX: 30 });
    if (off > 0) {
      ctx.fillStyle = GOLD; ctx.beginPath(); ctx.arc(930, 150, 104, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = INK; ctx.textAlign = 'center';
      ctx.font = font(700, fit(ctx, '-' + off + '%', 176, 76, 44, 700, DISPLAY), DISPLAY); ctx.fillText('-' + off + '%', 930, 158);
      ctx.font = font(700, 30, BODY); ctx.fillText('OFF', 930, 200); ctx.textAlign = 'left';
    }
    // faixa de baixo
    ctx.fillStyle = c; roundRect(ctx, 0, 900, W, H - 900, 0); ctx.fill();
    ctx.fillStyle = shade(c, -0.15); ctx.fillRect(0, 900, W, 10);
    var BOTTOM = H - 86 - 26;
    ctx.font = font(600, 42, BODY);
    var lines = wrap(ctx, p.title, 960, 2);
    var s = seals(p, d).map(function (x) { return (x.charAt(0) + x.slice(1).toLowerCase()).replace(/full/i, 'Full'); })
      .concat(rankOf(p, d) ? [p.best_seller_rank + 'º mais vendido'] : []).slice(0, 3);
    // centraliza o bloco (nome, selos, preço) na faixa
    var rangeA = Number(p.price_max) > Number(p.price);
    var est = fit(ctx, (rangeA ? 'a partir de ' : '') + brl(p.price), off > 0 ? 680 : 960, 104, 52, 700, DISPLAY);
    var total = 44 + (lines.length - 1) * 52 + 18 + (s.length ? 46 : 0) + est * 0.95;
    var top0 = 916 + Math.max(0, (BOTTOM - 916 - total) / 2);
    ctx.fillStyle = fg; ctx.font = font(600, 42, BODY);
    lines.forEach(function (l, i) { ctx.fillText(l, 60, top0 + 44 + i * 52); });
    var y = top0 + 44 + (lines.length - 1) * 52 + 18;
    if (s.length) {
      var st = s.join('  ·  ');
      ctx.globalAlpha = 0.85; ctx.font = font(600, fit(ctx, st, 960, 28, 20, 600, BODY), BODY); ctx.fillText(st, 60, y + 32); ctx.globalAlpha = 1;
      y += 46;
    }
    var range = Number(p.price_max) > Number(p.price);
    var priceTxt = (range ? 'a partir de ' : '') + brl(p.price);
    var oldTxt = off > 0 ? 'de ' + brl(p.original_price) : '';
    // preço: o maior que cabe na largura e no espaço que sobrou
    var room = BOTTOM - y;
    var size = Math.min(fit(ctx, priceTxt, oldTxt ? 680 : 960, 104, 52, 700, DISPLAY), Math.max(52, room - 8));
    ctx.font = font(700, size, DISPLAY);
    var base = Math.min(y + size * 0.95, BOTTOM);
    ctx.fillText(priceTxt, 58, base);
    if (oldTxt) {
      var pw = ctx.measureText(priceTxt).width;
      ctx.font = font(500, 34, BODY); ctx.globalAlpha = 0.85;
      strike(ctx, oldTxt, Math.min(58 + pw + 24, W - 60 - ctx.measureText(oldTxt).width), base - 6); ctx.globalAlpha = 1;
    }
    footer(ctx, d, shade(c, -0.25));
  };

  /** Baixou o preço: fundo escuro, desconto gigante em amarelo, foto em cartão e "de/por". */
  T.relampago = function (ctx, d) {
    var p = d.products[0], c = d.color, off = offOf(p, d);
    ctx.fillStyle = '#141418'; ctx.fillRect(0, 0, W, H);
    // raios de luz atrás da foto
    ctx.save(); ctx.translate(W / 2, 620); ctx.fillStyle = 'rgba(255,201,60,0.07)';
    for (var i = 0; i < 12; i++) { ctx.rotate(Math.PI / 6); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(900, -120); ctx.lineTo(900, 120); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    var title = (d.title || (off > 0 ? 'BAIXOU O PREÇO!' : 'ACHADO DO DIA')).toUpperCase();
    ctx.fillStyle = GOLD; ctx.textAlign = 'center';
    ctx.font = font(700, fit(ctx, title, 960, 120, 56, 700, DISPLAY), DISPLAY); ctx.fillText(title, W / 2, 150);
    ctx.textAlign = 'left';
    var r4 = rad(d, 48);
    shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, 150, 210, 780, 640, r4); ctx.fill(); shadow(ctx, false);
    clipped(ctx, 150, 210, 780, 640, r4, function () { contain(ctx, d.images[0], 190, 245, 700, 570); });
    if (off > 0) {
      ctx.save(); ctx.translate(890, 250); ctx.rotate(0.18);
      ctx.fillStyle = c; roundRect(ctx, -150, -70, 300, 140, 30); ctx.fill();
      ctx.fillStyle = onColor(c); ctx.textAlign = 'center'; ctx.font = font(700, 84, DISPLAY); ctx.fillText('-' + off + '%', 0, 28);
      ctx.restore(); ctx.textAlign = 'left';
    }
    ctx.fillStyle = '#FFFFFF'; ctx.font = font(600, 40, BODY); ctx.textAlign = 'center';
    var lines = wrap(ctx, p.title, 940, 2);
    lines.forEach(function (l, j) { ctx.fillText(l, W / 2, 925 + j * 50); });
    var y = 925 + lines.length * 50;
    if (off > 0) { ctx.fillStyle = '#A0A0AA'; ctx.font = font(500, 40, BODY); var t = 'de ' + brl(p.original_price); var tw = ctx.measureText(t).width; ctx.textAlign = 'left'; strike(ctx, t, W / 2 - tw / 2, y + 40); y += 50; }
    var range = Number(p.price_max) > Number(p.price);
    var price = (range ? 'a partir de ' : 'por ') + brl(p.price);
    ctx.textAlign = 'center'; ctx.fillStyle = GOLD;
    ctx.font = font(700, fit(ctx, price, 960, 120, 60, 700, DISPLAY), DISPLAY); ctx.fillText(price, W / 2, Math.min(y + 120, H - 120));
    ctx.textAlign = 'left';
    footer(ctx, d, GOLD);
  };

  /**
   * Clean: fundo claro, foto solta, tipografia simples e um detalhe na cor da marca.
   * Layout que se ajusta: os blocos de texto são medidos e empilhados de baixo para cima (nada se sobrepõe);
   * a foto ocupa o espaço que sobra em cima.
   */
  T.minimal = function (ctx, d) {
    var p = d.products[0], c = d.color, off = offOf(p, d);
    var X = 60, MAXW = W - 120, BOTTOM = H - 86 - 34; // acima do rodapé, com respiro
    ctx.fillStyle = '#F7F5F0'; ctx.fillRect(0, 0, W, H);
    var range = Number(p.price_max) > Number(p.price);
    var s = seals(p, d).map(function (x) { return x.charAt(0) + x.slice(1).toLowerCase(); }).map(function (x) { return x.replace(/full/i, 'Full'); })
      .concat(rankOf(p, d) ? [p.best_seller_rank + 'º mais vendido'] : []).slice(0, 3);
    // medidas (de baixo para cima)
    ctx.font = font(700, 50, DISPLAY);
    var lines = wrap(ctx, p.title, MAXW, 2);
    var priceTxt = brl(p.price);
    var pill = off > 0 ? '-' + off + '%' : '';
    ctx.font = font(700, 34, BODY);
    var pillW = pill ? ctx.measureText(pill).width + 52 : 0;
    var oldTxt = off > 0 ? brl(p.original_price) : '';
    ctx.font = font(500, 36, BODY);
    var oldW = oldTxt ? ctx.measureText(oldTxt).width + 24 : 0;
    // preço: o maior tamanho que cabe ao lado do "de" e do selo de desconto
    var priceSize = fit(ctx, priceTxt, MAXW - oldW - pillW - 20, 100, 56, 700, DISPLAY);
    var H_SEALS = s.length ? 42 : 0;
    var H_PRICE = priceSize + 8;
    var H_FROM = range ? 40 : 0;
    var H_TITLE = lines.length * 60;
    var H_LABEL = 50;
    var GAP = 20;
    var top = BOTTOM - H_SEALS - (s.length ? 14 : 0) - H_PRICE - H_FROM - GAP - H_TITLE - GAP - H_LABEL;
    // foto no espaço de cima
    roundedContain(ctx, d.images[0], 90, 70, W - 180, Math.max(360, top - 100), rad(d, 0));
    var y = top;
    // rótulo
    ctx.fillStyle = c; ctx.fillRect(X, y + 14, 90, 10);
    if (d.title) { ctx.fillStyle = shade(c, -0.25); ctx.font = font(700, 30, BODY); ctx.fillText(d.title.toUpperCase(), X + 110, y + 30); }
    y += H_LABEL + GAP;
    // nome
    ctx.fillStyle = INK; ctx.font = font(700, 50, DISPLAY);
    lines.forEach(function (l, i) { ctx.fillText(l, X, y + 44 + i * 60); });
    y += H_TITLE + GAP;
    // "a partir de"
    if (range) { ctx.fillStyle = MUTED; ctx.font = font(600, 32, BODY); ctx.fillText('a partir de', X, y + 30); y += H_FROM; }
    // preço, "de" riscado ao lado e selo de desconto à direita, na mesma linha
    var base = y + priceSize * 0.82;
    ctx.fillStyle = shade(c, -0.2); ctx.font = font(700, priceSize, DISPLAY); ctx.fillText(priceTxt, X - 4, base);
    var pw = ctx.measureText(priceTxt).width;
    if (oldTxt) { ctx.fillStyle = MUTED; ctx.font = font(500, 36, BODY); strike(ctx, oldTxt, X + pw + 20, base - 6); }
    if (pill) pill2(ctx, pill, W - X, base - priceSize * 0.42 - 29);
    y += H_PRICE;
    // selos, em uma linha abaixo do preço
    if (s.length) {
      var sealTxt = s.join('  ·  ');
      ctx.fillStyle = MUTED; ctx.font = font(600, fit(ctx, sealTxt, MAXW, 28, 20, 600, BODY), BODY);
      ctx.fillText(sealTxt, X, y + 14 + 30);
    }
    footer(ctx, d, INK);
  };
  /** Selo de desconto (pílula escura) alinhado à direita. */
  function pill2(ctx, text, right, y) { pill(ctx, text, right, y, { bg: INK, fg: '#FFFFFF', size: 34, align: 'right' }); }

  /**
   * Premium: curadoria elegante. Fundo off-white, filete dourado, foto grande sem moldura chamativa,
   * nome em serifa, preço sóbrio, desconto discreto ("antes R$ X") e selos em texto pequeno.
   */
  var SERIF = '"Playfair Display", Georgia, "Times New Roman", serif';
  var CREAM = '#F6F1EA', GOLDLINE = '#B08D57', DEEP = '#1F1B16';
  /* ---------- foto da capa Premium: produto "solto" no fundo ou moldura em arco ---------- */

  /** A foto tem fundo branco/claro liso (foto de loja)? Olha a borda da imagem em miniatura. */
  function plainBackground(img) {
    if (!img) return false;
    try {
      var c = document.createElement('canvas'); c.width = 40; c.height = 40;
      var x = c.getContext('2d'); x.drawImage(img, 0, 0, 40, 40);
      var px = x.getImageData(0, 0, 40, 40).data, n = 0, light = 0;
      for (var i = 0; i < 40; i++) {
        [[i, 0], [i, 39], [0, i], [39, i]].forEach(function (p) {
          var k = (p[1] * 40 + p[0]) * 4, r = px[k], g = px[k + 1], b = px[k + 2];
          n++; if (r > 225 && g > 225 && b > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 18) light++;
        });
      }
      return light / n > 0.8;
    } catch (_) { return false; } // imagem de outro endereço sem permissão: trata como foto de ambiente
  }

  /** Onde o produto termina embaixo (fração da altura), ignorando a margem branca da foto. */
  function productBottom(img) {
    try {
      var c = document.createElement('canvas'); c.width = 80; c.height = 80;
      var x = c.getContext('2d'); x.drawImage(img, 0, 0, 80, 80);
      var px = x.getImageData(0, 0, 80, 80).data;
      for (var row = 79; row >= 0; row--) {
        for (var col = 0; col < 80; col++) {
          var k = (row * 80 + col) * 4;
          if (px[k] < 215 || px[k + 1] < 215 || px[k + 2] < 215) return (row + 1) / 80;
        }
      }
    } catch (_) { /* sem acesso aos pixels */ }
    return 1;
  }

  /** Retângulo onde a imagem cabe inteira (sem cortar). */
  function containRect(img, x, y, w, h) {
    var k = Math.min(w / img.width, h / img.height), iw = img.width * k, ih = img.height * k;
    return { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih };
  }

  /** Arco (topo arredondado), como as molduras de lojas de decoração. */
  function archPath(ctx, x, y, w, h) {
    var r = w / 2;
    ctx.beginPath();
    ctx.moveTo(x, y + h); ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, 0);
    ctx.lineTo(x + w, y + h); ctx.closePath();
  }

  /**
   * Foto do produto na área (x, y, w, h).
   * Fundo branco: o branco vira a cor de fundo (multiplicar) e o produto ganha sombra suave embaixo.
   * Foto de ambiente: preenche um arco com filete dourado.
   */
  function premiumPhoto(ctx, img, x, y, w, h, line, shape, radius) {
    if (!img) return;
    var mode = shape === 'free' || shape === 'arch' || shape === 'round' ? shape : (plainBackground(img) ? 'free' : 'arch');
    if (mode === 'round') {
      // retângulo de cantos arredondados (o usuário ajusta o arredondamento), foto preenchendo, filete dourado
      var rr = radius == null || radius === '' ? 48 : Math.max(0, Math.min(300, Number(radius) || 0));
      var bx = x + 50, bw = w - 100; h -= 24; // respiro entre a moldura e o nome
      clipped(ctx, bx, y, bw, h, rr, function () {
        var k = Math.max(bw / img.width, h / img.height), iw = img.width * k, ih = img.height * k;
        ctx.drawImage(img, bx + (bw - iw) / 2, y + (h - ih) / 2, iw, ih);
      });
      ctx.strokeStyle = line; ctx.lineWidth = 2; roundRect(ctx, bx - 14, y - 14, bw + 28, h + 28, rr + 14); ctx.stroke();
      return;
    }
    if (mode === 'free' && !plainBackground(img)) { contain(ctx, img, x + 30, y + 10, w - 60, h - 50); return; }
    if (mode === 'free') {
      var r = containRect(img, x + 30, y + 10, w - 60, h - 50);
      var fy = r.y + r.h * productBottom(img) + 4; // "chão": logo abaixo do produto
      // sombra elíptica no chão
      var g = ctx.createRadialGradient(r.x + r.w / 2, fy, 4, r.x + r.w / 2, fy, r.w * 0.45);
      g.addColorStop(0, 'rgba(60,45,25,0.28)'); g.addColorStop(1, 'rgba(60,45,25,0)');
      ctx.save(); ctx.translate(r.x + r.w / 2, fy); ctx.scale(1, 0.14); ctx.translate(-(r.x + r.w / 2), -fy);
      ctx.fillStyle = g; ctx.fillRect(r.x - 40, fy - r.w * 0.45, r.w + 80, r.w * 0.9); ctx.restore();
      ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(img, r.x, r.y, r.w, r.h); ctx.restore();
      return;
    }
    // arco centralizado, proporção elegante (mais alto que largo)
    var aw = Math.min(w, h * 0.78), ax = x + (w - aw) / 2;
    ctx.save(); archPath(ctx, ax, y, aw, h); ctx.clip();
    var k = Math.max(aw / img.width, h / img.height), iw = img.width * k, ih = img.height * k;
    ctx.drawImage(img, ax + (aw - iw) / 2, y + (h - ih) / 2, iw, ih);
    ctx.restore();
    ctx.strokeStyle = line; ctx.lineWidth = 2;
    archPath(ctx, ax - 14, y - 14, aw + 28, h + 14); ctx.stroke();
  }

  T.premium = function (ctx, d) {
    var p = d.products[0], off = offOf(p, d);
    var LABEL = '#8C6B3F', SOFT = '#5E5241'; // dourado e cinza-quente mais escuros: contraste para leitura
    var spacing = function (v) { if (ctx.letterSpacing !== undefined) ctx.letterSpacing = v; };
    ctx.fillStyle = CREAM; ctx.fillRect(0, 0, W, H);
    // moldura fina dourada
    ctx.strokeStyle = GOLDLINE; ctx.lineWidth = 2; ctx.strokeRect(36, 36, W - 72, H - 72);
    // rótulo
    var label = (d.title || 'SELEÇÃO PREMIUM').toUpperCase();
    ctx.fillStyle = LABEL; ctx.textAlign = 'center';
    spacing('5px'); ctx.font = font(600, fit(ctx, label, 820, 34, 24, 600, BODY), BODY);
    ctx.fillText(label, W / 2, 108);
    spacing('0px');
    ctx.fillStyle = GOLDLINE; ctx.fillRect(W / 2 - 50, 128, 100, 3);
    // foto
    premiumPhoto(ctx, d.images[0], 110, 170, W - 220, 600, GOLDLINE, d.shape, d.radius);
    // nome em serifa, maior
    ctx.fillStyle = DEEP; ctx.font = font(600, 64, SERIF);
    var lines = wrap(ctx, p.title, 900, 2);
    lines.forEach(function (l, i) { ctx.fillText(l, W / 2, 846 + i * 72); });
    var y = 846 + (lines.length - 1) * 72 + 24;
    // selos legíveis
    var s = seals(p, d).map(function (x) { return (x.charAt(0) + x.slice(1).toLowerCase()).replace(/full/, 'Full'); });
    if (rankOf(p, d)) s.push(p.best_seller_rank + 'º mais vendido');
    if (s.length) {
      var sealTxt = s.slice(0, 3).join('  ·  ');
      ctx.fillStyle = SOFT; ctx.font = font(500, fit(ctx, sealTxt, 900, 34, 26, 500, BODY), BODY);
      ctx.fillText(sealTxt, W / 2, y + 44);
      y += 62;
    }
    // preço
    var range = Number(p.price_max) > Number(p.price);
    var priceTxt = (range ? 'a partir de ' : '') + brl(p.price);
    // números sem serifa: os da serifa "descem" da linha e cansam a leitura
    spacing('1px'); ctx.fillStyle = DEEP; ctx.font = font(600, fit(ctx, priceTxt, 860, 92, 60, 600, BODY), BODY);
    var py = Math.min(y + 116, H - 200);
    ctx.fillText(priceTxt, W / 2, py); spacing('0px');
    if (off > 0) { ctx.fillStyle = SOFT; ctx.font = font(500, 36, BODY); ctx.fillText('antes ' + brl(p.original_price), W / 2, py + 62); }
    // rodapé
    ctx.fillStyle = GOLDLINE; ctx.fillRect(96, H - 108, W - 192, 2);
    var foot = ((d.cta || 'LINK NA BIO') + (d.handle ? '  ·  @' + d.handle : '')).toUpperCase();
    spacing('2px');
    var fs2 = 30; ctx.font = font(600, fs2, BODY);
    while (fs2 > 20 && ctx.measureText(foot).width > 900) { fs2 -= 1; ctx.font = font(600, fs2, BODY); } // cabe dentro da moldura
    ctx.fillStyle = DEEP; ctx.fillText(foot, W / 2, H - 60);
    spacing('0px');
    ctx.textAlign = 'left';
  };

  /**
   * Gancho (editorial): foto de ambiente na capa inteira com véu quente, frase de impacto em serifa maiúscula,
   * linha em letra cursiva e o nome da loja em destaque, ornamento com coração e o @ discreto.
   * Foto de loja (fundo branco): fundo bege quente com o produto embaixo, para não ficar "recortado".
   */
  var SCRIPT = '"Great Vibes", "Segoe Script", cursive';
  T.editorial = function (ctx, d) {
    var p = d.products[0], img = d.images[0];
    var plain = img && plainBackground(img);
    // fundo
    if (img && !plain) {
      var k = Math.max(W / img.width, H / img.height), iw = img.width * k, ih = img.height * k;
      ctx.drawImage(img, (W - iw) / 2, (H - ih) / 2, iw, ih);
    } else {
      var bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#5A4636'); bg.addColorStop(0.55, '#8C7259'); bg.addColorStop(1, '#C9B49A');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      if (img) {
        var r = containRect(img, 170, 700, W - 340, 520);
        var fy = r.y + r.h * productBottom(img) + 4;
        var g0 = ctx.createRadialGradient(W / 2, fy, 4, W / 2, fy, r.w * 0.5);
        g0.addColorStop(0, 'rgba(40,25,10,0.45)'); g0.addColorStop(1, 'rgba(40,25,10,0)');
        ctx.save(); ctx.translate(W / 2, fy); ctx.scale(1, 0.14); ctx.translate(-W / 2, -fy); ctx.fillStyle = g0; ctx.fillRect(0, fy - r.w * 0.5, W, r.w); ctx.restore();
        ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(img, r.x, r.y, r.w, r.h); ctx.restore();
      }
    }
    // véu quente: escurece o centro (onde vai o texto) e as bordas
    ctx.fillStyle = 'rgba(28,18,10,0.30)'; ctx.fillRect(0, 0, W, H);
    var v = ctx.createRadialGradient(W / 2, H * 0.36, 60, W / 2, H * 0.36, W * 0.85);
    v.addColorStop(0, 'rgba(20,12,6,0.40)'); v.addColorStop(1, 'rgba(20,12,6,0.05)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    var shade2 = ctx.createLinearGradient(0, H * 0.75, 0, H);
    shade2.addColorStop(0, 'rgba(15,10,5,0)'); shade2.addColorStop(1, 'rgba(15,10,5,0.45)');
    ctx.fillStyle = shade2; ctx.fillRect(0, H * 0.75, W, H * 0.25);

    var line1 = String(d.title || 'PARECE QUE FOI CARÍSSIMO').toUpperCase();
    var line2 = d.script == null ? (p.marketplace === 'ML' ? 'mas eu garimpei no' : 'mas eu garimpei na') : String(d.script);
    var line3 = d.word == null ? (p.marketplace === 'ML' ? 'Mercado Livre' : 'Shopee') : String(d.word);
    ctx.textAlign = 'center'; ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 2;
    // frase em serifa maiúscula: até 2 linhas, o maior tamanho que couber
    var size = 104, lines;
    do { ctx.font = font(500, size, SERIF); lines = wrap(ctx, line1, 920, 2); size -= 4; }
    while (size > 54 && lines.some(function (l) { return ctx.measureText(l).width > 920; }) );
    size += 4;
    var y = (img && plain) ? 220 : 330;
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '2px';
    lines.forEach(function (l, i) { ctx.fillText(l, W / 2, y + i * size * 1.08); });
    if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';
    y += (lines.length - 1) * size * 1.08;
    // linha cursiva
    if (line2) {
      ctx.font = font(400, fit(ctx, line2, 960, 110, 60, 400, SCRIPT), SCRIPT);
      ctx.fillText(line2, W / 2, y + 120);
      y += 120;
    }
    // destaque final (nome da loja ou preço)
    if (line3) {
      ctx.font = font(500, fit(ctx, line3, 900, 116, 60, 500, SERIF), SERIF);
      ctx.fillText(line3, W / 2, y + 128);
      y += 128;
    }
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    // ornamento: linhas finas com coração
    var oy = y + 54;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(W / 2 - 170, oy, 140, 2); ctx.fillRect(W / 2 + 30, oy, 140, 2);
    ctx.save(); ctx.translate(W / 2, oy + 1); ctx.scale(0.9, 0.9);
    ctx.beginPath(); ctx.moveTo(0, 12); ctx.bezierCurveTo(-26, -8, -12, -24, 0, -10); ctx.bezierCurveTo(12, -24, 26, -8, 0, 12); ctx.fill(); ctx.restore();
    // preço discreto (opcional)
    if (d.opts && d.opts.price) {
      var range = Number(p.price_max) > Number(p.price);
      ctx.font = font(600, 34, BODY); ctx.fillStyle = 'rgba(255,255,255,0.92)';
      if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '3px';
      ctx.fillText(((range ? 'a partir de ' : 'por ') + brl(p.price)).toUpperCase(), W / 2, oy + 74);
      if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';
    }
    // @ e chamada, bem discretos, embaixo
    ctx.font = font(500, 28, BODY); ctx.fillStyle = 'rgba(255,255,255,0.88)';
    var foot = (d.cta && d.cta !== 'LINK NA BIO' ? d.cta.charAt(0) + d.cta.slice(1).toLowerCase() + '   ·   ' : '') + (d.handle ? '@' + d.handle : '');
    if (foot) ctx.fillText(foot, W / 2, H - 70);
    ctx.textAlign = 'left';
  };

  /* ---------- formatos ---------- */
  var FORMATS = { feed: [1080, 1350], story: [1080, 1920], square: [1080, 1080] };

  /**
   * Desenha a capa no canvas. d = { template, format, title, color, handle, cta, opts, products: [...], images: [Image|null] }.
   * O desenho é feito em 1080x1350 (feed); "story" e "square" encaixam esse desenho e completam o espaço.
   */
  function render(canvas, d) {
    var size = FORMATS[d.format] || FORMATS.feed;
    canvas.width = size[0]; canvas.height = size[1];
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size[0], size[1]);
    var draw = T[d.template] || T.oferta;
    if (!FORMATS[d.format] || d.format === 'feed') return draw(ctx, d);
    var base = document.createElement('canvas'); base.width = W; base.height = H;
    // nos Stories o link fica no adesivo, logo abaixo da capa
    var bctx = base.getContext('2d');
    draw(bctx, d.format === 'story' && (!d.cta || d.cta === 'LINK NA BIO') ? Object.assign({}, d, { cta: 'LINK AQUI EMBAIXO' }) : d);
    var c = d.color, bg;
    try { var px = bctx.getImageData(4, 4, 1, 1).data; bg = hex([px[0], px[1], px[2]]); } catch (_) { bg = shade(c, 0.9); } // cor do fundo do modelo
    if (d.format === 'square') {
      ctx.fillStyle = bg; ctx.fillRect(0, 0, 1080, 1080);
      var k = 1080 / H; ctx.drawImage(base, (1080 - W * k) / 2, 0, W * k, 1080);
      return null;
    }
    // Stories 9:16: faixa de cima com o título, capa no meio e espaço embaixo para o adesivo de link
    var g = ctx.createLinearGradient(0, 0, 0, 1920);
    g.addColorStop(0, c); g.addColorStop(1, shade(c, -0.25));
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1080, 1920);
    var fg = onColor(c);
    ctx.fillStyle = fg; ctx.textAlign = 'center';
    ctx.font = font(700, 64, DISPLAY); ctx.fillText('✨ NOVO ACHADINHO ✨', 540, 150);
    ctx.font = font(500, 34, BODY); ctx.fillText(d.handle ? '@' + d.handle : 'corre que é oferta', 540, 205);
    var s = 0.86, bw = W * s, bh = H * s;
    shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, (1080 - bw) / 2, 250, bw, bh, 36); ctx.fill(); shadow(ctx, false);
    ctx.save(); roundRect(ctx, (1080 - bw) / 2, 250, bw, bh, 36); ctx.clip();
    ctx.drawImage(base, (1080 - bw) / 2, 250, bw, bh); ctx.restore();
    // área do adesivo de link (o Instagram não deixa colocar o link pela imagem; aqui fica o lugar dele)
    var ty = 250 + bh + 60;
    ctx.setLineDash([18, 14]); ctx.strokeStyle = fg; ctx.lineWidth = 4; ctx.globalAlpha = 0.85;
    roundRect(ctx, 190, ty, 700, 150, 75); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.font = font(700, 40, DISPLAY); ctx.fillText(d.cta && d.cta !== 'LINK NA BIO' ? d.cta : 'TOQUE NO LINK 👇', 540, ty + 90);
    ctx.textAlign = 'left';
    return null;
  }

  window.GarimpoCover = { W: W, H: H, FORMATS: FORMATS, render: render, loadImage: loadImage, fontsReady: fontsReady, templates: Object.keys(T) };
})();
