/**
 * Direct automático: quem comenta "QUERO" (ou outra palavra-chave) num post publicado pelo Garimpo recebe o link
 * do produto no Direct, pela resposta privada oficial da Meta (1 mensagem por comentário, até 7 dias depois).
 *
 * Os comentários são lidos a cada poucos minutos (posts dos últimos 7 dias; só busca de novo os posts cujo
 * número de comentários mudou). Modo automático envia sozinho; no manual, a pessoa revisa e envia na tela.
 */
const { HttpError } = require('../util');
const { createInstagramClient } = require('./instagram');

const WINDOW_MS = 7 * 864e5; // a Meta só aceita resposta privada até 7 dias depois do comentário
const SYNC_EVERY_MS = 3 * 60 * 1000;
const DEFAULT_KEYWORDS = ['quero', 'eu quero', 'link', 'manda', 'me manda', 'quanto', 'preço', 'valor', 'onde compra'];
const DEFAULT_TEMPLATE = 'Oi, {nome}! 💖 Que bom que você gostou!\n\nAqui está o link do {produto}:\n👉 {link}\n\nQualquer dúvida é só me chamar! ✨';
const PUBLIC_REPLIES = ['Te mandei no Direct! 💌', 'Já te enviei o link no Direct! 💖', 'Corre no Direct que o link tá lá! ✨', 'Link enviado no seu Direct! 😍'];
const NUMS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function settingsOf(u) {
  const kws = String(u?.dm_keywords || '').split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
  return {
    auto: Boolean(u?.dm_auto),
    keywords: kws.length ? kws : DEFAULT_KEYWORDS,
    template: u?.dm_template && u.dm_template.trim() ? u.dm_template : DEFAULT_TEMPLATE,
    public_reply: u?.dm_public_reply !== false,
  };
}

/** O comentário pede o link? Palavra ou expressão inteira, sem acento e sem diferenciar maiúsculas. */
function matches(text, keywords) {
  const t = ` ${norm(text).replace(/[^a-z0-9]+/g, ' ')} `;
  return keywords.some((k) => {
    const w = norm(k).replace(/[^a-z0-9]+/g, ' ').trim();
    return w && t.includes(` ${w} `);
  });
}

/** Produtos do post (pelo id do post publicado pelo Garimpo), na ordem do post. */
async function productsForMedia(pool, uid, mediaId) {
  const q = (await pool.query(
    `select id, product_id, product_ids from queue_items where user_id = $1 and channel = 'instagram' and external_id = $2 order by id desc limit 1`,
    [uid, mediaId])).rows[0];
  if (!q) return { queueItemId: null, products: [] };
  let ids = [];
  try { ids = q.product_ids ? JSON.parse(q.product_ids) : []; } catch (_) { ids = []; }
  if (!ids.length && q.product_id) ids = [q.product_id];
  const products = [];
  for (const id of ids) {
    const p = (await pool.query('select id, title, affiliate_url, product_url from products where id = $1 and user_id = $2', [id, uid])).rows[0];
    if (p) products.push(p);
  }
  return { queueItemId: q.id, products };
}

/**
 * Mensagem do Direct. Um produto: modelo com {nome}, {produto} e {link}.
 * Vários (carrossel): se a pessoa comentou um número, manda só aquele; senão, a lista numerada.
 */
function buildMessage(settings, comment, products) {
  const nome = comment.username ? comment.username.replace(/^@/, '') : 'tudo bem';
  const withLink = products.filter((p) => p.affiliate_url || p.product_url);
  if (!withLink.length) return null;
  let list = withLink;
  if (withLink.length > 1) {
    const n = Number((String(comment.text || '').match(/\b(10|[1-9])\b/) || [])[1]);
    if (n && products[n - 1] && (products[n - 1].affiliate_url || products[n - 1].product_url)) list = [products[n - 1]];
  }
  if (list.length === 1) {
    const p = list[0];
    return settings.template.split('{nome}').join(nome).split('{produto}').join(p.title).split('{link}').join(p.affiliate_url || p.product_url);
  }
  return [`Oi, ${nome}! 💖 Aqui estão os links:`, '', ...list.map((p, i) => `${NUMS[i] || `${i + 1}.`} ${p.title}\n👉 ${p.affiliate_url || p.product_url}`), '', 'Qualquer dúvida é só me chamar! ✨'].join('\n');
}

