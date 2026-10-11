const express = require('express');
const { HttpError, encrypt, decrypt } = require('../util');
const { createInstagramClient } = require('../services/instagram');

function connectionRoutes({ pool, cfg, fetchImpl }) {
  const r = express.Router();

  r.get('/instagram', async (req, res) => {
    const { rows } = await pool.query('select ig_user_id, ig_token_enc from connections where user_id = $1', [req.uid]);
    const c = rows[0];
    res.json({
      connected: Boolean(c && c.ig_user_id && c.ig_token_enc),
      ig_user_id: c?.ig_user_id || null,
      public_media: !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(cfg.appUrl),
    });
  });

  r.put('/instagram', async (req, res) => {
    const igUserId = String(req.body?.ig_user_id || '').trim();
    const token = String(req.body?.access_token || '').trim();
    if (!/^\d{5,25}$/.test(igUserId)) throw new HttpError(400, 'O ID da conta do Instagram deve ter apenas números.');
    if (token.length < 20) throw new HttpError(400, 'Token de acesso inválido.');
    // Confere com a Meta antes de salvar, para não guardar credencial que não funciona.
    let who;
    try {
      who = await createInstagramClient({ cfg, fetchImpl }).whoami({ igUserId, token });
    } catch (e) {
      throw new HttpError(400, `A Meta recusou as credenciais: ${e.message}`);
    }
    await pool.query(
      `insert into connections (user_id, ig_user_id, ig_token_enc, updated_at) values ($1,$2,$3, now())
         on conflict (user_id) do update set ig_user_id = excluded.ig_user_id, ig_token_enc = excluded.ig_token_enc, updated_at = now()`,
      [req.uid, igUserId, encrypt(token, cfg.encryptionKey)]
    );
    res.json({ connected: true, ig_user_id: igUserId, username: who.username || null });
  });

  r.post('/instagram/test', async (req, res) => {
    const { rows } = await pool.query('select ig_user_id, ig_token_enc from connections where user_id = $1', [req.uid]);
    if (!rows.length || !rows[0].ig_token_enc) throw new HttpError(400, 'Instagram não conectado.');
    try {
      const who = await createInstagramClient({ cfg, fetchImpl }).whoami({
        igUserId: rows[0].ig_user_id,
        token: decrypt(rows[0].ig_token_enc, cfg.encryptionKey),
      });
      res.json({ ok: true, username: who.username || null });
    } catch (e) {
      throw new HttpError(400, `A conexão falhou: ${e.message}`);
    }
  });

  r.delete('/instagram', async (req, res) => {
    await pool.query('delete from connections where user_id = $1', [req.uid]);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { connectionRoutes };
