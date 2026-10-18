const express = require('express');
const { HttpError, parseNum, parseDate, parseCsv } = require('../util');

const STATUSES = ['pendente', 'confirmada', 'paga'];
const CHANNELS = ['instagram', 'whatsapp', 'outro'];
const TZ = process.env.APP_TZ || 'America/Sao_Paulo';

function dayStr(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return d.toISOString().slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayInTz(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // aaaa-mm-dd
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const round2 = (n) => Math.round(n * 100) / 100;

function parseRow(b, partial = false) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('day')) {
    const d = parseDate(b.day);
    if (!d) throw new HttpError(400, 'Data inválida. Use dd/mm/aaaa ou aaaa-mm-dd.');
    out.day = d;
  }
  if (!partial || has('channel')) {
    const c = String(b.channel || '').trim().toLowerCase();
    if (!CHANNELS.includes(c)) throw new HttpError(400, 'Canal deve ser instagram, whatsapp ou outro.');
    out.channel = c;
  }
  if (has('clicks')) { const n = parseNum(b.clicks); if (n === null || n < 0) throw new HttpError(400, 'Cliques inválidos.'); out.clicks = Math.round(n); }
  if (has('orders')) { const n = parseNum(b.orders); if (n === null || n < 0) throw new HttpError(400, 'Pedidos inválidos.'); out.orders = Math.round(n); }
  if (!partial || has('commission')) {
    const n = parseNum(b.commission);
    if (n === null || n < 0) throw new HttpError(400, 'Comissão inválida.');
    out.commission = n;
  }
  if (has('status')) {
    const s = String(b.status || '').trim().toLowerCase();
    if (!STATUSES.includes(s)) throw new HttpError(400, 'Situação deve ser pendente, confirmada ou paga.');
    out.status = s;
  }
  if (has('product_id')) out.product_id = b.product_id === null || b.product_id === '' ? null : Number(b.product_id);
  return out;
}

const COLS = ['product_id', 'day', 'channel', 'clicks', 'orders', 'commission', 'status'];

