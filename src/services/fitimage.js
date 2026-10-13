/**
 * Proporção das fotos para o Instagram: ele só aceita de 4:5 (em pé) a 1,91:1 (deitada).
 * Foto fora disso (comum nas lojas: banners largos, fotos compridas) ganha bordas brancas até o limite,
 * sem cortar o produto. A versão ajustada é gerada na hora num endereço assinado (/api/img/fit),
 * que o Instagram baixa; a assinatura impede que o endereço seja usado para outras imagens.
 */
const crypto = require('crypto');

const RATIO_MIN = 0.8; // 4:5
const RATIO_MAX = 1.91; // 1,91:1
const MAX_BYTES = 8 * 1024 * 1024;

let sharpLib;
const sharp = () => (sharpLib ||= require('sharp'));

const sign = (cfg, url) => crypto.createHmac('sha256', String(cfg.jwtSecret)).update(`fit:${url}`).digest('hex').slice(0, 32);

function verify(cfg, url, sig) {
  const a = Buffer.from(sign(cfg, url));
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const fitUrl = (cfg, url) => `${cfg.appUrl}/api/img/fit?u=${encodeURIComponent(url)}&s=${sign(cfg, url)}`;

/** Tamanho final (com bordas) para a proporção ficar dentro do aceito; null se já estiver. */
function padFor(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  if (r < RATIO_MIN) return { width: Math.ceil(h * RATIO_MIN), height: h };
  if (r > RATIO_MAX) return { width: w, height: Math.ceil(w / RATIO_MAX) };
  return null;
}

/** Baixa a imagem (até 8 MB). */
async function download(url, fetchImpl, allowed) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (res.url && allowed && !allowed(new URL(res.url).hostname)) throw new Error('endereço não permitido');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('imagem grande demais');
  return buf;
}

/** Foto com bordas brancas centralizadas, em JPEG (o formato que o Instagram aceita). */
async function padImage(buf) {
  const img = sharp()(buf, { failOn: 'none' }).rotate(); // respeita a orientação da câmera
  const meta = await img.metadata();
  const portrait = meta.orientation >= 5; // rotacionada 90°: largura e altura trocam
  const w = portrait ? meta.height : meta.width;
  const h = portrait ? meta.width : meta.height;
  const target = padFor(w, h) || { width: w, height: h };
  const dx = target.width - w;
  const dy = target.height - h;
  return img
    .extend({ left: Math.floor(dx / 2), right: Math.ceil(dx / 2), top: Math.floor(dy / 2), bottom: Math.ceil(dy / 2), background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Para cada foto do post, confere a proporção; as que estiverem fora trocam de endereço para a versão com bordas.
 * Se não der para conferir (loja fora do ar, formato estranho), mantém a original: o Instagram decide.
 * media: [{ kind, url }]. Devolve a lista nova e quantas foram ajustadas.
 */
async function fitForInstagram({ cfg, fetchImpl, media, allowed }) {
  let fixed = 0;
  const out = await Promise.all(media.map(async (m) => {
    if (m.kind !== 'image') return m;
    let host;
    try { host = new URL(m.url).hostname; } catch (_) { return m; }
    if (allowed && !allowed(host)) return m;
    try {
      const meta = await sharp()(await download(m.url, fetchImpl, allowed), { failOn: 'none' }).metadata();
      const rotated = meta.orientation >= 5;
      // fora da proporção ou em outro formato (WEBP, PNG...): vai a versão ajustada, sempre em JPEG
      if (meta.format === 'jpeg' && !padFor(rotated ? meta.height : meta.width, rotated ? meta.width : meta.height)) return m;
      fixed++;
      return { ...m, url: fitUrl(cfg, m.url) };
    } catch (_) {
      return m;
    }
  }));
  return { media: out, fixed };
}

module.exports = { fitForInstagram, padImage, padFor, fitUrl, verify, download, RATIO_MIN, RATIO_MAX };
