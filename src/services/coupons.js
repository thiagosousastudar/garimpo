/**
 * Cupons: cadastrados pelo usuário (as lojas não liberam cupons por API), conferidos no app da loja.
 * - parseCoupons: lê uma mensagem colada (grupo, e-mail, print transcrito) e sugere código, %, mínimo e limite.
 *   Links da mensagem NÃO são aproveitados: são de afiliado de outra pessoa; o link é sempre o do usuário.
 * - roundupText: a mensagem "cupons do dia" (WhatsApp, Telegram, Instagram), só com cupons válidos.
 * - bestCouponFor: o cupom que combina com um produto (mesma loja, compra mínima atendida).
 */
const { HttpError, parseNum } = require('../util');

const TZ = process.env.APP_TZ || 'America/Sao_Paulo';
const MARKETS = { ML: 'MERCADO LIVRE', SH: 'SHOPEE' };
const MAX_COUPONS = 200;

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: Number(v) % 1 ? 2 : 0 });

/** Data de hoje no fuso do app (AAAA-MM-DD). */
function todayLocal(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
const dateStr = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);

/** Situação do cupom hoje: 'valido', 'hoje' (vence hoje), 'vencido' ou 'pausado'. */
function statusOf(c, today = todayLocal()) {
  if (!c.active) return 'pausado';
  const exp = dateStr(c.expires_on);
  if (!exp) return 'valido';
  if (exp < today) return 'vencido';
  return exp === today ? 'hoje' : 'valido';
}
const usable = (c, today) => ['valido', 'hoje'].includes(statusOf(c, today));

/* ---------- leitura de mensagem colada ---------- */

// Palavras em maiúsculas que aparecem nas mensagens e não são códigos
const STOP = new Set(['CUPOM', 'CUPONS', 'MERCADO', 'LIVRE', 'SHOPEE', 'OFF', 'ATIVE', 'AQUI', 'LIMITE', 'FRETE', 'GRATIS', 'GRÁTIS', 'HOJE', 'VENCE',
  'DESCONTO', 'DESCONTOS', 'COMPRA', 'MINIMA', 'MÍNIMA', 'ACIMA', 'PRODUTOS', 'SELECIONADOS', 'CONFERIR', 'LINK', 'NOVO', 'NOVOS', 'MELI', 'PIX',
  'APP', 'VALIDO', 'VÁLIDO', 'ATE', 'ATÉ', 'EM', 'COM', 'DE', 'DO', 'DA', 'PARA', 'BRL', 'USE', 'CODIGO', 'CÓDIGO', 'RESGATE', 'ATIVAR', 'CLIQUE']);

const MONEY = 'R\\$\\s*([\\d.]+(?:,\\d{1,2})?)';
const money = (s) => parseNum(s);