/** Mensagem de erro da Meta em português. */
function friendlyError(e) {
  const m = String(e?.message || '');
  if (/outside of allowed window|2534022/i.test(m)) return 'Passou de 7 dias do comentário: a Meta não deixa mais responder no Direct.';
  if (/already been replied|2534023|private reply/i.test(m) && /already/i.test(m)) return 'Este comentário já recebeu uma resposta privada.';
  if (/permission|not authorized|\(#10\)|\(#200\)|does not have/i.test(m)) {
    return 'A Meta não autorizou o envio: o app ainda está em modo de desenvolvimento (só funciona com contas testadoras) ou falta a permissão de mensagens.';
  }
  return m || 'Erro ao enviar.';
}

async function credentials(pool, cfg, uid) {
  const { credentialsFor } = require('./publisher');
  return credentialsFor(pool, cfg, uid);
}

/** Busca comentários novos dos posts dos últimos 7 dias e guarda. Devolve quantos novos. */
async function syncUser({ pool, cfg, fetchImpl, uid, settings }) {
  const { igUserId, token } = await credentials(pool, cfg, uid);
  const client = createInstagramClient({ cfg, fetchImpl });
  const own = (await pool.query('select ig_username from connections where user_id = $1', [uid])).rows[0]?.ig_username || null;
  const s = settings || settingsOf((await pool.query('select * from users where id = $1', [uid])).rows[0]);
  const media = (await client.recentMedia({ igUserId, token })).filter((m) => Date.now() - new Date(String(m.timestamp).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() < WINDOW_MS);
  let fresh = 0;
  for (const m of media) {
    const seen = (await pool.query('select comments_count from ig_media_seen where user_id = $1 and media_id = $2', [uid, m.id])).rows[0];
    const count = Number(m.comments_count) || 0;
    if (seen && seen.comments_count === count) continue;
    if (count > 0) {
      const { queueItemId } = await productsForMedia(pool, uid, m.id);
      for (const c of await client.comments({ mediaId: m.id, token })) {
        const username = c.username || c.from?.username || null;
        if (own && username && username.toLowerCase() === own.toLowerCase()) continue; // respostas da própria conta
        const exists = (await pool.query('select 1 from ig_comments where user_id = $1 and comment_id = $2', [uid, c.id])).rows.length;
        if (exists) continue;
        await pool.query(
          `insert into ig_comments (user_id, comment_id, media_id, queue_item_id, username, text, commented_at, matched)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [uid, c.id, m.id, queueItemId, username, String(c.text || '').slice(0, 1000),
            c.timestamp ? new Date(String(c.timestamp).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString() : null, matches(c.text, s.keywords)]);
        fresh++;
      }
    }
    if (seen) await pool.query('update ig_media_seen set comments_count = $1, checked_at = now() where user_id = $2 and media_id = $3', [count, uid, m.id]);
    else await pool.query('insert into ig_media_seen (user_id, media_id, comments_count) values ($1,$2,$3)', [uid, m.id, count]);
  }
  await pool.query('update users set dm_synced_at = now() where id = $1', [uid]);
  return fresh;
}

/** Envia o Direct de um comentário (texto pronto ou o personalizado). Reserva o comentário para não mandar duas vezes. */
async function sendFor({ pool, cfg, fetchImpl, uid, commentRowId, text: custom }) {
  const row = (await pool.query('select * from ig_comments where id = $1 and user_id = $2', [commentRowId, uid])).rows[0];
  if (!row) throw new HttpError(404, 'Comentário não encontrado.');
  if (row.status === 'enviado') throw new HttpError(409, 'Este comentário já recebeu o link no Direct.');
  if (row.commented_at && Date.now() - new Date(row.commented_at).getTime() > WINDOW_MS) {
    await pool.query(`update ig_comments set status = 'fora_do_prazo', error = $1 where id = $2`, ['Passou de 7 dias do comentário.', row.id]);
    throw new HttpError(400, 'Passou de 7 dias do comentário: a Meta não deixa mais responder no Direct.');
  }
  const s = settingsOf((await pool.query('select * from users where id = $1', [uid])).rows[0]);
  let text = custom && String(custom).trim();
  if (!text) {
    const { products } = await productsForMedia(pool, uid, row.media_id);
    text = buildMessage(s, row, products);
    if (!text) throw new HttpError(400, 'Este post não tem produto com link ligado a ele. Escreva a mensagem e envie.');
  }
  if (text.length > 1000) throw new HttpError(400, 'Mensagem longa demais (máximo de 1000 caracteres).');
  const claim = await pool.query(`update ig_comments set status = 'enviando' where id = $1 and status <> 'enviado' and status <> 'enviando' returning id`, [row.id]);
  if (!claim.rows.length) throw new HttpError(409, 'Este comentário já está sendo respondido.');
  const { igUserId, token } = await credentials(pool, cfg, uid);
  const client = createInstagramClient({ cfg, fetchImpl });
  try {
    await client.privateReply({ igUserId, token, commentId: row.comment_id, text });
  } catch (e) {
    const msg = friendlyError(e);
    await pool.query(`update ig_comments set status = 'erro', error = $1 where id = $2`, [msg, row.id]);
    throw new HttpError(e.rateLimited ? 429 : 502, msg);
  }
  await pool.query(`update ig_comments set status = 'enviado', sent_at = now(), reply_text = $1, error = null where id = $2`, [text, row.id]);
  if (s.public_reply) {
    const pub = PUBLIC_REPLIES[Math.floor(Math.random() * PUBLIC_REPLIES.length)];
    try { await client.replyComment({ commentId: row.comment_id, token, text: pub }); } catch (_) { /* a resposta pública é só um extra */ }
  }
  return (await pool.query('select * from ig_comments where id = $1', [row.id])).rows[0];
}

/** Envia sozinho para os comentários novos que pediram o link (modo automático). */
async function autoSend({ pool, cfg, fetchImpl, uid, log = console, max = 20 }) {
  const { rows } = await pool.query(
    `select id from ig_comments where user_id = $1 and status = 'novo' and matched = true order by id limit $2`, [uid, max]);
  let sent = 0;
  for (const r of rows) {
    try { await sendFor({ pool, cfg, fetchImpl, uid, commentRowId: r.id }); sent++; } catch (e) { log.error?.(`[direct] comentário ${r.id}: ${e.message}`); }
  }
  return sent;
}

/** Agendador: para quem ligou o automático, lê os comentários a cada 3 minutos e responde. */
async function runDmTick({ pool, cfg, fetchImpl, log = console }) {
  const since = new Date(Date.now() - SYNC_EVERY_MS).toISOString();
  // Política de privacidade: comentários e respostas guardados por até 90 dias
  await pool.query('delete from ig_comments where created_at < $1', [new Date(Date.now() - 90 * 864e5).toISOString()]);
  const { rows } = await pool.query(
    `select u.* from users u join connections c on c.user_id = u.id
       where u.dm_auto = true and c.ig_token_enc is not null and (u.dm_synced_at is null or u.dm_synced_at < $1)`, [since]);
  let sent = 0;
  for (const u of rows.slice(0, 10)) {
    const claim = await pool.query('update users set dm_synced_at = now() where id = $1 and (dm_synced_at is null or dm_synced_at < $2) returning id', [u.id, since]);
    if (!claim.rows.length) continue;
    try {
      await syncUser({ pool, cfg, fetchImpl, uid: u.id, settings: settingsOf(u) });
      sent += await autoSend({ pool, cfg, fetchImpl, uid: u.id, log });
    } catch (e) {
      log.error?.(`[direct] usuário ${u.id}: ${e.message}`);
    }
  }
  return sent;
}

module.exports = {
  settingsOf, matches, buildMessage, syncUser, sendFor, autoSend, runDmTick, productsForMedia,
  DEFAULT_KEYWORDS, DEFAULT_TEMPLATE, WINDOW_MS,
};