function earningsRoutes({ pool }) {
  const r = express.Router();

  async function ownProduct(uid, id) {
    if (id === null || id === undefined) return;
    const ok = await pool.query('select 1 from products where id = $1 and user_id = $2', [id, uid]);
    if (!ok.rows.length) throw new HttpError(404, 'Produto não encontrado.');
  }

  r.get('/', async (req, res) => {
    const { rows } = await pool.query(
      `select e.*, p.title as product_title from earnings e left join products p on p.id = e.product_id
         where e.user_id = $1 order by e.day desc, e.id desc limit 300`,
      [req.uid]
    );
    res.json({
      earnings: rows.map((x) => ({ ...x, day: dayStr(x.day), commission: Number(x.commission) })),
    });
  });

  r.post('/', async (req, res) => {
    const d = parseRow(req.body || {});
    await ownProduct(req.uid, d.product_id);
    const cols = COLS.filter((c) => d[c] !== undefined);
    const { rows } = await pool.query(
      `insert into earnings (user_id, ${cols.join(',')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(',')}) returning id`,
      [req.uid, ...cols.map((c) => d[c])]
    );
    res.status(201).json({ id: rows[0].id });
  });

  r.patch('/:id', async (req, res) => {
    const d = parseRow(req.body || {}, true);
    await ownProduct(req.uid, d.product_id);
    const cols = COLS.filter((c) => d[c] !== undefined);
    if (!cols.length) throw new HttpError(400, 'Nada para atualizar.');
    const out = await pool.query(
      `update earnings set ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and user_id = $2 returning id`,
      [Number(req.params.id), req.uid, ...cols.map((c) => d[c])]
    );
    if (!out.rows.length) throw new HttpError(404, 'Lançamento não encontrado.');
    res.json({ ok: true });
  });

  r.delete('/:id', async (req, res) => {
    const out = await pool.query('delete from earnings where id = $1 and user_id = $2 returning id', [Number(req.params.id), req.uid]);
    if (!out.rows.length) throw new HttpError(404, 'Lançamento não encontrado.');
    res.json({ ok: true });
  });

  /**
   * Importa CSV do painel de afiliados. Colunas: data, produto, canal, cliques, pedidos, comissao, situacao.
   * "produto" é opcional e ligado ao produto cadastrado de mesmo nome.
   */
  r.post('/import', async (req, res) => {
    if (typeof req.body !== 'string') throw new HttpError(400, 'Envie o conteúdo do CSV (Content-Type: text/csv).');
    const rows = parseCsv(req.body);
    if (!rows.length) throw new HttpError(400, 'O CSV está vazio.');
    const prods = (await pool.query('select id, title from products where user_id = $1', [req.uid])).rows;
    const byTitle = new Map(prods.map((p) => [p.title.trim().toLowerCase(), p.id]));
    let imported = 0;
    const errors = [];
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      try {
        const d = parseRow({
          day: c.data, channel: c.canal || 'outro', clicks: c.cliques || 0, orders: c.pedidos || 0,
          commission: c.comissao, status: c.situacao || 'pendente',
          product_id: c.produto ? byTitle.get(c.produto.trim().toLowerCase()) ?? null : null,
        });
        const cols = COLS.filter((k) => d[k] !== undefined);
        await pool.query(
          `insert into earnings (user_id, ${cols.join(',')}) values ($1, ${cols.map((_, j) => `$${j + 2}`).join(',')})`,
          [req.uid, ...cols.map((k) => d[k])]
        );
        imported++;
      } catch (e) {
        errors.push({ line: i + 2, error: e.message });
      }
    }
    res.json({ imported, errors });
  });

  /** Todas as contas ligadas, lado a lado: comissão e pedidos no período. */
  r.get('/accounts', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 14));
    const start = addDays(todayInTz(), -(days - 1));
    const ids = [req.uid, ...(await pool.query('select other_id from account_links where user_id = $1', [req.uid])).rows.map((r) => r.other_id)];
    const out = [];
    for (const id of ids) {
      const u = (await pool.query('select id, name, email from users where id = $1', [id])).rows[0];
      if (!u) continue;
      const k = (await pool.query(
        `select coalesce(sum(commission), 0) as total, coalesce(sum(orders), 0) as orders,
                coalesce(sum(case when status = 'pendente' then commission else 0 end), 0) as pending
           from earnings where user_id = $1 and day >= $2`, [id, start])).rows[0];
      out.push({ id: u.id, name: u.name || u.email, current: id === req.uid, total: Number(k.total), orders: Number(k.orders), pending: Number(k.pending) });
    }
    res.json({ days, accounts: out });
  });

  r.get('/summary', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 14));
    const end = todayInTz();
    const start = addDays(end, -(days - 1));
    const { rows } = await pool.query(
      `select e.day, e.channel, e.clicks, e.orders, e.commission, e.status, e.product_id, p.title as product_title
         from earnings e left join products p on p.id = e.product_id
         where e.user_id = $1 and e.day >= $2`,
      [req.uid, start]
    );

    const k = { pending: 0, confirmed: 0, paid: 0, clicks: 0, orders: 0, total: 0 };
    const byDay = new Map();
    for (let i = 0; i < days; i++) byDay.set(addDays(start, i), { day: addDays(start, i), commission: 0, clicks: 0 });
    const byChannel = new Map();
    const byProduct = new Map();

    for (const x of rows) {
      const day = dayStr(x.day);
      if (day > end) continue;
      const c = Number(x.commission);
      k.total += c; k.clicks += x.clicks; k.orders += x.orders;
      if (x.status === 'pendente') k.pending += c;
      else if (x.status === 'confirmada') k.confirmed += c;
      else k.paid += c;
      const d = byDay.get(day);
      if (d) { d.commission += c; d.clicks += x.clicks; }
      byChannel.set(x.channel, (byChannel.get(x.channel) || 0) + c);
      const key = x.product_id ?? 0;
      const pr = byProduct.get(key) || { product_id: x.product_id, title: x.product_title || 'Sem produto', clicks: 0, orders: 0, commission: 0 };
      pr.clicks += x.clicks; pr.orders += x.orders; pr.commission += c;
      byProduct.set(key, pr);
    }

    res.json({
      range: { start, end, days },
      kpis: {
        to_receive: round2(k.pending + k.confirmed),
        pending: round2(k.pending),
        confirmed: round2(k.confirmed),
        paid: round2(k.paid),
        total: round2(k.total),
        clicks: k.clicks,
        orders: k.orders,
        conversion: k.clicks ? round2((k.orders / k.clicks) * 100) : 0,
      },
      by_day: [...byDay.values()].map((d) => ({ ...d, commission: round2(d.commission) })),
      by_channel: [...byChannel].map(([channel, commission]) => ({ channel, commission: round2(commission) })).sort((a, b) => b.commission - a.commission),
      by_product: [...byProduct.values()].map((p) => ({ ...p, commission: round2(p.commission) })).sort((a, b) => b.commission - a.commission).slice(0, 20),
    });
  });

  return r;
}

module.exports = { earningsRoutes };
