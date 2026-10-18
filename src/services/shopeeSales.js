/**
 * Vendas da Shopee na aba Ganhos, pela API de afiliados (relatório de conversões).
 * Cada item de pedido vira uma linha (uma vez só: external_ref). Situação: concluído = confirmada,
 * demais = pendente; pedido cancelado sai. O canal vem dos Sub_ids do link (instagram, whatsapp...).
 */
const TZ = process.env.APP_TZ || 'America/Sao_Paulo';
const EVERY_MS = 6 * 3600e3; // automático: a cada 6 horas

const dayOf = (sec) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000));
const channelOf = (utm) => (/instagram|insta\b|ig\b/i.test(String(utm || '')) ? 'instagram' : /whats|wpp|zap/i.test(String(utm || '')) ? 'whatsapp' : 'outro');
const statusOf = (s) => (/complet/i.test(String(s || '')) ? 'confirmada' : /cancel/i.test(String(s || '')) ? 'cancelada' : 'pendente');

/**
 * Quais vendas são desta conta, pelas etiquetas (Sub IDs) do link: a etiqueta da conta; as sem etiqueta de
 * nenhuma conta ligada vão para a conta principal. Sem contas ligadas, tudo é da conta (como antes).
 */
async function salesFilter(pool, uid) {
  const me = (await pool.query('select sh_sub_id, sh_untagged from users where id = $1', [uid])).rows[0] || {};
  const others = (await pool.query(
    'select u.sh_sub_id from account_links l join users u on u.id = l.other_id where l.user_id = $1 and u.sh_sub_id is not null', [uid])).rows.map((r) => r.sh_sub_id);
  const tags = (utm) => String(utm || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return (utm) => {
    const t = tags(utm);
    if (me.sh_sub_id && t.includes(me.sh_sub_id)) return true;
    if (others.some((o) => t.includes(o))) return false;
    return me.sh_untagged !== false;
  };
}

/** Importa/atualiza as vendas dos últimos "days" dias. Devolve { created, updated, removed }. */
async function syncShopeeSales({ pool, cfg, fetchImpl, uid, days = 60 }) {
  const { clientFor } = require('./garimpo');
  const sh = await clientFor({ pool, cfg, fetchImpl, uid, marketplace: 'SH' });
  const end = Date.now() / 1000;
  const start = end - Math.min(90, days) * 86400;
  const out = { created: 0, updated: 0, removed: 0, skipped: 0 };
  const mine = await salesFilter(pool, uid);
  let scrollId = '';
  for (let page = 0; page < 20; page++) {
    const r = await sh.conversions({ start, end, scrollId });
    for (const conv of r.items) {
      if (!mine(conv.utmContent)) { out.skipped++; continue; }
      for (const order of conv.orders || []) {
        for (const it of order.items || []) {
          const ref = `sh:${conv.conversionId}:${order.orderId}:${it.itemId}`;
          const status = statusOf(it.displayItemStatus || order.orderStatus);
          const cur = (await pool.query('select id, status, commission from earnings where user_id = $1 and external_ref = $2', [uid, ref])).rows[0];
          if (status === 'cancelada') {
            if (cur) { await pool.query('delete from earnings where id = $1', [cur.id]); out.removed++; }
            continue;
          }
          const commission = Math.round((Number(it.itemTotalCommission) || 0) * 100) / 100;
          if (cur) {
            // "paga" é marcada pelo usuário: não volta para confirmada
            const next = cur.status === 'paga' ? 'paga' : status;
            if (next !== cur.status || Number(cur.commission) !== commission) {
              await pool.query('update earnings set status = $1, commission = $2 where id = $3', [next, commission, cur.id]);
              out.updated++;
            }
            continue;
          }
          const prod = it.shopId && it.itemId
            ? (await pool.query('select id from products where user_id = $1 and marketplace = $2 and external_id = $3', [uid, 'SH', `${it.shopId}.${it.itemId}`])).rows[0]
            : null;
          await pool.query(
            `insert into earnings (user_id, product_id, day, channel, clicks, orders, commission, status, external_ref)
               values ($1,$2,$3,$4,0,$5,$6,$7,$8)`,
            [uid, prod ? prod.id : null, dayOf(Number(conv.purchaseTime) || end), channelOf(conv.utmContent), Math.max(1, Number(it.qty) || 1), commission, status, ref]);
          out.created++;
        }
      }
    }
    if (!r.hasMore || !r.scrollId) break;
    scrollId = r.scrollId;
  }
  await pool.query('update users set sh_sales_synced_at = now() where id = $1', [uid]);
  if (!out.skipped) delete out.skipped; // só aparece quando há vendas de outra conta
  return out;
}

/** Agendador: importa as vendas de quem tem a Shopee conectada, a cada 6 horas. */
async function runShopeeSalesTick({ pool, cfg, fetchImpl, log = console }) {
  const since = new Date(Date.now() - EVERY_MS).toISOString();
  const { rows } = await pool.query(
    `select u.id from users u join marketplace_connections m on m.user_id = u.id and m.marketplace = 'SH'
       where u.sh_sales_synced_at is null or u.sh_sales_synced_at < $1 limit 5`, [since]);
  let n = 0;
  for (const u of rows) {
    const claim = await pool.query('update users set sh_sales_synced_at = now() where id = $1 and (sh_sales_synced_at is null or sh_sales_synced_at < $2) returning id', [u.id, since]);
    if (!claim.rows.length) continue;
    try { const r = await syncShopeeSales({ pool, cfg, fetchImpl, uid: u.id }); n += r.created + r.updated; } catch (e) { log.error?.(`[vendas shopee] ${u.id}: ${e.message}`); }
  }
  return n;
}

module.exports = { syncShopeeSales, runShopeeSalesTick, salesFilter, channelOf, statusOf };
