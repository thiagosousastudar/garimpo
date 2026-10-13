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
      document.fonts.load('600 54px "Cormorant Garamond"'),
      document.fonts.load('500 80px "Cormorant Garamond"'),
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
    shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, 60, 160, 960, 740, 44); ctx.fill(); shadow(ctx, false);
    contain(ctx, d.images[0], 100, 195, 880, 670);
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
    shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, 130, 280, 820, 820, 60); ctx.fill(); shadow(ctx, false);
    contain(ctx, d.images[0], 175, 325, 730, 730);
    // etiqueta de preço
    ctx.save(); ctx.translate(800, 1085); ctx.rotate(-0.1);
    shadow(ctx, true); ctx.fillStyle = GOLD; roundRect(ctx, -235, -120, 470, 240, 34); ctx.fill(); shadow(ctx, false);
    if (Number(p.price_max) > Number(p.price)) pill(ctx, 'A PARTIR DE', 0, -150, { bg: INK, fg: GOLD, size: 26, align: 'center' });
    ctx.fillStyle = INK; ctx.textAlign = 'left';
    if (off > 0) { ctx.font = font(500, 34, BODY); var t = 'de ' + brl(p.original_price); var tw = ctx.measureText(t).width; strike(ctx, t, -tw / 2, -50); }
    ctx.font = font(700, fit(ctx, brl(p.price), 420, 104, 56, 700, DISPLAY), DISPLAY);
    var pw = ctx.measureText(brl(p.price)).width; ctx.fillText(brl(p.price), -pw / 2, off > 0 ? 50 : 30);
    if (off > 0) pill(ctx, '-' + off + '% OFF', 0, 66, { bg: INK, fg: GOLD, size: 28, align: 'center' });
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
      shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, x, y, cw, ch, 36); ctx.fill(); shadow(ctx, false);
      contain(ctx, d.images[i], x + 24, y + 24, cw - 48, ch - 120);
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
    contain(ctx, d.images[0], 50, 120, 980, 760);
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
    ctx.fillStyle = fg; ctx.font = font(600, 42, BODY);
    var lines = wrap(ctx, p.title, 960, 2);
    lines.forEach(function (l, i) { ctx.fillText(l, 60, 975 + i * 52); });
    var y = 975 + lines.length * 52 + 10;
    var range = Number(p.price_max) > Number(p.price);
    if (off > 0) { ctx.font = font(500, 36, BODY); ctx.globalAlpha = 0.8; strike(ctx, 'de ' + brl(p.original_price), 60, y + 30); ctx.globalAlpha = 1; y += 44; }
    ctx.font = font(700, fit(ctx, (range ? 'a partir de ' : '') + brl(p.price), 640, 112, 60, 700, DISPLAY), DISPLAY);
    ctx.fillText((range ? 'a partir de ' : '') + brl(p.price), 58, Math.min(y + 100, H - 110));
    seals(p, d).concat(rankOf(p, d) ? [p.best_seller_rank + 'º MAIS VENDIDO'] : []).slice(0, 2).forEach(function (s, i) {
      pill(ctx, s, 1020, 1050 + i * 66, { bg: '#FFFFFF', fg: shade(c, -0.3), size: 26, align: 'right' });
    });
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
    shadow(ctx, true); ctx.fillStyle = '#FFFFFF'; roundRect(ctx, 150, 210, 780, 640, 48); ctx.fill(); shadow(ctx, false);
    contain(ctx, d.images[0], 190, 245, 700, 570);
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

  /** Clean: fundo claro, foto solta, tipografia simples e um detalhe na cor da marca. */
  T.minimal = function (ctx, d) {
    var p = d.products[0], c = d.color, off = offOf(p, d);
    ctx.fillStyle = '#F7F5F0'; ctx.fillRect(0, 0, W, H);
    contain(ctx, d.images[0], 90, 90, 900, 780);
    ctx.fillStyle = c; ctx.fillRect(60, 910, 90, 10);
    if (d.title) { ctx.fillStyle = shade(c, -0.25); ctx.font = font(700, 30, BODY); ctx.fillText(d.title.toUpperCase(), 170, 925); }
    ctx.fillStyle = INK; ctx.font = font(700, 50, DISPLAY);
    var lines = wrap(ctx, p.title, 960, 2);
    lines.forEach(function (l, i) { ctx.fillText(l, 60, 1000 + i * 60); });
    var y = 1000 + lines.length * 60 + 20;
    var range = Number(p.price_max) > Number(p.price);
    ctx.fillStyle = shade(c, -0.2);
    ctx.font = font(700, fit(ctx, brl(p.price), 520, 100, 60, 700, DISPLAY), DISPLAY);
    var label = (range ? 'a partir de ' : '');
    if (label) { ctx.font = font(600, 34, BODY); ctx.fillText(label, 60, y + 10); y += 30; ctx.font = font(700, fit(ctx, brl(p.price), 520, 100, 60, 700, DISPLAY), DISPLAY); }
    ctx.fillText(brl(p.price), 56, y + 80);
    var pw = ctx.measureText(brl(p.price)).width;
    if (off > 0) {
      ctx.fillStyle = MUTED; ctx.font = font(500, 36, BODY); strike(ctx, brl(p.original_price), 80 + pw, y + 78);
      pill(ctx, '-' + off + '%', 1020, y + 30, { bg: INK, fg: '#FFFFFF', size: 34, align: 'right' });
    }
    var s = seals(p, d).concat(rankOf(p, d) ? [p.best_seller_rank + 'º MAIS VENDIDO'] : []);
    if (s.length) { ctx.fillStyle = MUTED; ctx.font = font(600, 26, BODY); ctx.fillText(s.slice(0, 3).join('  ·  '), 60, Math.min(y + 135, H - 110)); }
    footer(ctx, d, INK);
  };

  /**
   * Premium: curadoria elegante. Fundo off-white, filete dourado, foto grande sem moldura chamativa,
   * nome em serifa, preço sóbrio, desconto discreto ("antes R$ X") e selos em texto pequeno.
   */
  var SERIF = '"Cormorant Garamond", Georgia, "Times New Roman", serif';
  var CREAM = '#F6F1EA', GOLDLINE = '#B08D57', DEEP = '#1F1B16';
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
    ctx.fillStyle = '#FFFFFF'; shadow(ctx, true); roundRect(ctx, 110, 160, W - 220, 600, 8); ctx.fill(); shadow(ctx, false);
    contain(ctx, d.images[0], 140, 186, W - 280, 548);
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
