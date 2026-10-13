const { scoreProduct } = require('./score');
const { parseExtras } = require('./extras');

const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const PLACEHOLDER = '[SEU LINK DE AFILIADO]';

const TAGS = {
  'casa e cozinha': '#casa #cozinha #organização',
  eletrônicos: '#tecnologia #gadgets #eletrônicos',
  eletronicos: '#tecnologia #gadgets #eletrônicos',
  beleza: '#beleza #skincare #autocuidado',
  acessórios: '#acessórios #praticidade',
  acessorios: '#acessórios #praticidade',
};

/**
 * Vendas (em milhares) em texto: "mais de 3 mil vendidos", "mais de 300 vendidos".
 * Abaixo de 100 vendas não entra no texto (não ajuda a vender).
 */
function salesText(k, cap) {
  const n = Number(k) || 0;
  let t = '';
  if (n >= 1) t = `mais de ${Math.floor(n)} mil vendidos`;
  else if (n >= 0.1) t = `mais de ${Math.floor(n * 10) * 100} vendidos`;
  return cap && t ? t[0].toUpperCase() + t.slice(1) : t;
}

function hashtags(p) {
  const base = TAGS[String(p.category || '').toLowerCase()] || '';
  const all = `${base} #achadinhos ${p.marketplace === 'ML' ? '#mercadolivre' : '#shopee'} #ofertas`.split(/\s+/).filter(Boolean);
  return [...new Set(all)].join(' ');
}

function marketplaceName(p) {
  return p.marketplace === 'ML' ? 'Mercado Livre' : 'Shopee';
}

/** Detalhes extras do produto, venham eles da linha do banco (texto JSON) ou já abertos. */
function details(p) {
  return p.features || p.images ? p : { ...p, ...parseExtras(p.extras) };
}

/** Linhas de fatos que podem entrar no texto. Só usa o que está cadastrado. */
function facts(p) {
  const { desc } = scoreProduct(p);
  const d = details(p);
  const out = [];
  const from = d.price_max > Number(p.price); // variações: o preço é o "a partir de"
  if (desc > 0 && p.original_price) out.push(`de ${brl(p.original_price)} ${from ? 'a partir de' : 'por'} ${brl(p.price)} (−${desc}%)`);
  else out.push(`${from ? 'a partir de' : 'por'} ${brl(p.price)}`);
  if (from) out.push('tem opções (kits/tamanhos): o preço muda conforme a escolha');
  if (d.best_seller_rank && d.best_seller_rank <= 20) out.push(`${d.best_seller_rank}º mais vendido da categoria`);
  if (Number(p.rating)) out.push(`avaliação ★ ${Number(p.rating).toFixed(1)}`);
  if (salesText(p.sales_k)) out.push(salesText(p.sales_k));
  if (d.free_shipping) out.push(d.full ? 'frete grátis com entrega Full' : 'frete grátis');
  if (d.official_store) out.push('vendido por loja oficial');
  return out;
}

/** Características principais (até 2), curtas, para o Instagram. */
function highlights(p) {
  return (details(p).features || []).slice(0, 2).map((f) => (f.length > 110 ? `${f.slice(0, 107).replace(/\s+\S*$/, '')}…` : f));
}

/* ---------- voz da Anninha: amiga que achou algo incrível ---------- */
const pick = (list) => list[Math.floor(Math.random() * list.length)];
// Aberturas (variam a cada "Refazer texto" para o grupo não ver sempre a mesma mensagem)
const WA_HOOKS = [
  '🔥 *ACHEI ESSA E PRECISEI TE MOSTRAR!*',
  '😍 *GENTE, OLHA O QUE EU ACHEI!*',
  '🚨 *ACHADINHO IMPERDÍVEL NA ÁREA!*',
  '💖 *SEPAREI ESSE ACHADO PRA VOCÊ!*',
  '👀 *OLHA ESSE ACHADINHO QUE EU TROUXE!*',
];
const WA_HOOKS_DISCOUNT = ['🔥 *QUE DESCONTO É ESSE?!*', '😱 *NÃO ACREDITEI NESSE PREÇO!*', '💥 *PREÇO DE ACHADINHO, OLHA ISSO!*'];
// Fechamento: chama para agir sem inventar prazo (o app não sabe quando a oferta acaba)
const WA_CLOSERS = [
  '⏰ Preço pode mudar a qualquer momento, aproveita! 😱',
  '🏃‍♀️ Corre que preço bom assim some rapidinho! 😱',
  '💬 Garante o seu e depois me conta! 💖',
];
const IG_HOOKS = ['Achado do dia 👀', 'Olha o que eu achei pra vocês 😍', 'Achadinho que vale a pena 💖', 'Gente, que achado! 🔥'];

/** Linhas de destaque do WhatsApp: frete, ranking, vendas, loja oficial (só o que for verdade). */
function waPerks(p) {
  const d = details(p);
  const out = [];
  if (d.free_shipping) out.push(d.full ? '🚚 *Frete grátis* com entrega Full!' : '🚚 *Frete grátis!*');
  if (d.best_seller_rank && d.best_seller_rank <= 20) out.push(`🏆 ${d.best_seller_rank}º mais vendido da categoria`);
  if (salesText(p.sales_k)) out.push(`⭐ ${salesText(p.sales_k, true)}`);
  if (d.official_store) out.push('🏪 Vendido por loja oficial');
  return out;
}

