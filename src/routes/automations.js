const express = require('express');
const { HttpError } = require('../util');
const { cleanConfig, runNow } = require('../services/automation');

const MAX_AUTOMATIONS = 10;

function view(row, stats) {
  let config = null;
  try { config = JSON.parse(row.config); } catch (_) { /* configuração corrompida: a tela mostra vazia */ }
  return {
    id: row.id, name: row.name, active: row.active, config, last_run_at: row.last_run_at,
    run_count: row.run_count, created_at: row.created_at,
    sent_today: stats?.sent_today || 0, sent_total: stats?.sent_total || 0,
  };
}

const cleanName = (v) => {
  const s = String(v || '').trim().slice(0, 60);
  if (!s) throw new HttpError(400, 'Dê um nome ao piloto.');
  return s;
};

function parseResult(raw) {
  try { return JSON.parse(raw); } catch (_) { return { status: 'error', error: String(raw || '') }; }
}

function automationRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();

  const getOne = async (id, uid) => {
    const { rows } = await pool.query('select * from automations where id = $1 and user_id = $2', [Number(id), uid]);
    if (!rows.length) throw new HttpError(404, 'Piloto não encontrado.');
    return rows[0];
  };

  r.get('/', async (req, res) => {
    const { rows } = await pool.query('select * from automations where user_id = $1 order by id', [req.uid]);
    const since = new Date(Date.now() - 864e5).toISOString();
    const stats = new Map();
    if (rows.length) {
      const s = await pool.query(
        `select a.id, r.ran_at from automation_runs r join automations a on a.id = r.automation_id
           where a.user_id = $1 and r.product_id is not null and r.result like '%"status":"sent"%'`, [req.uid]);
      for (const x of s.rows) {
        const cur = stats.get(x.id) || { sent_today: 0, sent_total: 0 };
        cur.sent_total++;
        if (new Date(x.ran_at).toISOString() >= since) cur.sent_today++;
        stats.set(x.id, cur);
      }
    }
    res.json({ items: rows.map((a) => view(a, stats.get(a.id))) });
  });

  r.post('/', async (req, res) => {
    const name = cleanName(req.body?.name);
    const config = cleanConfig(req.body?.config);
    const n = (await pool.query('select count(*)::int as n from automations where user_id = $1', [req.uid])).rows[0].n;
    if (n >= MAX_AUTOMATIONS) throw new HttpError(400, `Limite de ${MAX_AUTOMATIONS} pilotos.`);
    const { rows } = await pool.query(
      'insert into automations (user_id, name, active, config) values ($1,$2,$3,$4) returning *',
      [req.uid, name, req.body?.active !== false, JSON.stringify(config)]);
    res.status(201).json(view(rows[0]));
  });

  r.patch('/:id', async (req, res) => {
    const cur = await getOne(req.params.id, req.uid);
    const b = req.body || {};
    const name = b.name !== undefined ? cleanName(b.name) : cur.name;
    const active = b.active !== undefined ? b.active === true : cur.active;
    const config = b.config !== undefined ? JSON.stringify(cleanConfig(b.config)) : cur.config;
    const { rows } = await pool.query('update automations set name = $1, active = $2, config = $3 where id = $4 returning *',
      [name, active, config, cur.id]);
    res.json(view(rows[0]));
  });

  r.delete('/:id', async (req, res) => {
    const cur = await getOne(req.params.id, req.uid);
    await pool.query('delete from automations where id = $1', [cur.id]);
    res.json({ ok: true });
  });

  /** Roda uma rodada agora (fora da janela de horário também), para testar. */
  r.post('/:id/run', async (req, res) => {
    const cur = await getOne(req.params.id, req.uid);
    res.json(await runNow({ pool, cfg, fetchImpl, automation: cur }));
  });

  r.get('/:id/runs', async (req, res) => {
    const cur = await getOne(req.params.id, req.uid);
    const { rows } = await pool.query(
      'select id, product_id, title, result, ran_at from automation_runs where automation_id = $1 order by ran_at desc, id desc limit 50',
      [cur.id]);
    res.json({ items: rows.map((x) => ({ id: x.id, product_id: x.product_id, title: x.title, ran_at: x.ran_at, ...parseResult(x.result) })) });
  });

  return r;
}

module.exports = { automationRoutes };
