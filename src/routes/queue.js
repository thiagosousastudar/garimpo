const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { HttpError, isoOrNull } = require('../util');
const { buildCaption } = require('../services/copy');
const { publishItem, finishItem, EDITABLE } = require('../services/publisher');

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

  r.post('/', async (req, res) => {
    const channel = String(req.body?.channel || '');
    if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Canal deve ser instagram ou whatsapp.');
    const prod = await pool.query('select * from products where id = $1 and user_id = $2', [Number(req.body?.product_id), req.uid]);
    if (!prod.rows.length) throw new HttpError(404, 'Produto não encontrado.');
    const p = prod.rows[0];
    const out = await buildCaption(p, channel, { ai: Boolean(req.body?.ai), cfg, fetchImpl });
    let media_type = 'none';
    let media_url = null;
    if (channel === 'instagram') {
      if (p.image_url) { media_type = 'image'; media_url = p.image_url; }
      else if (p.video_url) { media_type = 'video'; media_url = p.video_url; }
    }
    const { rows } = await pool.query(
      `insert into queue_items (user_id, product_id, channel, caption, media_type, media_url)
         values ($1,$2,$3,$4,$5,$6) returning id`,
      [req.uid, p.id, channel, out.caption, media_type, media_url]
    );
    res.status(201).json({ item: await getItem(rows[0].id, req.uid), warning: out.warning });
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
    const out = await buildCaption(prod.rows[0], cur.channel, { ai: Boolean(req.body?.ai), cfg, fetchImpl });
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