/** Detalhes de desconto num trecho de texto (o que achar). */
function detailsIn(text) {
  const t = String(text);
  const out = {};
  const pct = t.match(/(\d{1,2})\s*%/);
  if (pct) { out.kind = 'percent'; out.amount = Number(pct[1]); }
  const val = t.match(new RegExp(`${MONEY}\\s*(?:de\\s*)?(?:off|desconto)`, 'i'));
  if (!pct && val) { out.kind = 'value'; out.amount = money(val[1]); }
  const lim = t.match(new RegExp(`(?:limite(?:\\s*de)?|at[ée])\\s*${MONEY}`, 'i'));
  if (lim) out.max_discount = money(lim[1]);
  const min = t.match(new RegExp(`(?:compra\\s*m[íi]nima(?:\\s*de)?|m[íi]nimo(?:\\s*de)?|acima\\s*de|a\\s*partir\\s*de|em\\s*compras\\s*(?:a\\s*partir\\s*)?de|\\bem)\\s*${MONEY}`, 'i'));
  if (min) out.min_purchase = money(min[1]);
  if (/vence\s*hoje|s[óo]\s*hoje|at[ée]\s*hoje/i.test(t)) out.expires_today = true;
  const until = t.match(/(?:v[áa]lido\s*at[ée]|at[ée]|expira\s*em|vence\s*em)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
  if (until) out.until = { d: Number(until[1]), m: Number(until[2]), y: until[3] ? Number(until[3].length === 2 ? '20' + until[3] : until[3]) : null };
  return out;
}

/** Códigos possíveis numa linha: palavras em maiúsculas (letras e números), sem as palavras comuns. */
function codesIn(line) {
  const clean = String(line).replace(/https?:\/\/\S+/g, ' ');
  const words = clean.match(/\b[A-Z][A-Z0-9_-]{3,24}\b/g) || [];
  return words.filter((w) => !STOP.has(w) && /[A-Z]{3}/.test(w));
}

function resolveDate(until, today) {
  if (!until) return null;
  const [ty] = today.split('-').map(Number);
  const y = until.y || ty;
  const s = `${y}-${String(until.m).padStart(2, '0')}-${String(until.d).padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : null;
}

/**
 * Lê cupons de uma mensagem. Cada código começa um cupom; os detalhes da mesma linha e das linhas seguintes
 * (até o próximo código) completam ele. Devolve [{ marketplace, code, kind, amount, min_purchase, max_discount, expires_on }].
 */
function parseCoupons(text, marketplace = 'ML', today = todayLocal()) {
  const all = String(text || '');
  let market = marketplace;
  if (/shopee/i.test(all) && !/mercado\s*livre|meli\b/i.test(all)) market = 'SH';
  if (/mercado\s*livre|meli\b/i.test(all) && !/shopee/i.test(all)) market = 'ML';
  const out = [];
  let cur = null;
  const finish = () => {
    if (!cur) return;
    if (cur.amount) {
      const exp = cur.expires_today ? today : resolveDate(cur.until, today);
      out.push({
        marketplace: market, code: cur.code, kind: cur.kind || 'percent', amount: cur.amount,
        min_purchase: cur.min_purchase && cur.min_purchase > 1 ? cur.min_purchase : null,
        max_discount: cur.max_discount || null, expires_on: exp,
      });
    }
    cur = null;
  };
  for (const raw of all.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const codes = codesIn(line);
    if (codes.length) {
      // "10% OFF com MELHORDEHJ": código e detalhes na mesma linha
      for (const code of codes) {
        finish();
        cur = { code, ...detailsIn(line) };
      }
    } else if (cur) {
      const d = detailsIn(line);
      for (const k of Object.keys(d)) if (cur[k] === undefined) cur[k] = d[k];
    }
  }
  finish();
  // sem repetir código
  return out.filter((c, i) => out.findIndex((x) => x.code === c.code && x.marketplace === c.marketplace) === i);
}

/* ---------- validação ---------- */

const LINK_HOSTS = /(^|\.)(mercadolivre\.com(\.br)?|mercadolibre\.com|meli\.la|shopee\.com\.br|shope\.ee)$/i;

function cleanCoupon(b, partial = false) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('marketplace')) {
    if (!['ML', 'SH'].includes(b.marketplace)) throw new HttpError(400, 'Escolha a loja do cupom (Mercado Livre ou Shopee).');
    out.marketplace = b.marketplace;
  }
  if (!partial || has('code')) {
    const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new HttpError(400, 'Código do cupom inválido (use letras e números, 3 a 30).');
    out.code = code;
  }
  if (!partial || has('kind')) out.kind = b.kind === 'value' ? 'value' : 'percent';
  if (!partial || has('amount')) {
    const a = parseNum(b.amount);
    const kind = out.kind || b.kind;
    if (!(a > 0) || (kind !== 'value' && a > 100)) throw new HttpError(400, 'Informe o desconto do cupom (em % até 100, ou em R$).');
    out.amount = a;
  }
  for (const k of ['min_purchase', 'max_discount']) {
    if (!partial || has(k)) {
      const v = b[k] === '' || b[k] === null || b[k] === undefined ? null : parseNum(b[k]);
      if (v !== null && !(v >= 0)) throw new HttpError(400, 'Valores do cupom inválidos.');
      out[k] = v;
    }
  }
  if (!partial || has('expires_on')) {
    const e = b.expires_on ? String(b.expires_on).slice(0, 10) : null;
    if (e && !/^\d{4}-\d{2}-\d{2}$/.test(e)) throw new HttpError(400, 'Validade inválida.');
    out.expires_on = e;
  }
  if (!partial || has('link')) {
    const s = String(b.link || '').trim();
    if (s) {
      let u;
      try { u = new URL(s); } catch (_) { throw new HttpError(400, 'Link do cupom inválido.'); }
      if (u.protocol !== 'https:' || !LINK_HOSTS.test(u.hostname)) throw new HttpError(400, 'Use o seu link de afiliado do Mercado Livre ou da Shopee (https).');
      out.link = u.toString();
    } else out.link = null;
  }
  if (!partial || has('notes')) out.notes = b.notes ? String(b.notes).trim().slice(0, 200) : null;
  if (has('active')) out.active = b.active !== false;
  return out;
}

/* ---------- textos ---------- */

/** "30% OFF sem valor mínimo, limite de R$ 500" */
function describe(c) {
  const off = c.kind === 'value' ? `${brl(c.amount)} OFF` : `${Number(c.amount)}% OFF`;
  const min = Number(c.min_purchase) > 1 ? `em compras a partir de ${brl(c.min_purchase)}` : 'sem valor mínimo';
  const lim = c.kind !== 'value' && Number(c.max_discount) ? `, limite de ${brl(c.max_discount)}` : '';
  return `${off} ${min}${lim}`;
}

/**
 * Mensagem "cupons do dia" (só válidos), agrupada por loja.
 * Com o mesmo link em todos os cupons da loja, o link vai uma vez no fim; senão, um link por cupom.
 */
function roundupText(coupons, channel = 'whatsapp', today = todayLocal()) {
  const list = coupons.filter((c) => usable(c, today));
  if (!list.length) return '';
  const wa = channel !== 'instagram';
  const b = (s) => (wa ? `*${s}*` : s);
  const blocks = [];
  for (const m of ['ML', 'SH']) {
    const group = list.filter((c) => c.marketplace === m);
    if (!group.length) continue;
    const links = [...new Set(group.map((c) => c.link).filter(Boolean))];
    const oneLink = links.length === 1 && group.every((c) => c.link === links[0]);
    const lines = [`🚨 ${b(`CUPONS ${MARKETS[m]}`)} 🚨`, ''];
    for (const c of group) {
      lines.push(`🎟️ ${b(c.code)}${statusOf(c, today) === 'hoje' ? ' ⏰ vence hoje!' : ''}`);
      lines.push(`📍 ${describe(c)}`);
      if (!oneLink && c.link && wa) lines.push(`🔗 ${c.link}`);
      lines.push('');
    }
    if (oneLink && wa) lines.push(`🔗 ${b('ATIVE AQUI:')} ${links[0]}`, '');
    blocks.push(lines.join('\n').trim());
  }
  const tail = wa
    ? '⚠️ Cupons sujeitos às regras da loja (produtos participantes e limite por conta). Podem acabar a qualquer momento!'
    : '👉 Link na bio para ativar! Cupons sujeitos às regras da loja e podem acabar a qualquer momento.\n#cupom #cupomdedesconto #achadinhos #ofertas';
  return `${blocks.join('\n\n')}\n\n${tail}`;
}

/** Economia máxima do cupom num preço (para escolher o melhor). */
function saving(c, price) {
  if (c.kind === 'value') return Math.min(Number(c.amount), price);
  const s = (price * Number(c.amount)) / 100;
  return Number(c.max_discount) ? Math.min(s, Number(c.max_discount)) : s;
}

/** Melhor cupom válido para um produto: mesma loja e compra mínima atendida. */
function bestCouponFor(p, coupons, today = todayLocal()) {
  const price = Number(p.price) || 0;
  const ok = (coupons || []).filter((c) => usable(c, today) && c.marketplace === p.marketplace && !(Number(c.min_purchase) > price));
  if (!ok.length) return null;
  return ok.sort((a, b) => saving(b, price) - saving(a, price))[0];
}

/** Linha do cupom no texto da oferta (sem prometer preço final: a loja decide se o produto participa). */
function couponLine(c, channel) {
  const code = channel === 'instagram' ? c.code : `*${c.code}*`;
  return `🎟️ Cupom ${code}: ${describe(c)}${statusOf(c) === 'hoje' ? ' (vence hoje!)' : ''}`;
}

async function activeCoupons(pool, uid) {
  const { rows } = await pool.query('select * from coupons where user_id = $1 and active = true order by id', [uid]);
  const today = todayLocal();
  return rows.filter((c) => usable(c, today));
}

module.exports = {
  parseCoupons, cleanCoupon, roundupText, bestCouponFor, couponLine, activeCoupons, statusOf, describe, todayLocal, MAX_COUPONS,
};
