/**
 * Piloto automático: o usuário configura fontes, filtros, janela de horário, ritmo e canais; a cada minuto o
 * agendador vê quais automações estão na hora e roda uma rodada (1 oferta) de cada.
 *
 * Só sai oferta com o link de afiliado do usuário (sem ele, a venda não é dele). Por isso as fontes são:
 *  - os produtos salvos (com link de afiliado), filtrados por loja e palavras-chave;
 *  - buscas na API de afiliados da Shopee (quando liberada), que já devolve o link de afiliado.
 *
 * Uma rodada: escolhe a fonte da vez, aplica filtros, descarta o que esta automação já enviou no período
 * "não repetir", sorteia entre as melhores notas, confere o preço (Mercado Livre) e envia:
 *  - Instagram: publica direto (API oficial), respeitando um limite diário;
 *  - Telegram: posta no grupo/canal (API oficial de bots);
 *  - WhatsApp: deixa pronto na Fila para o usuário compartilhar com foto (sem automação não oficial no WhatsApp).
 */
const { HttpError, decrypt, parseNum } = require('../util');
const { scoreProduct } = require('./score');
const { serializeExtras } = require('./extras');
const { buildCaption, followHandle, vitrineSite } = require('./copy');
const { activeCoupons } = require('./coupons');
const { createTelegramClient } = require('./telegram');

const TZ = process.env.APP_TZ || 'America/Sao_Paulo';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STALE_PRICE_MS = 3 * 3600e3;
const INTERVALS = [15, 30, 45, 60, 90, 120, 180, 240];
const DEDUP = [1, 2, 3, 7, 14, 30];

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/))
  .map((q) => String(q).trim()).filter((q) => q.length >= 2).slice(0, 20).map((q) => q.slice(0, 60));

/** Valida e normaliza a configuração vinda da tela. */
function cleanConfig(c) {
  const s = c?.sources || {};
  const f = c?.filters || {};
  const ch = c?.channels || {};
  const markets = (Array.isArray(s.marketplaces) ? s.marketplaces : []).filter((m) => m === 'ML' || m === 'SH');
  const out = {
    sources: {
      saved: s.saved !== false,
      marketplaces: markets.length ? [...new Set(markets)] : ['ML', 'SH'],
      keywords: list(s.keywords),
      shopee_queries: list(s.shopee_queries),
    },
    filters: {
      min_discount: Math.max(0, Math.min(90, parseNum(f.min_discount) || 0)),
      min_commission: Math.max(0, Math.min(100, parseNum(f.min_commission) || 0)),
      shipping: ['free', 'cheap'].includes(f.shipping) ? f.shipping : '',
      price_min: parseNum(f.price_min) || null,
      price_max: parseNum(f.price_max) || null,
      official_only: f.official_only === true,
    },
    // "premium": texto de curadoria (sóbrio, foco em qualidade); padrão: tom animado da Anninha
    tone: c?.tone === 'premium' ? 'premium' : 'anninha',
    window: {
      start: HHMM.test(c?.window?.start) ? c.window.start : '08:00',
      end: HHMM.test(c?.window?.end) ? c.window.end : '22:00',
    },
    interval_min: INTERVALS.includes(Number(c?.interval_min)) ? Number(c.interval_min) : 60,
    dedup_days: DEDUP.includes(Number(c?.dedup_days)) ? Number(c.dedup_days) : 7,
    channels: { instagram: ch.instagram === true, telegram: ch.telegram === true, whatsapp: ch.whatsapp === true },
    ig_daily_max: Math.max(1, Math.min(25, Math.round(Number(c?.ig_daily_max)) || 6)),
  };
  if (out.window.start === out.window.end) throw new HttpError(400, 'O horário de início e de fim não podem ser iguais.');
  if (!out.sources.saved && !out.sources.shopee_queries.length) throw new HttpError(400, 'Escolha pelo menos uma fonte: seus produtos salvos ou buscas na Shopee.');
  if (!out.channels.instagram && !out.channels.telegram && !out.channels.whatsapp) throw new HttpError(400, 'Escolha pelo menos um canal.');
  return out;
}

/** Hora local ("HH:MM") e início do dia local (ISO) no fuso do app. */
function localClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const minutesToday = Number(parts.hour) * 60 + Number(parts.minute);
  const dayStart = new Date(now.getTime() - minutesToday * 60000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds());
  return { hhmm: `${parts.hour}:${parts.minute}`, dayStart: dayStart.toISOString() };
}

