/**
 * Automação por post (Direct): cada post tem a sua palavra-gatilho, respostas ao comentário, texto do Direct e
 * produtos. Quem comenta a palavra recebe, numa mensagem só (a Meta permite uma resposta privada por comentário),
 * o texto e os produtos com botão "Ver na Shopee" / "Ver no Mercado Livre".
 */
const { HttpError } = require('../util');

const MAX_ITEMS = 10;
const NUMS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const AUTO_REPLIES = {
  feminino: ['Te mandei no Direct! 💌', 'Já te enviei o link no Direct! 💖', 'Corre no Direct que o link tá lá! ✨', 'Link enviado no seu Direct! 😍'],
  masculino: ['Te mandei no Direct! 👊', 'Link enviado no Direct! 📩', 'Confere o Direct, mandei lá! 🔥', 'Já mandei no Direct! ✅'],
};
const DEFAULT_DM = {
  feminino: 'Oie, {nome}! 💖 Segue o que você pediu:',
  masculino: 'Fala, {nome}! 👊 Segue o que você pediu:',
};

const httpsUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : '');
const listOf = (v, sep) => String(v || '').split(sep).map((x) => x.trim()).filter(Boolean);
const storeOf = (url, marketplace) => (marketplace === 'ML' || /mercadoli[vb]re|meli\.la/i.test(String(url || '')) ? 'ML' : 'SH');
const buttonFor = (store) => (store === 'ML' ? 'Ver no Mercado Livre' : 'Ver na Shopee');

function parse(row) {
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items || '[]'); } catch (_) { items = []; }
  return {
    id: row.id, media_id: row.media_id, permalink: row.permalink, thumb_url: row.thumb_url, caption: row.caption,
    keywords: listOf(row.keywords, /[,;\n]/), replies: row.replies || 'AUTO', dm_text: row.dm_text || '', button_text: row.button_text || '',
    items: Array.isArray(items) ? items : [], active: row.active !== false, updated_at: row.updated_at,
  };
}

async function automationFor(pool, uid, mediaId, { onlyActive = true } = {}) {
  const row = (await pool.query('select * from post_automations where user_id = $1 and media_id = $2', [uid, String(mediaId)])).rows[0];
  const a = parse(row);
  return a && (!onlyActive || a.active) ? a : null;
}

/** Confere o que veio da tela. Itens: { product_id } (produto do Garimpo) ou { name, link } (colado). */
async function cleanAutomation(pool, uid, b) {
  const keywords = listOf(b?.keywords, /[,;\n]/).map((k) => k.slice(0, 40)).slice(0, 10);
  if (!keywords.length) throw new HttpError(400, 'Informe a palavra-chave gatilho (ex.: EU QUERO).');
  const rawReplies = String(b?.replies || '').trim();
  const replies = !rawReplies || /^auto$/i.test(rawReplies) ? 'AUTO' : listOf(rawReplies, ';').map((x) => x.slice(0, 150)).slice(0, 10).join('; ');
  const dm = String(b?.dm_text || '').trim();
  if (dm.length > 500) throw new HttpError(400, 'O texto do Direct pode ter no máximo 500 caracteres.');
  const button = String(b?.button_text || '').trim().slice(0, 20);
  const raw = Array.isArray(b?.items) ? b.items : [];
  if (!raw.length) throw new HttpError(400, 'Adicione pelo menos um produto (link de afiliado).');
  if (raw.length > MAX_ITEMS) throw new HttpError(400, `No máximo ${MAX_ITEMS} produtos por post.`);
  const own = new Map((await pool.query('select id from products where user_id = $1', [uid])).rows.map((p) => [p.id, true]));
  const items = raw.map((x, i) => {
    if (x && x.product_id) {
      const id = Number(x.product_id);
      if (!own.has(id)) throw new HttpError(400, 'Algum produto da automação não existe mais.');
      return { product_id: id, name: String(x.name || '').trim().slice(0, 80) || null };
    }
    const link = httpsUrl(x && x.link);
    const name = String((x && x.name) || '').trim().slice(0, 80);
    if (!link) throw new HttpError(400, `O link do produto ${i + 1} precisa começar com https://.`);
    if (!name) throw new HttpError(400, `Dê um nome para o produto ${i + 1}.`);
    return { name, link };
  });
  const text = (v, n) => (v == null ? null : String(v).slice(0, n));
  return {
    keywords: keywords.join(', '), replies, dm_text: dm || null, button_text: button || null, items, active: b?.active !== false,
    permalink: httpsUrl(b?.permalink) || null, thumb_url: httpsUrl(b?.thumb_url) || null, caption: text(b?.caption, 300),
  };
}

/** Itens com o link atual (produto do Garimpo usa o link de afiliado de agora). */
async function resolveItems(pool, uid, a) {
  const ids = a.items.filter((x) => x.product_id).map((x) => x.product_id);
  const prods = ids.length ? new Map((await pool.query('select id, title, affiliate_url, product_url, image_url, price, marketplace from products where user_id = $1', [uid])).rows.filter((p) => ids.includes(p.id)).map((p) => [p.id, p])) : new Map();
  const out = [];
  for (const x of a.items) {
    if (x.product_id) {
      const p = prods.get(x.product_id);
      const link = p && (httpsUrl(p.affiliate_url) || httpsUrl(p.product_url));
      if (link) out.push({ product_id: p.id, name: x.name || p.title, link, image: httpsUrl(p.image_url) || null, price: Number(p.price), store: storeOf(link, p.marketplace) });
    } else if (x.link) {
      out.push({ product_id: null, name: x.name, link: x.link, image: null, price: null, store: storeOf(x.link) });
    }
  }
  return out;
}

/**
 * A mensagem do Direct (uma só): texto + produtos. Até 3 produtos vão com botão ("Ver na Shopee"); com mais,
 * a lista vai em texto com os links (clicáveis). Devolve { message, text } — "text" é a versão só em texto (reserva).
 */
function buildDirect(a, items, { nome, voice }) {
  const intro = (a.dm_text || DEFAULT_DM[voice] || DEFAULT_DM.feminino).split('{nome}').join(nome || '').replace(/\s+([,!?.])/g, '$1').trim();
  const many = items.length > 1;
  const text = [intro, '', ...items.map((it, i) => `${many ? `${NUMS[i] || `${i + 1}.`} ` : ''}${it.name}\n👉 ${it.link}`).join('\n\n').split('\n')].join('\n').trim();
  if (items.length > 3 || text.length > 640) return { message: { text: text.slice(0, 1000) }, text: text.slice(0, 1000) };
  const buttons = items.map((it, i) => {
    const label = a.button_text || buttonFor(it.store);
    const title = many ? `${i + 1}. ${label === 'Ver no Mercado Livre' ? 'Ver no ML' : label}` : label;
    return { type: 'web_url', url: it.link, title: title.slice(0, 20) };
  });
  return { message: { attachment: { type: 'template', payload: { template_type: 'button', text, buttons } } }, text };
}

/** Resposta pública no comentário: AUTO sorteia no tom da conta; senão, uma das frases (separadas por ;). */
function publicReply(a, voice) {
  const list = a.replies && !/^auto$/i.test(a.replies) ? listOf(a.replies, ';') : AUTO_REPLIES[voice] || AUTO_REPLIES.feminino;
  return list[Math.floor(Math.random() * list.length)];
}

module.exports = { automationFor, cleanAutomation, resolveItems, buildDirect, publicReply, parse, MAX_ITEMS };
