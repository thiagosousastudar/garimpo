const express = require('express');
const crypto = require('crypto');
const { HttpError } = require('../util');
const { processDue } = require('../services/publisher');

function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Endpoint chamado por um agendador externo (Vercel Cron, Supabase pg_cron, GitHub Actions etc.).
 * Exige o cabeçalho "Authorization: Bearer <CRON_SECRET>".
 */
function cronRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();
  const handler = async (req, res) => {
    if (!cfg.cronSecret) throw new HttpError(503, 'Agendamento externo desativado. Defina CRON_SECRET.');
    if (!sameSecret(req.headers.authorization || '', `Bearer ${cfg.cronSecret}`)) throw new HttpError(401, 'Não autorizado.');
    const result = await processDue({ pool, cfg, fetchImpl, log: { log() {}, error: console.error } });
    res.json({ ok: true, ...result });
  };
  r.get('/tick', handler);
  r.post('/tick', handler);
  return r;
}

module.exports = { cronRoutes };