function templateCopy(p, channel) {
  const f = facts(p);
  if (channel === 'whatsapp') {
    const { desc } = scoreProduct(p);
    const off = desc > 0 && p.original_price;
    const from = details(p).price_max > Number(p.price);
    return [
      off && desc >= 30 ? pick(WA_HOOKS_DISCOUNT) : pick(WA_HOOKS),
      '',
      `🛍️ *${p.title}*`,
      '',
      ...(off ? [`💸 De: ~${brl(p.original_price)}~`, `💥 ${from ? 'A partir de' : 'Por'}: *${brl(p.price)}* (−${desc}% OFF)`] : [`💥 ${from ? 'A partir de' : 'Por apenas'}: *${brl(p.price)}*`]),
      ...(from ? ['📦 Tem opções (kits/tamanhos): o preço muda conforme a escolha'] : []),
      ...waPerks(p),
      '',
      `👉 ${p.affiliate_url || PLACEHOLDER}`,
      '',
      pick(WA_CLOSERS),
    ].join('\n');
  }
  // Instagram: preço em linhas próprias, logo abaixo do nome (o Instagram não tem negrito nem riscado)
  const perks = f.slice(1).filter((x) => !/^tem opções/.test(x)).map((x) => `✅ ${x[0].toUpperCase()}${x.slice(1)}`);
  const hl = highlights(p).map((x) => `▫️ ${x}`);
  return [
    pick(IG_HOOKS),
    '',
    `✨ ${p.title}`,
    '',
    ...igPrice(p),
    ...(perks.length ? ['', ...perks] : []),
    ...(hl.length ? ['', ...hl] : []),
    '',
    '👉 Link na bio! Comenta EU QUERO que eu te mando.',
    'Preços e estoque podem mudar.',
    '',
    hashtags(p),
  ].join('\n');
}

/** Bloco de preço do Instagram: "de / por (−x%) / economia", ou "por apenas", ou "a partir de" (variações). */
function igPrice(p) {
  const { desc } = scoreProduct(p);
  const from = details(p).price_max > Number(p.price);
  const off = desc > 0 && p.original_price;
  const lines = [];
  if (off) lines.push(`💸 De ${brl(p.original_price)}`);
  lines.push(`🔥 ${from ? 'A partir de' : off ? 'Por' : 'Por apenas'} ${brl(p.price)}${off ? ` (${desc}% OFF)` : ''}`);
  if (off && !from) lines.push(`💰 Você economiza ${brl(Number(p.original_price) - Number(p.price))}`);
  if (from) lines.push('📦 Tem opções (kits/tamanhos): o preço muda conforme a escolha');
  return lines;
}