/** A hora está dentro da janela? (aceita janela que vira a noite, ex.: 20:00–02:00) */
function inWindow(hhmm, { start, end }) {
  return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

/** Fonte da vez: alterna entre as configuradas, uma por rodada (poupa chamadas às lojas). */
function sourceFor(config, runCount) {
  const all = [
    ...(config.sources.saved ? [{ kind: 'saved' }] : []),
    ...config.sources.shopee_queries.map((q) => ({ kind: 'shopee', q })),
  ];
  return all[runCount % all.length];
}

const describe = (s) => (s.kind === 'shopee' ? `busca na Shopee "${s.q}"` : 'seus produtos salvos');

function passes(p, f) {
  if (!p.affiliate_url) return false;
  if (p.desc < f.min_discount) return false;
  if (f.min_commission && (Number(p.commission_pct) || 0) < f.min_commission) return false;
  if (f.price_min && p.price < f.price_min) return false;
  if (f.price_max && p.price > f.price_max) return false;
  if (f.official_only && !isOfficial(p)) return false;
  if (f.shipping) {
    const free = p.free_shipping === true || p.shipping_cost === 0;
    if (f.shipping === 'free' && !free) return false;
    if (f.shipping === 'cheap' && !free && !(p.shipping_cost != null && p.shipping_cost <= p.price * 0.15)) return false;
  }
  return true;
}

/** Loja oficial (Mercado Livre) ou loja oficial/Mall na Shopee (pelo nome da loja). */
const isOfficial = (p) => p.official_store === true || /oficial|official|\bmall\b/i.test(`${p.shop || ''} ${p.notes || ''}`);

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Candidatos da fonte da vez, já com nota. */
async function candidates({ pool, cfg, fetchImpl, uid, source, config }) {
  const { mapProduct } = require('../routes/products');
  if (source.kind === 'saved') {
    const { rows } = await pool.query(
      `select * from products where user_id = $1 and affiliate_url is not null and affiliate_url <> '' order by id desc limit 500`, [uid]);
    const kws = config.sources.keywords.map(norm);
    return rows
      .filter((r) => config.sources.marketplaces.includes(r.marketplace))
      .filter((r) => !kws.length || kws.some((k) => norm(`${r.title} ${r.category || ''}`).includes(k)))
      .map((r) => ({ ...mapProduct(r), saved_row: r }));
  }
  const { clientFor } = require('./garimpo');
  const sh = await clientFor({ pool, cfg, fetchImpl, uid, marketplace: 'SH' });
  const out = await sh.search({ q: source.q, sort: 'vendidos' });
  return (out.items || []).filter((p) => p.title && p.price > 0).map((p) => ({ ...p, ...scoreProduct(p) }));
}

/** Já enviado por esta automação dentro do período "não repetir"? */
async function recentlySent(pool, automationId, days) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { rows } = await pool.query(
    'select product_id, external_id from automation_runs where automation_id = $1 and ran_at >= $2 and product_id is not null',
    [automationId, since]);
  return { ids: new Set(rows.map((r) => r.product_id)), ext: new Set(rows.map((r) => r.external_id).filter(Boolean)) };
}

/** Sorteia entre as 5 melhores notas, para variar as ofertas. */
function choose(items, rand = Math.random) {
  const top = [...items].sort((a, b) => b.score - a.score).slice(0, 5);
  return top[Math.floor(rand() * top.length)];
}

/** Garante o produto salvo (reaproveita pelo código da loja) e confere o preço do Mercado Livre se estiver velho. */
async function ensureSaved({ pool, cfg, fetchImpl, uid, pick, log }) {
  const { parseBody, insertProduct, refreshOne } = require('../routes/products');
  let row = pick.saved_row;
  if (!row && pick.external_id) {
    row = (await pool.query('select * from products where user_id = $1 and marketplace = $2 and external_id = $3',
      [uid, pick.marketplace, pick.external_id])).rows[0];
  }
  if (!row) {
    const d = parseBody({
      title: pick.title, marketplace: pick.marketplace, category: pick.category, price: pick.price,
      original_price: pick.original_price, rating: pick.rating, sales_k: pick.sales_k, commission_pct: pick.commission_pct,
      product_url: pick.product_url, affiliate_url: pick.affiliate_url, image_url: pick.image_url,
    });
    return insertProduct(pool, uid, d, pick.external_id, serializeExtras(pick));
  }
  if (row.marketplace === 'ML' && row.external_id && Date.now() - new Date(row.price_checked_at || 0).getTime() > STALE_PRICE_MS) {
    try { row = await refreshOne({ pool, cfg, fetchImpl, uid, cur: row }); }
    catch (e) { log.error?.(`[piloto] não conferiu o preço do produto ${row.id}: ${e.message}`); }
  }
  return row;
}

