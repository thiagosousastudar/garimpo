const { HttpError, decrypt } = require('../util');
const { createInstagramClient } = require('./instagram');

const EDITABLE = ['draft', 'scheduled', 'failed'];
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_PUBLISHING_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function absoluteMediaUrl(cfg, url) {
  if (!url) return null;
  return url.startsWith('/') ? cfg.appUrl + url : url;
}

function validate(item, cfg) {
  if (item.channel !== 'instagram') throw new HttpError(400, 'Só é possível publicar automaticamente no Instagram.');
  if (!item.caption || !item.caption.trim()) throw new HttpError(400, 'A legenda está vazia.');
  if (item.caption.length > 2200) throw new HttpError(400, 'A legenda passa de 2.200 caracteres.');
  const tags = (item.caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (tags > 30) throw new HttpError(400, 'O Instagram aceita no máximo 30 hashtags.');
  if (item.media_type !== 'image' && item.media_type !== 'video') {
    throw new HttpError(400, 'Adicione uma foto ou um vídeo antes de publicar no Instagram.');
  }
  const url = absoluteMediaUrl(cfg, item.media_url);
  if (!url) throw new HttpError(400, 'Falta a URL da mídia.');
  let host;
  try { host = new URL(url).hostname; } catch (_) { throw new HttpError(400, 'URL da mídia inválida.'); }
  if (['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new HttpError(400, 'A mídia está em um endereço local. O Instagram precisa de uma URL pública (configure APP_URL com o domínio do app).');
  }
  // Fotos das lojas (ex.: Shopee) costumam vir sem extensão; só recusa quando a extensão é claramente outra.
  const ext = (new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  if (item.media_type === 'image' && ext && !/^jpe?g$/i.test(ext)) {
    throw new HttpError(400, 'Para foto, o Instagram aceita apenas JPEG (.jpg).');
  }
  return url;
}

async function credentialsFor(pool, cfg, userId) {
  const conn = (await pool.query('select ig_user_id, ig_token_enc from connections where user_id = $1', [userId])).rows[0];
  if (!conn || !conn.ig_user_id || !conn.ig_token_enc) {
    throw new HttpError(400, 'Conecte sua conta do Instagram na aba Conexões.');
  }
  return { igUserId: conn.ig_user_id, token: decrypt(conn.ig_token_enc, cfg.encryptionKey) };
}

async function markPosted(pool, itemId, out) {
  const done = await pool.query(
    `update queue_items set status = 'posted', posted_at = now(), external_id = $1, permalink = $2, error = null
       where id = $3 returning *`,
    [out.id, out.permalink, itemId]
  );
  return done.rows[0];
}

async function markFailed(pool, itemId, message) {
  await pool.query(`update queue_items set status = 'failed', error = $1 where id = $2`, [message, itemId]);
}

/**
 * Publica um item da fila no Instagram. O item é reservado de forma atômica (status "publishing"),
 * então chamadas simultâneas não publicam em duplicidade.
 * Foto: publica na hora. Vídeo (Reels): cria o container, espera um pouco e, se o Instagram ainda estiver
 * processando, deixa o item em "processing" para ser concluído pelo agendador (ou pelo botão Verificar).
 */
async function publishItem({ pool, cfg, fetchImpl, userId, itemId }) {
  const { rows } = await pool.query(
    `update queue_items set status = 'publishing', error = null, claimed_at = now(), container_id = null
       where id = $1 and user_id = $2 and status in ('draft','scheduled','failed')
       returning *`,
    [itemId, userId]
  );
  if (!rows.length) {
    const cur = await pool.query('select status from queue_items where id = $1 and user_id = $2', [itemId, userId]);
    if (!cur.rows.length) throw new HttpError(404, 'Item não encontrado.');
    const s = cur.rows[0].status;
    throw new HttpError(409, s === 'posted' ? 'Este item já foi publicado.' : 'Este item está sendo publicado agora.');
  }
  const item = rows[0];

  try {
    const mediaUrl = validate(item, cfg);
    const { igUserId, token } = await credentialsFor(pool, cfg, userId);
    const client = createInstagramClient({ cfg, fetchImpl });
    const container = await client.createContainer({ igUserId, token, kind: item.media_type, mediaUrl, caption: item.caption });

    if (item.media_type === 'image') {
      return await markPosted(pool, item.id, await client.publishContainer({ igUserId, token, containerId: container.id }));
    }

    await pool.query(`update queue_items set status = 'processing', container_id = $1, claimed_at = now() where id = $2`, [container.id, item.id]);
    for (let i = 0; i < cfg.videoInlinePolls; i++) {
      const st = await client.containerStatus({ containerId: container.id, token });
      if (st === 'FINISHED') {
        return await markPosted(pool, item.id, await client.publishContainer({ igUserId, token, containerId: container.id }));
      }
      if (st === 'ERROR' || st === 'EXPIRED') throw new Error('O Instagram não conseguiu processar o vídeo.');
      await sleep(cfg.videoPollMs);
    }
    return (await pool.query('select * from queue_items where id = $1', [item.id])).rows[0];
  } catch (e) {
    await markFailed(pool, item.id, e.message);
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Falha ao publicar: ${e.message}`);
  }
}

/** Confere um Reels que estava em processamento e publica se já estiver pronto. */
async function finishItem({ pool, cfg, fetchImpl, item }) {
  const age = Date.now() - new Date(item.claimed_at || 0).getTime();
  try {
    const { igUserId, token } = await credentialsFor(pool, cfg, item.user_id);
    const client = createInstagramClient({ cfg, fetchImpl });
    const st = await client.containerStatus({ containerId: item.container_id, token });
    if (st === 'FINISHED') {
      const claim = await pool.query(
        `update queue_items set status = 'publishing', claimed_at = now() where id = $1 and status = 'processing' returning id`,
        [item.id]
      );
      if (!claim.rows.length) return (await pool.query('select * from queue_items where id = $1', [item.id])).rows[0];
      try {
        return await markPosted(pool, item.id, await client.publishContainer({ igUserId, token, containerId: item.container_id }));
      } catch (e) {
        await markFailed(pool, item.id, e.message);
        throw e;
      }
    }
    if (st === 'ERROR' || st === 'EXPIRED') {
      await markFailed(pool, item.id, 'O Instagram não conseguiu processar o vídeo.');
    } else if (age > PROCESSING_TIMEOUT_MS) {
      await markFailed(pool, item.id, 'O vídeo demorou demais para processar. Tente publicar de novo.');
    }
  } catch (e) {
    if (age > PROCESSING_TIMEOUT_MS) await markFailed(pool, item.id, e.message);
    else await pool.query('update queue_items set error = $1 where id = $2 and status = $3', [e.message, item.id, 'processing']);
    throw e;
  }
  return (await pool.query('select * from queue_items where id = $1', [item.id])).rows[0];
}

/**
 * Um ciclo do agendador: publica o que venceu, conclui os Reels em processamento
 * e libera itens que ficaram presos em "publishing" por muito tempo.
 */
async function processDue({ pool, cfg, fetchImpl, log = console }) {
  const result = { published: 0, finished: 0, failed: 0, released: 0 };

  const stale = await pool.query(
    `update queue_items set status = 'failed',
       error = 'A publicação foi interrompida. Confira no Instagram se o post saiu antes de tentar de novo.'
       where status = 'publishing' and claimed_at < $1 returning id`,
    [new Date(Date.now() - STALE_PUBLISHING_MS).toISOString()]
  );
  result.released = stale.rows.length;

  const due = await pool.query(
    `select id, user_id from queue_items
       where status = 'scheduled' and channel = 'instagram' and scheduled_at <= now()
       order by scheduled_at limit 5`
  );
  for (const r of due.rows) {
    try {
      const row = await publishItem({ pool, cfg, fetchImpl, userId: r.user_id, itemId: r.id });
      if (row.status === 'posted') result.published++;
      log.log(`[agendador] item ${r.id}: ${row.status}`);
    } catch (e) {
      result.failed++;
      log.error(`[agendador] item ${r.id} falhou: ${e.message}`);
    }
  }

  const proc = await pool.query(`select * from queue_items where status = 'processing' order by claimed_at limit 10`);
  for (const item of proc.rows) {
    try {
      const row = await finishItem({ pool, cfg, fetchImpl, item });
      if (row.status === 'posted') { result.finished++; log.log(`[agendador] item ${item.id} publicado`); }
      else if (row.status === 'failed') result.failed++;
    } catch (e) {
      log.error(`[agendador] item ${item.id}: ${e.message}`);
    }
  }
  return result;
}

/** Agendador interno, para rodar em servidor próprio (Docker, VPS). Na Vercel, use o endpoint /api/cron/tick. */
function startScheduler({ pool, cfg, fetchImpl, log = console }) {
  let running = false;
  async function tick() {
    if (running) return null;
    running = true;
    try {
      return await processDue({ pool, cfg, fetchImpl, log });
    } catch (e) {
      log.error('[agendador] erro:', e.message);
      return null;
    } finally {
      running = false;
    }
  }
  const timer = setInterval(tick, cfg.schedulerMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

module.exports = { publishItem, finishItem, processDue, startScheduler, EDITABLE, validate, credentialsFor };