async function aiCopy(p, channel, { cfg, fetchImpl }) {
  const dados = {
    produto: p.title,
    marketplace: marketplaceName(p),
    categoria: p.category || null,
    preco: Number(p.price),
    preco_original: p.original_price ? Number(p.original_price) : null,
    avaliacao: p.rating ? Number(p.rating) : null,
    vendas_mil: p.sales_k ? Number(p.sales_k) : null,
    marca: details(p).brand || null,
    caracteristicas: details(p).features?.length ? details(p).features : null,
    frete_gratis: details(p).free_shipping || null,
    entrega_full: details(p).full || null,
    loja_oficial: details(p).official_store || null,
    garantia: details(p).warranty || null,
    posicao_mais_vendidos: details(p).best_seller_rank || null,
  };
  const formato =
    channel === 'whatsapp'
      ? `Mensagem de WhatsApp da Anninha, como uma amiga animada que achou algo incrível: primeira linha em *negrito* e caixa alta com emoji, nome do produto em *negrito*, "De: ~preço original~" riscado (se houver) e "Por: *preço*", cada destaque numa linha com emoji (frete grátis, mais vendido etc., só se os dados disserem), depois a linha "👉 ${p.affiliate_url || PLACEHOLDER}" e um fechamento animado. Use a formatação do WhatsApp (*negrito*, ~riscado~). Sem prazos ou "tempo limitado" inventados; pode dizer que o preço pode mudar.`
      : 'Legenda de Instagram: gancho forte na primeira linha, 3 a 4 benefícios curtos com emojis, chamada para "link na bio", 5 a 8 hashtags e o aviso de que preços podem mudar. No máximo 1800 caracteres.';
  const prompt = `Escreva em português do Brasil. ${formato}\nUse SOMENTE os dados abaixo. Não invente especificações, cupons, prazos nem urgência. Se um dado for null, não o mencione.\nDados: ${JSON.stringify(dados)}\nResponda apenas com o texto final.`;
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Erro HTTP ${res.status}`);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('Resposta vazia da IA');
  return text;
}

/** Gera o texto. Usa IA se pedida e configurada; se falhar, cai no modelo e avisa. */
async function buildCaption(p, channel, { ai, cfg, fetchImpl }) {
  if (ai && cfg.anthropicKey) {
    try {
      return { caption: await aiCopy(p, channel, { cfg, fetchImpl }), source: 'ia' };
    } catch (e) {
      return { caption: templateCopy(p, channel), source: 'modelo', warning: `IA indisponível (${e.message}). Usei o modelo padrão.` };
    }
  }
  const warning = ai && !cfg.anthropicKey ? 'ANTHROPIC_API_KEY não configurada. Usei o modelo padrão.' : undefined;
  return { caption: templateCopy(p, channel), source: 'modelo', warning };
}

const NUMS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** Linha curta de um produto num post com vários: preço, desconto e frete grátis. */
function groupLine(p) {
  const { desc } = scoreProduct(p);
  const d = details(p);
  return `${p.title} ${d.price_max > Number(p.price) ? 'a partir de' : 'por'} ${brl(p.price)}${desc > 0 && p.original_price ? ` (−${desc}%)` : ''}${d.free_shipping ? ' · frete grátis' : ''}`;
}

/** Texto de um post com vários produtos (carrossel no Instagram, lista no WhatsApp). */
function templateGroupCopy(list, channel) {
  if (channel === 'whatsapp') {
    return [
      pick([`🔥 *SEPAREI ${list.length} ACHADINHOS PRA VOCÊ!*`, `😍 *GENTE, OLHA ESSES ${list.length} ACHADOS!*`, `🚨 *${list.length} ACHADINHOS IMPERDÍVEIS NA ÁREA!*`]),
      '',
      ...list.flatMap((p, i) => {
        const { desc } = scoreProduct(p);
        const off = desc > 0 && p.original_price;
        return [
          `${NUMS[i]} *${p.title}*`,
          `💥 ${details(p).price_max > Number(p.price) ? 'a partir de ' : ''}*${brl(p.price)}*${off ? ` ~${brl(p.original_price)}~ (−${desc}%)` : ''}${details(p).free_shipping ? ' · 🚚 frete grátis' : ''}`,
          `👉 ${p.affiliate_url || PLACEHOLDER}`,
          '',
        ];
      }),
      pick(WA_CLOSERS),
    ].join('\n');
  }
  const tags = [...new Set(list.flatMap((p) => hashtags(p).split(' ')))].slice(0, 12).join(' ');
  return [
    `🔥 ${list.length} achados imperdíveis! Arrasta pro lado ➡️`,
    '',
    ...list.map((p, i) => `${NUMS[i]} ${groupLine(p)}`),
    '',
    '👉 Link na bio! Comenta o NÚMERO do produto que eu te mando o link.',
    'Preços e estoque podem mudar.',
    tags,
  ].join('\n');
}

async function aiGroupCopy(list, channel, { cfg, fetchImpl }) {
  const dados = list.map((p, i) => ({
    numero: i + 1, produto: p.title, marketplace: marketplaceName(p), preco: Number(p.price),
    preco_original: p.original_price ? Number(p.original_price) : null, frete_gratis: details(p).free_shipping || null,
    link: channel === 'whatsapp' ? p.affiliate_url || PLACEHOLDER : undefined,
  }));
  const formato = channel === 'whatsapp'
    ? 'Mensagem de WhatsApp listando os produtos numerados (1️⃣, 2️⃣...), cada um com preço e, na linha de baixo, "👉 " seguido do link exato informado. Tom de amigo, emojis moderados.'
    : 'Legenda de Instagram para um carrossel: gancho curto dizendo para arrastar pro lado, lista numerada (1️⃣, 2️⃣...) com nome curto e preço de cada produto, chamada "comenta o número que eu te mando o link", 5 a 8 hashtags e o aviso de que preços podem mudar. No máximo 1800 caracteres.';
  const prompt = `Escreva em português do Brasil. ${formato}\nUse SOMENTE os dados abaixo, na mesma ordem. Não invente especificações, cupons, prazos nem urgência.\nDados: ${JSON.stringify(dados)}\nResponda apenas com o texto final.`;
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Erro HTTP ${res.status}`);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('Resposta vazia da IA');
  return text;
}

/** Texto para vários produtos. Mesmas regras do buildCaption: IA se pedida e configurada, senão modelo. */
async function buildGroupCaption(list, channel, { ai, cfg, fetchImpl }) {
  if (ai && cfg.anthropicKey) {
    try {
      return { caption: await aiGroupCopy(list, channel, { cfg, fetchImpl }), source: 'ia' };
    } catch (e) {
      return { caption: templateGroupCopy(list, channel), source: 'modelo', warning: `IA indisponível (${e.message}). Usei o modelo padrão.` };
    }
  }
  const warning = ai && !cfg.anthropicKey ? 'ANTHROPIC_API_KEY não configurada. Usei o modelo padrão.' : undefined;
  return { caption: templateGroupCopy(list, channel), source: 'modelo', warning };
}

module.exports = { buildCaption, buildGroupCaption, templateCopy, templateGroupCopy, PLACEHOLDER };
