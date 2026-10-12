const { HttpError, decrypt, encrypt } = require('../util');
const { createInstagramClient } = require('./instagram');

const EDITABLE = ['draft', 'scheduled', 'failed'];
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_PUBLISHING_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function absoluteMediaUrl(cfg, url) {
  if (!url) return null;
  return url.startsWith('/') ? cfg.appUrl + url : url;
}

const MAX_CAROUSEL = 10;

/** Lista de mídias de um carrossel ([{ type: 'image'|'video', url }]) gravada como JSON. */
function parseMediaItems(raw) {
  if (!raw) return [];
  try {
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

/** Confere uma mídia: URL pública e, para foto, JPEG. Devolve a URL absoluta. */
function checkMedia(cfg, rawUrl, kind) {
  const url = absoluteMediaUrl(cfg, rawUrl);
  if (!url) throw new HttpError(400, 'Falta a URL da mídia.');
  let host;
  try { host = new URL(url).hostname; } catch (_) { throw new HttpError(400, 'URL da mídia inválida.'); }
  if (['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new HttpError(400, 'A mídia está em um endereço local. O Instagram precisa de uma URL pública (configure APP_URL com o domínio do app).');
  }
  // Fotos das lojas (ex.: Shopee) costumam vir sem extensão; só recusa quando a extensão é claramente outra.
  const ext = (new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
  if (kind === 'image' && ext && !/^jpe?g$/i.test(ext)) {
    throw new HttpError(400, 'Para foto, o Instagram aceita apenas JPEG (.jpg).');
  }
  return url;
}

/**
 * Valida o post antes de enviar. Devolve a URL da mídia (post simples) ou a lista
 * [{ kind, url }] do carrossel (2 a 10 fotos/vídeos).
 */
function validate(item, cfg) {
  if (item.channel !== 'instagram') throw new HttpError(400, 'Só é possível publicar automaticamente no Instagram.');
  if (!item.caption || !item.caption.trim()) throw new HttpError(400, 'A legenda está vazia.');
  if (item.caption.length > 2200) throw new HttpError(400, 'A legenda passa de 2.200 caracteres.');
  const tags = (item.caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (tags > 30) throw new HttpError(400, 'O Instagram aceita no máximo 30 hashtags.');
  if (item.media_type === 'carousel') {
    const list = parseMediaItems(item.media_items);
    if (list.length < 2) throw new HttpError(400, 'O carrossel precisa de pelo menos 2 fotos ou vídeos.');
    if (list.length > MAX_CAROUSEL) throw new HttpError(400, 'O Instagram aceita no máximo 10 fotos ou vídeos no carrossel.');
    return list.map((m) => {
      const kind = m.type === 'video' ? 'video' : 'image';
      return { kind, url: checkMedia(cfg, m.url, kind) };
    });
  }
  if (item.media_type !== 'image' && item.media_type !== 'video') {
    throw new HttpError(400, 'Adicione uma foto ou um vídeo antes de publicar no Instagram.');
  }
  return checkMedia(cfg, item.media_url, item.media_type);
}

/** Situação conjunta dos itens do carrossel: FINISHED (todos prontos), ERROR (algum falhou) ou IN_PROGRESS. */
async function childrenStatus(client, token, ids) {
  const all = await Promise.all(ids.map((id) => client.containerStatus({ containerId: id, token })));
  if (all.some((s) => s === 'ERROR' || s === 'EXPIRED')) return 'ERROR';
  return all.every((s) => s === 'FINISHED' || s === 'PUBLISHED') ? 'FINISHED' : 'IN_PROGRESS';
}

/** Cria o container do carrossel com os itens prontos e publica. */
async function publishCarousel({ pool, cfg, client, igUserId, token, itemId, children, caption }) {
  const carousel = await client.createCarousel({ igUserId, token, children, caption });
  for (let i = 0; i < Math.max(1, cfg.videoInlinePolls); i++) {
    const st = await client.containerStatus({ containerId: carousel.id, token });
    if (st === 'FINISHED') break;
    if (st === 'ERROR' || st === 'EXPIRED') throw new Error('O Instagram não conseguiu montar o carrossel.');
    await sleep(cfg.videoPollMs);
  }
  return markPosted(pool, itemId, await client.publishContainer({ igUserId, token, containerId: carousel.id }));
}

const CHILDREN = 'children:';

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

    // Carrossel: cria cada item (foto/vídeo), espera os vídeos ficarem prontos e publica o conjunto.
    // Se os vídeos demorarem, fica em "processing" com os itens anotados e é concluído depois (Verificar/agendador).
    if (item.media_type === 'carousel') {
      const children = [];
      for (const m of mediaUrl) {
        children.push((await client.createContainer({ igUserId, token, kind: m.kind, mediaUrl: m.url, carouselItem: true })).id);
      }
      if (mediaUrl.some((m) => m.kind === 'video')) {
        await pool.query(`update queue_items set status = 'processing', container_id = $1, claimed_at = now() where id = $2`,
          [CHILDREN + children.join(','), item.id]);
        for (let i = 0; i < cfg.videoInlinePolls; i++) {
          const st = await childrenStatus(client, token, children);
          if (st === 'FINISHED') return await publishCarousel({ pool, cfg, client, igUserId, token, itemId: item.id, children, caption: item.caption });
          if (st === 'ERROR') throw new Error('O Instagram não conseguiu processar um dos vídeos do carrossel.');
          await sleep(cfg.videoPollMs);
        }
        return (await pool.query('select * from queue_items where id = $1', [item.id])).rows[0];
      }
      return await publishCarousel({ pool, cfg, client, igUserId, token, itemId: item.id, children, caption: item.caption });
    }

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
    const isCarousel = String(item.container_id || '').startsWith(CHILDREN);
    const children = isCarousel ? item.container_id.slice(CHILDREN.length).split(',').filter(Boolean) : [];
    const st = isCarousel ? await childrenStatus(client, token, children) : await client.containerStatus({ containerId: item.container_id, token });
    if (st === 'FINISHED') {
      const claim = await pool.query(
        `update queue_items set status = 'publishing', claimed_at = now() where id = $1 and status = 'processing' returning id`,
        [item.id]
      );
      if (!claim.rows.length) return (await pool.query('select * from queue_items where id = $1', [item.id])).rows[0];
      try {
        if (isCarousel) return await publishCarousel({ pool, cfg, client, igUserId, token, itemId: item.id, children, caption: item.caption });
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
/**
 * Renova os tokens do login do Instagram (valem 60 dias) com mais de 7 dias, para a publicação não parar
 * quando vencerem. Tokens do login do Facebook não são renovados por aqui. Falha só é registrada no log.
 */
async function refreshInstagramTokens({ pool, cfg, fetchImpl, log = console }) {
  const { rows } = await pool.query(
    `select user_id, ig_token_enc from connections where ig_token_enc is not null and updated_at < $1`,
    [new Date(Date.now() - 7 * 864e5).toISOString()]
  );
  let refreshed = 0;
  const client = createInstagramClient({ cfg, fetchImpl });
  for (const r of rows) {
    let token;
    try { token = decrypt(r.ig_token_enc, cfg.encryptionKey); } catch (_) { continue; }
    try {
      const out = await client.refreshToken(token);
      if (!out) continue;
      await pool.query('update connections set ig_token_enc = $1, updated_at = now() where user_id = $2',
        [encrypt(out.token, cfg.encryptionKey), r.user_id]);
      refreshed++;
    } catch (e) {
      log.error(`[agendador] não renovou o token do Instagram (conta ${r.user_id}): ${e.message}`);
    }
  }
  return refreshed;
}

async function processDue({ pool, cfg, fetchImpl, log = console }) {
  const result = { published: 0, finished: 0, failed: 0, released: 0 };
  result.tokens_refreshed = await refreshInstagramTokens({ pool, cfg, fetchImpl, log }).catch(() => 0);

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

module.exports = { publishItem, finishItem, processDue, startScheduler, refreshInstagramTokens, EDITABLE, validate, credentialsFor, parseMediaItems, MAX_CAROUSEL };