async function sendInstagram({ pool, cfg, fetchImpl, automation, config, row, product }) {
  const uid = automation.user_id;
  const conn = (await pool.query('select ig_user_id, ig_token_enc from connections where user_id = $1', [uid])).rows[0];
  if (!conn || !conn.ig_user_id || !conn.ig_token_enc) return 'Instagram não conectado';
  const { dayStart } = localClock();
  const today = (await pool.query(
    `select count(*)::int as n from queue_items where automation_id = $1 and channel = 'instagram' and created_at >= $2`,
    [automation.id, dayStart])).rows[0].n;
  if (today >= config.ig_daily_max) return `limite diário de ${config.ig_daily_max} posts atingido`;
  const images = [...new Set((product.images && product.images.length ? product.images : [product.image_url]).filter(Boolean))].slice(0, 3);
  if (!images.length) return 'produto sem foto';
  const caption = (await buildCaption(row, 'instagram', { ai: false, cfg, fetchImpl, coupons: await activeCoupons(pool, automation.user_id), follow: await followHandle(pool, automation.user_id), site: await vitrineSite(pool, automation.user_id, cfg), tone: config.tone })).caption;
  const carousel = images.length > 1;
  const ins = await pool.query(
    `insert into queue_items (user_id, product_id, channel, caption, media_type, media_url, media_items, automation_id)
       values ($1,$2,'instagram',$3,$4,$5,$6,$7) returning id`,
    [uid, row.id, caption, carousel ? 'carousel' : 'image', images[0],
      carousel ? JSON.stringify(images.map((url) => ({ type: 'image', url }))) : null, automation.id]
  );
  const { publishItem } = require('./publisher');
  const done = await publishItem({ pool, cfg, fetchImpl, userId: uid, itemId: ins.rows[0].id });
  return done.status === 'posted' ? 'publicado' : done.status === 'processing' ? 'publicando' : done.status;
}

async function sendTelegram({ pool, cfg, fetchImpl, automation, config, row, product }) {
  const c = (await pool.query('select tg_token_enc, tg_chat_id from connections where user_id = $1', [automation.user_id])).rows[0];
  if (!c || !c.tg_token_enc || !c.tg_chat_id) return 'Telegram não conectado';
  const text = (await buildCaption(row, 'whatsapp', { ai: false, cfg, fetchImpl, coupons: await activeCoupons(pool, automation.user_id), follow: await followHandle(pool, automation.user_id), site: await vitrineSite(pool, automation.user_id, cfg), tone: config.tone })).caption;
  await createTelegramClient({ token: decrypt(c.tg_token_enc, cfg.encryptionKey), fetchImpl })
    .sendOffer(c.tg_chat_id, { photo: product.image_url, text });
  return 'enviado';
}

async function queueWhatsapp({ pool, cfg, fetchImpl, automation, config, row }) {
  const text = (await buildCaption(row, 'whatsapp', { ai: false, cfg, fetchImpl, coupons: await activeCoupons(pool, automation.user_id), follow: await followHandle(pool, automation.user_id), site: await vitrineSite(pool, automation.user_id, cfg), tone: config.tone })).caption;
  await pool.query(
    `insert into queue_items (user_id, product_id, channel, caption, media_type, media_url, automation_id)
       values ($1,$2,'whatsapp',$3,'none',null,$4)`,
    [automation.user_id, row.id, text, automation.id]);
  return 'na Fila para compartilhar';
}

async function logRun(pool, automation, row, result) {
  await pool.query('insert into automation_runs (automation_id, product_id, external_id, title, result) values ($1,$2,$3,$4,$5)',
    [automation.id, row ? row.id : null, row ? row.external_id : null, row ? row.title : null, JSON.stringify(result)]);
  return { ...result, automation_id: automation.id, title: row ? row.title : null };
}

