const express = require('express');
const crypto = require('crypto');
const { HttpError } = require('../util');

const TYPES = { 'image/jpeg': { ext: 'jpg', kind: 'image', max: 8 * 1024 * 1024 }, 'image/png': { ext: 'png', kind: 'image', max: 8 * 1024 * 1024 }, 'video/mp4': { ext: 'mp4', kind: 'video', max: 100 * 1024 * 1024 } };

const PROXY_MAX = 4 * 1024 * 1024; // abaixo do limite de resposta da Vercel (4,5 MB)

/**
 * Hosts de onde o repasse de imagens aceita buscar: fotos do Mercado Livre e da Shopee e o próprio
 * armazenamento (Supabase). Lista fechada para o servidor não virar ponte para qualquer endereço.
 */
function proxyAllowed(cfg, hostname) {
  const h = String(hostname || '').toLowerCase();
  const own = [];
  try { if (cfg.supabaseUrl) own.push(new URL(cfg.supabaseUrl).hostname); } catch (_) { /* sem supabase */ }
  return h === 'mlstatic.com' || h.endsWith('.mlstatic.com')
    || h.endsWith('.susercontent.com') || h === 'shopee.com.br' || h.endsWith('.shopee.com.br')
    || own.includes(h);
}

function mediaRoutes({ cfg, storage, fetchImpl = fetch }) {
  const r = express.Router();

  /**
   * Repasse de imagem para a capa: o navegador só consegue desenhar (e exportar) no canvas imagens
   * do mesmo endereço do app. Só aceita https, hosts da lista e conteúdo de imagem até 4 MB.
   */
  r.get('/proxy', async (req, res) => {
    let u;
    try { u = new URL(String(req.query.url || '')); } catch (_) { throw new HttpError(400, 'Endereço de imagem inválido.'); }
    if (u.protocol !== 'https:' || !proxyAllowed(cfg, u.hostname)) throw new HttpError(400, 'Endereço de imagem não permitido.');
    let up;
    try {
      up = await fetchImpl(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    } catch (_) { throw new HttpError(502, 'Não foi possível baixar a imagem.'); }
    if (up.url && !proxyAllowed(cfg, new URL(up.url).hostname)) throw new HttpError(400, 'Endereço de imagem não permitido.');
    if (!up.ok) throw new HttpError(502, `A loja não entregou a imagem (HTTP ${up.status}).`);
    const type = String(up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new HttpError(415, 'O endereço não é de uma imagem.');
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length > PROXY_MAX) throw new HttpError(413, 'Imagem grande demais.');
    res.set('content-type', type);
    res.set('cache-control', 'private, max-age=86400');
    res.send(buf);
  });

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

/**
 * Público (o Instagram baixa daqui): foto com bordas brancas para caber na proporção aceita.
 * Só atende endereços assinados pelo próprio app e de hosts da lista.
 */
function imageRoutes({ cfg, fetchImpl = fetch }) {
  const { verify, download, padImage } = require('../services/fitimage');
  const r = express.Router();
  r.get('/fit', async (req, res) => {
    const url = String(req.query.u || '');
    if (!verify(cfg, url, req.query.s)) throw new HttpError(403, 'Endereço inválido.');
    let u;
    try { u = new URL(url); } catch (_) { throw new HttpError(400, 'Endereço inválido.'); }
    if (u.protocol !== 'https:' || !proxyAllowed(cfg, u.hostname)) throw new HttpError(400, 'Endereço não permitido.');
    let out;
    try {
      out = await padImage(await download(u.toString(), fetchImpl, (h) => proxyAllowed(cfg, h)));
    } catch (e) { throw new HttpError(502, `Não foi possível preparar a imagem: ${e.message}`); }
    res.set('content-type', 'image/jpeg');
    res.set('cache-control', 'public, max-age=86400');
    res.send(out);
  });
  return r;
}

module.exports = { mediaRoutes, imageRoutes, proxyAllowed };
