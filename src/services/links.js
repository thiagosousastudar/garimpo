/**
 * Links curtos do Garimpo (/r/CODIGO): levam ao link de afiliado e contam os cliques.
 * Um link por pessoa no Direct, para saber quem pediu e clicou. Não guarda IP nem dados do aparelho:
 * só a quantidade e a data do primeiro e do último clique. Visitas de robôs de prévia (Instagram, WhatsApp,
 * Telegram...) não contam.
 */
const crypto = require('crypto');

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOTS = /facebookexternalhit|facebot|whatsapp|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|googlebot|bingbot|instagram.*bot|preview|crawler|spider|bot\b/i;

function newCode(len = 7) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** Cria um link curto. Devolve { code, url }. */
async function createLink(pool, cfg, { uid, productId = null, commentId = null, channel = 'direct', target }) {
  if (!/^https:\/\//i.test(String(target || ''))) throw new Error('Link de destino inválido.');
  for (let i = 0; i < 4; i++) {
    const code = newCode();
    try {
      await pool.query(
        'insert into tracked_links (code, user_id, product_id, ig_comment_id, channel, target_url) values ($1,$2,$3,$4,$5,$6)',
        [code, uid, productId, commentId, channel, target]);
      return { code, url: `${cfg.appUrl}/r/${code}` };
    } catch (e) {
      if (e.code !== '23505') throw e; // código repetido: tenta outro
    }
  }
  throw new Error('Não consegui criar o link curto.');
}

/** Resolve o código: conta o clique (se não for robô) e devolve o destino, ou null. */
async function resolveLink(pool, code, userAgent = '') {
  if (!/^[A-Za-z0-9]{5,12}$/.test(String(code || ''))) return null;
  const row = (await pool.query('select id, target_url from tracked_links where code = $1', [code])).rows[0];
  if (!row) return null;
  if (!BOTS.test(String(userAgent))) {
    await pool.query(
      'update tracked_links set clicks = clicks + 1, first_click_at = coalesce(first_click_at, now()), last_click_at = now() where id = $1', [row.id]);
  }
  return row.target_url;
}

module.exports = { createLink, resolveLink, newCode, BOTS };
