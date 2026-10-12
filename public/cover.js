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
  function seals(p) {
    var s = [];
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
    var p = d.products[0], c = d.color, off = discount(p);
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
    if (p.best_seller_rank) pill(ctx, p.best_seller_rank + 'º MAIS VENDIDO', 92, 832, { bg: GOLD, fg: INK, size: 30 });
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
    seals(p).slice(0, 2).forEach(function (s, i, all) {
      pill(ctx, s, 1020, y + 112 - (all.length - i) * 66 + 8, { bg: '#FFFFFF', fg: shade(c, -0.25), size: 28, align: 'right' });
    });
    footer(ctx, d, c);
  };

  /** Achadinho: fundo na cor da marca, título grande, foto central e etiqueta de preço inclinada. */
  T.achadinho = function (ctx, d) {
    var p = d.products[0], c = d.color, fg = onColor(c), off = discount(p);
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
    seals(p).concat(p.best_seller_rank ? [p.best_seller_rank + 'º MAIS VENDIDO'] : []).slice(0, 2).forEach(function (s) {
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
      var off = discount(p);
      var range = Number(p.price_max) > Number(p.price);
      var w = pill(ctx, (range ? 'a partir de ' : '') + brl(p.price), x + 24, y + ch - 84, { bg: shade(c, -0.15), fg: onColor(shade(c, -0.15)), size: range ? 26 : 34, family: DISPLAY });
      if (off > 0) pill(ctx, '-' + off + '%', x + 24 + w + 10, y + ch - 80, { bg: GOLD, fg: INK, size: 28 });
    });
    if (n > list.length) pill(ctx, '+' + (n - list.length) + ' no carrossel', W - 60, 1212, { bg: INK, fg: '#FFFFFF', size: 28, align: 'right' });
    footer(ctx, { handle: d.handle, cta: 'ARRASTA PRO LADO' }, c);
  };

  /**
   * Desenha a capa no canvas. d = { template, title, color, handle, products: [...], images: [Image|null] }.
   */
  function render(canvas, d) {
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    (T[d.template] || T.oferta)(ctx, d);
  }

  window.GarimpoCover = { W: W, H: H, render: render, loadImage: loadImage, fontsReady: fontsReady, templates: Object.keys(T) };
})();
