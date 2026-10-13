const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { HttpError, isoOrNull } = require('../util');
const { buildCaption, buildGroupCaption, followHandle } = require('../services/copy');
const { activeCoupons } = require('../services/coupons');
const { publishItem, finishItem, EDITABLE, validate, credentialsFor, MAX_CAROUSEL } = require('../services/publisher');

const CHANNELS = ['instagram', 'whatsapp'];
const MEDIA_TYPES = ['none', 'image', 'video'];

const SELECT = `select q.*, p.title as product_title, p.marketplace as product_marketplace,
                       p.image_url as product_image, p.affiliate_url as product_affiliate_url
                  from queue_items q left join products p on p.id = q.product_id`;

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image' };
  if (buf.length >= 4 && buf.slice(0, 4).toString('hex') === '89504e47') return { ext: 'png', type: 'image' };
  if (buf.length >= 12 && buf.slice(4, 8).toString() === 'ftyp') return { ext: 'mp4', type: 'video' };
  return null;
}

function queueRoutes({ pool, cfg, fetchImpl, storage }) {
  const r = express.Router();
  const local = storage.driver === 'local';
  if (local) fs.mkdirSync(cfg.uploadDir, { recursive: true });
  const upload = multer({ dest: path.join(local ? cfg.uploadDir : require('os').tmpdir(), '.tmp'), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

  const getItem = async (id, uid) => {
    const { rows } = await pool.query(`${SELECT} where q.id = $1 and q.user_id = $2`, [Number(id), uid]);
    if (!rows.length) throw new HttpError(404, 'Item não encontrado.');
    return rows[0];
  };

  r.get('/', async (req, res) => {
    const { rows } = await pool.query(`${SELECT} where q.user_id = $1 order by q.created_at desc, q.id desc`, [req.uid]);
    res.json({ items: rows });
  });

  /** Texto e mídia sugeridos para um produto num canal. Não grava nada. */
  async function draftFor(uid, body) {
    const channel = String(body?.channel || '');
    if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Canal deve ser instagram ou whatsapp.');
    const prod = await pool.query('select * from products where id = $1 and user_id = $2', [Number(body?.product_id), uid]);
    if (!prod.rows.length) throw new HttpError(404, 'Produto não encontrado.');
    const p = prod.rows[0];
    const out = await buildCaption(p, channel, { ai: Boolean(body?.ai), cfg, fetchImpl, coupons: await activeCoupons(pool, uid), follow: await followHandle(pool, uid), tone: body?.tone === 'premium' ? 'premium' : undefined });
    let media_type = 'none';
    let media_url = null;
    if (channel === 'instagram') {
      if (p.image_url) { media_type = 'image'; media_url = p.image_url; }
      else if (p.video_url) { media_type = 'video'; media_url = p.video_url; }
    }
    return { product: p, channel, caption: out.caption, media_type, media_url, warning: out.warning };
  }

  const okUrl = (u) => u.startsWith('/uploads/') || /^https?:\/\//i.test(u);

  /**
   * Mídia do post: uma foto/vídeo (media_type + media_url) ou carrossel
   * (media_type "carousel" + media_items [{ type, url }], de 2 a 10).
   */
  function cleanMedia(b) {
    if (b.media_type === 'carousel') {
      const list = Array.isArray(b.media_items) ? b.media_items : [];
      if (list.length < 2) throw new HttpError(400, 'O carrossel precisa de pelo menos 2 fotos ou vídeos.');
      if (list.length > MAX_CAROUSEL) throw new HttpError(400, 'O Instagram aceita no máximo 10 fotos ou vídeos no carrossel.');
      const items = list.map((m) => {
        const type = m?.type === 'video' ? 'video' : 'image';
        const url = String(m?.url || '').trim();
        if (!url || !okUrl(url) || url.length > 2000) throw new HttpError(400, 'Endereço de mídia inválido no carrossel.');
        return { type, url };
      });
      return { media_type: 'carousel', media_url: items[0].url, media_items: JSON.stringify(items) };
    }
    const media_type = b.media_type === undefined ? 'none' : b.media_type;
    if (!MEDIA_TYPES.includes(media_type)) throw new HttpError(400, 'Tipo de mídia inválido.');
    const media_url = String(b.media_url || '').trim() || null;
    if (media_url && !okUrl(media_url)) throw new HttpError(400, 'Endereço da mídia inválido.');
    return { media_type: media_url ? media_type : 'none', media_url, media_items: null };
  }

  /** Produtos do usuário na ordem pedida (1 a 10). */
  async function productsFor(uid, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!list.length) throw new HttpError(400, 'Selecione pelo menos um produto.');
    if (list.length > MAX_CAROUSEL) throw new HttpError(400, 'Selecione no máximo 10 produtos por post.');
    const { rows } = await pool.query(
      `select * from products where user_id = $1 and id in (${list.map((_, i) => `$${i + 2}`).join(',')})`, [uid, ...list]
    );
    if (rows.length !== list.length) throw new HttpError(404, 'Produto não encontrado.');
    const by = new Map(rows.map((r) => [r.id, r]));
    return list.map((id) => by.get(id));
  }

  r.post('/', async (req, res) => {
    const d = await draftFor(req.uid, req.body);
    const { rows } = await pool.query(
      `insert into queue_items (user_id, product_id, channel, caption, media_type, media_url)
         values ($1,$2,$3,$4,$5,$6) returning id`,
      [req.uid, d.product.id, d.channel, d.caption, d.media_type, d.media_url]
    );
    res.status(201).json({ item: await getItem(rows[0].id, req.uid), warning: d.warning });
  });

  /** Prévia do post para a tela "Postar agora". Nada entra na fila. */
  r.post('/preview', async (req, res) => {
    const d = await draftFor(req.uid, req.body);
    res.json({ caption: d.caption, media_type: d.media_type, media_url: d.media_url, warning: d.warning });
  });

  /**
   * Postar agora, sem agendador. O item é gravado já com o texto final (fica no histórico da Fila).
   *  - Instagram: publica na hora. Se falhar, o item fica como "Falhou" na Fila, com o motivo.
   *    Reels que o Instagram ainda está processando voltam em "processing"; a tela confere até publicar.
   *  - WhatsApp: o envio é feito pelo usuário no próprio WhatsApp; aqui só registra como postado.
   */
  /** Prévia de um post com vários produtos: texto numerado e a foto principal de cada um. Nada é gravado. */
  r.post('/preview-group', async (req, res) => {
    const channel = String(req.body?.channel || '');
    if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Canal deve ser instagram ou whatsapp.');
    const list = await productsFor(req.uid, req.body?.product_ids);
    const out = await buildGroupCaption(list, channel, { ai: Boolean(req.body?.ai), cfg, fetchImpl, follow: await followHandle(pool, req.uid) });
    const media_items = list.filter((p) => p.image_url).map((p) => ({ type: 'image', url: p.image_url }));
    res.json({ caption: out.caption, media_items, warning: out.warning });
  });

  r.post('/post-now', async (req, res) => {
    const b = req.body || {};
    const channel = String(b.channel || '');
    if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Canal deve ser instagram ou whatsapp.');
    const products = await productsFor(req.uid, Array.isArray(b.product_ids) ? b.product_ids : [b.product_id]);
    const caption = String(b.caption || '');
    if (!caption.trim()) throw new HttpError(400, 'O texto do post está vazio.');
    if (caption.length > 5000) throw new HttpError(400, 'Texto muito longo.');
    const m = channel === 'instagram' ? cleanMedia(b) : { media_type: 'none', media_url: null, media_items: null };
    if (channel === 'instagram') {
      // Erros de preenchimento e falta de conexão voltam antes de gravar; só falhas da Meta ficam na Fila.
      validate({ channel, caption, ...m }, cfg);
      await credentialsFor(pool, cfg, req.uid);
    }
    const ins = await pool.query(
      `insert into queue_items (user_id, product_id, product_ids, channel, caption, media_type, media_url, media_items, status, posted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [req.uid, products[0].id, products.length > 1 ? JSON.stringify(products.map((p) => p.id)) : null, channel, caption,
        m.media_type, m.media_url, m.media_items, channel === 'whatsapp' ? 'posted' : 'draft', channel === 'whatsapp' ? new Date().toISOString() : null]
    );
    const id = ins.rows[0].id;
    if (channel === 'instagram') {
      await publishItem({ pool, cfg, fetchImpl, userId: req.uid, itemId: id });
    }
    res.status(201).json({ item: await getItem(id, req.uid) });
  });

  r.patch('/:id', async (req, res) => {
    const cur = await getItem(req.params.id, req.uid);
    if (!EDITABLE.includes(cur.status)) throw new HttpError(409, 'Este item não pode mais ser editado.');
    const b = req.body || {};
    const sets = [];
    const vals = [Number(req.params.id), req.uid];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (b.caption !== undefined) {
      const c = String(b.caption);
      if (c.length > 5000) throw new HttpError(400, 'Texto muito longo.');
      add('caption', c);
    }
    if (b.media_type !== undefined) {
      if (!MEDIA_TYPES.includes(b.media_type)) throw new HttpError(400, 'Tipo de mídia inválido.');
      add('media_type', b.media_type);
      add('media_items', null); // trocar a mídia na Fila transforma o carrossel em post simples
      add('container_id', null); // e invalida os itens já enviados ao Instagram (não podem ser reaproveitados)
    }
    if (b.media_url !== undefined) {
      const s = String(b.media_url || '').trim();
      if (s && !s.startsWith('/uploads/') && !/^https?:\/\//i.test(s)) throw new HttpError(400, 'Endereço da mídia inválido.');
      add('media_url', s || null);
    }
    if (b.scheduled_at !== undefined) {
      const iso = isoOrNull(b.scheduled_at);
      add('scheduled_at', iso);
      add('status', iso ? 'scheduled' : 'draft');
      add('error', null);
    }
    if (!sets.length) throw new HttpError(400, 'Nada para atualizar.');
    await pool.query(`update queue_items set ${sets.join(', ')} where id = $1 and user_id = $2`, vals);
    res.json({ item: await getItem(req.params.id, req.uid) });
  });

  r.post('/:id/regenerate', async (req, res) => {
    const cur = await getItem(req.params.id, req.uid);
    if (!EDITABLE.includes(cur.status)) throw new HttpError(409, 'Este item não pode mais ser editado.');
    const prod = await pool.query('select * from products where id = $1 and user_id = $2', [cur.product_id, req.uid]);
    if (!prod.rows.length) throw new HttpError(404, 'O produto deste item foi removido.');
    const out = await buildCaption(prod.rows[0], cur.channel, { ai: Boolean(req.body?.ai), cfg, fetchImpl, coupons: await activeCoupons(pool, req.uid), follow: await followHandle(pool, req.uid), tone: req.body?.tone === 'premium' ? 'premium' : undefined });
    await pool.query('update queue_items set caption = $1 where id = $2', [out.caption, cur.id]);
    res.json({ item: await getItem(cur.id, req.uid), warning: out.warning });
  });

  r.post('/:id/publish', async (req, res) => {
    const row = await publishItem({ pool, cfg, fetchImpl, userId: req.uid, itemId: Number(req.params.id) });
    res.json({ item: await getItem(row.id, req.uid) });
  });

  /** Confere um Reels que ainda estava processando e publica se já estiver pronto. */
  r.post('/:id/check', async (req, res) => {
    const cur = await getItem(req.params.id, req.uid);
    if (cur.status !== 'processing') return res.json({ item: cur });
    const { rows } = await pool.query('select * from queue_items where id = $1', [cur.id]);
    try {
      await finishItem({ pool, cfg, fetchImpl, item: rows[0] });
    } catch (e) {
      throw new HttpError(502, `Não foi possível conferir agora: ${e.message}`);
    }
    res.json({ item: await getItem(cur.id, req.uid) });
  });

  r.post('/:id/mark-posted', async (req, res) => {
    const out = await pool.query(
      `update queue_items set status = 'posted', posted_at = now(), error = null
         where id = $1 and user_id = $2 and status in ('draft','scheduled','failed') returning id`,
      [Number(req.params.id), req.uid]
    );
    if (!out.rows.length) throw new HttpError(409, 'Não foi possível marcar este item como postado.');
    res.json({ item: await getItem(req.params.id, req.uid) });
  });

  r.post('/:id/reopen', async (req, res) => {
    const out = await pool.query(
      `update queue_items set status = 'draft', posted_at = null
         where id = $1 and user_id = $2 and status = 'posted' and external_id is null returning id`,
      [Number(req.params.id), req.uid]
    );
    if (!out.rows.length) throw new HttpError(409, 'Itens publicados pela API não podem voltar para a fila.');
    res.json({ item: await getItem(req.params.id, req.uid) });
  });

  r.delete('/:id', async (req, res) => {
    const out = await pool.query(
      `delete from queue_items where id = $1 and user_id = $2 and status <> 'publishing' returning id`,
      [Number(req.params.id), req.uid]
    );
    if (!out.rows.length) throw new HttpError(404, 'Item não encontrado ou em publicação.');
    res.json({ ok: true });
  });

  /** Upload de foto (JPEG/PNG) ou vídeo (MP4). O tipo é conferido pelo conteúdo do arquivo. */
  r.post('/upload', upload.single('file'), async (req, res) => {
    if (!local) {
      if (req.file) fs.rmSync(req.file.path, { force: true });
      throw new HttpError(400, 'Neste servidor o envio é direto para o armazenamento (veja /api/media/sign).');
    }
    if (!req.file) throw new HttpError(400, 'Envie um arquivo.');
    const tmp = req.file.path;
    try {
      const head = Buffer.alloc(16);
      const fd = fs.openSync(tmp, 'r');
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      const kind = sniff(head);
      if (!kind) throw new HttpError(400, 'Formato não aceito. Use JPEG, PNG ou MP4.');
      const name = `${crypto.randomBytes(16).toString('hex')}.${kind.ext}`;
      fs.renameSync(tmp, path.join(cfg.uploadDir, name));
      res.status(201).json({ url: `/uploads/${name}`, media_type: kind.type, format: kind.ext });
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  });

  return r;
}

module.exports = { queueRoutes };