/** Uma rodada da automação. Devolve { status: 'sent'|'empty'|'error', source, channels, error, title }. */
async function runOnce({ pool, cfg, fetchImpl, automation, log = console, rand }) {
  const config = JSON.parse(automation.config);
  const uid = automation.user_id;
  const source = sourceFor(config, automation.run_count || 0);
  const sent = await recentlySent(pool, automation.id, config.dedup_days);

  let items;
  try {
    items = await candidates({ pool, cfg, fetchImpl, uid, source, config });
  } catch (e) {
    return logRun(pool, automation, null, { status: 'error', source: describe(source), error: e.message });
  }
  const ok = items
    .filter((p) => passes(p, config.filters))
    .filter((p) => !(p.saved_row && sent.ids.has(p.saved_row.id)) && !(p.external_id && sent.ext.has(p.external_id)));
  if (!ok.length) {
    const why = items.length
      ? 'Nenhuma oferta nova passou nos filtros (ou todas já foram enviadas no período "não repetir").'
      : source.kind === 'saved' ? 'Nenhum produto salvo com o seu link de afiliado nesta seleção.' : 'A busca não trouxe ofertas.';
    return logRun(pool, automation, null, { status: 'empty', source: describe(source), error: why });
  }

  const row = await ensureSaved({ pool, cfg, fetchImpl, uid, pick: choose(ok, rand), log });
  const { mapProduct } = require('../routes/products');
  const product = mapProduct(row);
  // O preço conferido agora pode ter tirado o produto dos filtros (ex.: o desconto acabou).
  if (!passes(product, config.filters)) {
    return logRun(pool, automation, row, { status: 'empty', source: describe(source), error: 'O preço mudou na conferência e a oferta saiu dos filtros. Tento outra na próxima rodada.' });
  }

  const channels = {};
  const tasks = [['instagram', sendInstagram], ['telegram', sendTelegram], ['whatsapp', queueWhatsapp]]
    .filter(([k]) => config.channels[k]);
  for (const [k, fn] of tasks) {
    try { channels[k] = await fn({ pool, cfg, fetchImpl, automation, config, row, product }); }
    catch (e) { channels[k] = `erro: ${e.message}`; }
  }
  const failed = Object.values(channels).every((v) => /^erro|não conectado|limite|sem foto/.test(v));
  return logRun(pool, automation, row, { status: failed ? 'error' : 'sent', source: describe(source), channels });
}

/** Reserva atômica da automação (evita rodar duas vezes se o agendador for chamado em paralelo). */
async function claim(pool, a, now, minGapMs) {
  const due = new Date(now.getTime() - minGapMs).toISOString();
  const r = await pool.query(
    `update automations set last_run_at = $1, run_count = run_count + 1
       where id = $2 and (last_run_at is null or last_run_at <= $3) returning *`,
    [now.toISOString(), a.id, due]);
  return r.rows[0] ? { ...r.rows[0], run_count: r.rows[0].run_count - 1 } : null;
}

/** Roda já (botão "Rodar agora"); no máximo uma vez a cada 20 segundos. */
async function runNow({ pool, cfg, fetchImpl, automation, log = console }) {
  const auto = await claim(pool, automation, new Date(), 20000);
  if (!auto) throw new HttpError(429, 'Acabou de rodar. Espere alguns segundos.');
  return runOnce({ pool, cfg, fetchImpl, automation: auto, log });
}

/** Chamado pelo agendador a cada minuto: roda as automações ativas que estão na janela e no ritmo. */
async function runDue({ pool, cfg, fetchImpl, log = console, now = new Date() }) {
  const { hhmm } = localClock(now);
  const { rows } = await pool.query('select * from automations where active = true order by id');
  const results = [];
  for (const a of rows.slice(0, 20)) {
    let config;
    try { config = JSON.parse(a.config); } catch (_) { continue; }
    if (!inWindow(hhmm, config.window)) continue;
    const auto = await claim(pool, a, now, config.interval_min * 60000 - 30000); // 30 s de folga do agendador
    if (!auto) continue;
    try {
      results.push(await runOnce({ pool, cfg, fetchImpl, automation: auto, log }));
    } catch (e) {
      log.error?.(`[piloto] automação ${a.id}: ${e.message}`);
      results.push(await logRun(pool, auto, null, { status: 'error', error: e.message }).catch(() => ({ status: 'error' })));
    }
  }
  return results;
}

module.exports = { cleanConfig, runOnce, runNow, runDue, inWindow, localClock, sourceFor, passes, isOfficial };
