const express = require('express');
const crypto = require('crypto');
const { HttpError } = require('../util');

const TYPES = { 'image/jpeg': { ext: 'jpg', kind: 'image', max: 8 * 1024 * 1024 }, 'image/png': { ext: 'png', kind: 'image', max: 8 * 1024 * 1024 }, 'video/mp4': { ext: 'mp4', kind: 'video', max: 100 * 1024 * 1024 } };

function mediaRoutes({ cfg, storage }) {
  const r = express.Router();

  /**
   * O navegador pergunta como enviar o arquivo. Com Supabase, recebe uma URL assinada de envio e o endereço
   * público final. Com disco local, recebe driver "local" e usa /api/queue/upload.
   */
  r.post('/sign', async (req, res) => {
    const type = TYPES[String(req.body?.content_type || '').toLowerCase()];
    if (!type) throw new HttpError(400, 'Formato não aceito. Use JPEG, PNG ou MP4.');
    const size = Number(req.body?.size) || 0;
    if (size > type.max) throw new HttpError(400, `Arquivo grande demais (limite de ${Math.round(type.max / 1048576)} MB).`);
    if (storage.driver !== 'supabase') return res.json({ driver: 'local' });

    const path = `${req.uid}/${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    let signed;
    try {
      signed = await storage.sign(path);
    } catch (e) {
      throw new HttpError(502, `Não foi possível preparar o envio para o Supabase Storage: ${e.message}`);
    }
    res.json({
      driver: 'supabase',
      supabase_url: cfg.supabaseUrl,
      anon_key: cfg.supabaseAnonKey,
      bucket: cfg.supabaseBucket,
      path: signed.path,
      token: signed.token,
      public_url: storage.publicUrl(signed.path),
      media_type: type.kind,
    });
  });

  return r;
}

module.exports = { mediaRoutes };
