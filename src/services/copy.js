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

const { bestCouponFor, couponLine } = require('./coupons');

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

/* ---------- tom Premium: curadoria, qualidade, poucos emojis, preço discreto ---------- */
const PREMIUM_HOOKS = ['Seleção da Anninha ✨', 'Curadoria do dia ✨', 'Vale o investimento ✨', 'Escolhido a dedo ✨'];
const PREMIUM_CLOSERS = ['Qualidade que se sente no uso.', 'Um item para ter por muitos anos.', 'Escolha de quem não abre mão de qualidade.'];

/** Selos de confiança, em texto sóbrio (só o que for verdade). */
function premiumTrust(p) {
  const d = details(p);
  const out = [];
  if (d.official_store || /oficial|official|\bmall\b/i.test(`${p.shop || ''} ${p.notes || ''}`)) out.push('Loja oficial');
  if (d.brand) out.push(`Marca ${d.brand}`);
  if (Number(p.rating) >= 4.5) out.push(`Avaliação ${Number(p.rating).toFixed(1).replace('.', ',')} ★`);
  if (d.warranty) out.push(String(d.warranty).replace(/^Garantia (de )?(f[áa]brica|vendedor):\s*/i, 'Garantia de '));
  if (d.full) out.push('Entrega Full');
  else if (d.free_shipping) out.push('Frete grátis');
  return out.slice(0, 4);
}

/** Preço discreto: "R$ 1.299,00 (antes R$ 1.599,00)", "a partir de R$ X". */
function premiumPrice(p, wa) {
  const { desc } = scoreProduct(p);
  const from = details(p).price_max > Number(p.price);
  const b = (s) => (wa ? `*${s}*` : s);
  const off = desc > 0 && p.original_price ? ` (antes ${brl(p.original_price)})` : '';
  return `${from ? 'A partir de ' : 'Por '}${b(brl(p.price))}${off}`;
}

function premiumCopy(p, channel) {
  const wa = channel === 'whatsapp';
  const feats = highlights(p);
  const trust = premiumTrust(p);
  const lines = [
    wa ? `✨ *${pick(PREMIUM_HOOKS).replace(' ✨', '')}*` : pick(PREMIUM_HOOKS),
    '',
    wa ? `*${p.title}*` : p.title,
  ];
  if (feats.length) lines.push('', ...feats.map((x) => `· ${x}`));
  if (trust.length) lines.push('', trust.join(' · '));
  lines.push('', premiumPrice(p, wa));
  if (p._coupon) lines.push(couponLine(p._coupon, channel));
  if (wa) {
    lines.push('', `👉 ${p.affiliate_url || PLACEHOLDER}`, '', pick(PREMIUM_CLOSERS));
    if (p._site) lines.push('', `Mais seleções na vitrine: ${p._site.url}`);
  } else {
    const cat = TAGS[String(p.category || '').toLowerCase()] || '';
    const tags = [...new Set(`#selecaopremium #curadoria ${cat} #${p.marketplace === 'ML' ? 'mercadolivre' : 'shopee'}`.split(/\s+/).filter(Boolean))].join(' ');
    lines.push('', p._site && p._site.label ? `Na vitrine: ${p._site.label}` : 'Link na bio.', 'Preços e estoque podem mudar.', '', tags);
  }
  return lines.join('\n');
}

function templateCopy(p, channel) {
  if (p._tone === 'premium') return premiumCopy(p, channel);
  if (p._tone === 'masculino') return mascCopy(p, channel);
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
      ...(p._coupon ? [couponLine(p._coupon, 'whatsapp')] : []),
      ...waPerks(p),
      '',
      `👉 ${p.affiliate_url || PLACEHOLDER}`,
      '',
      pick(WA_CLOSERS),
      ...(p._site ? ['', `🛍️ Mais achadinhos: ${p._site.url}`] : []),
    ].join('\n');
  }
  // Instagram: preço em linhas próprias, logo abaixo do nome (o Instagram não tem negrito nem riscado)
  return [
    pick(IG_HOOKS),
    '',
    `✨ ${p.title}`,
    '',
    ...igPrice(p),
    ...(p._coupon ? [couponLine(p._coupon, 'instagram')] : []),
    ...igProof(p),
    '',
    '👉 Comenta EU QUERO que eu te mando o link',
    siteLine(p._site, 'Ou pega na minha vitrine:'),
    '',
    hashtags(p),
  ].join('\n');
}

/** Preço do Instagram numa linha só: "De R$ X por R$ Y (55% OFF)", "Por apenas" ou "A partir de" (variações). */
function igPrice(p) {
  const { desc } = scoreProduct(p);
  const from = details(p).price_max > Number(p.price);
  const off = desc > 0 && p.original_price;
  if (from) return [`🔥 A partir de ${brl(p.price)}${off ? ` (${desc}% OFF)` : ''}`, '📦 Tem opções: o preço muda conforme a escolha'];
  return [off ? `🔥 De ${brl(p.original_price)} por ${brl(p.price)} (${desc}% OFF)` : `🔥 Por apenas ${brl(p.price)}`];
}

/** Prova social do Instagram em até 2 linhas curtas: avaliação e vendas; frete, ranking e loja oficial. */
function igProof(p) {
  const d = details(p);
  const a = [Number(p.rating) ? `${Number(p.rating).toFixed(1).replace('.', ',')}` : '', salesText(p.sales_k)].filter(Boolean);
  const b = [d.free_shipping ? (d.full ? 'Frete grátis Full' : 'Frete grátis') : '', d.best_seller_rank && d.best_seller_rank <= 20 ? `${d.best_seller_rank}º mais vendido` : '', d.official_store ? 'Loja oficial' : ''].filter(Boolean);
  const out = [];
  if (a.length) out.push(`⭐ ${a.join(' · ')}`);
  if (b.length) out.push(`✅ ${b.join(' · ')}`);
  return out;
}

/** Chamada para a vitrine no Instagram: com domínio próprio mostra o endereço; sem ele, "link da bio". */
function siteLine(site, lead, icon = '🛍️') {
  return site && site.label ? `${icon} ${lead} ${site.label}` : `${icon} Ou pega no link da bio`;
}

/* ---------- tom masculino: direto, sem corações, foco em custo-benefício ---------- */
const M_IG_HOOKS = ['Achado do dia 🔥', 'Vale cada centavo 💪', 'Olha esse achado 👀', 'Esse aqui compensa 💯', 'Upgrade garantido ⚙️'];
const M_WA_HOOKS = ['🔥 *ACHADO DO DIA!*', '💪 *VALE CADA CENTAVO!*', '👀 *OLHA ESSE ACHADO!*', '⚙️ *UPGRADE GARANTIDO!*'];
const M_WA_HOOKS_DISCOUNT = ['💥 *PREÇO DERRUBADO!*', '🚨 *DESCONTO PESADO!*', '📉 *CAIU O PREÇO!*'];
const M_WA_CLOSERS = ['⏰ Preço pode mudar a qualquer momento. Garante o seu! 👊', '🏃 Preço bom assim não dura. Aproveita! 👊', '💬 Pegou? Depois me conta o que achou! 👊'];

function mascTags(p) {
  const base = TAGS[String(p.category || '').toLowerCase()] || '';
  const all = `${base} #achados #achadosmasculinos ${p.marketplace === 'ML' ? '#mercadolivre' : '#shopee'} #ofertas`.split(/\s+/).filter(Boolean);
  return [...new Set(all)].join(' ');
}

function mascCopy(p, channel) {
  if (channel === 'whatsapp') {
    const { desc } = scoreProduct(p);
    const off = desc > 0 && p.original_price;
    const from = details(p).price_max > Number(p.price);
    return [
      off && desc >= 30 ? pick(M_WA_HOOKS_DISCOUNT) : pick(M_WA_HOOKS),
      '',
      `📦 *${p.title}*`,
      '',
      ...(off ? [`💸 De: ~${brl(p.original_price)}~`, `💥 ${from ? 'A partir de' : 'Por'}: *${brl(p.price)}* (−${desc}% OFF)`] : [`💥 ${from ? 'A partir de' : 'Por apenas'}: *${brl(p.price)}*`]),
      ...(from ? ['📦 Tem opções: o preço muda conforme a escolha'] : []),
      ...(p._coupon ? [couponLine(p._coupon, 'whatsapp')] : []),
      ...waPerks(p),
      '',
      `👉 ${p.affiliate_url || PLACEHOLDER}`,
      '',
      pick(M_WA_CLOSERS),
      ...(p._site ? ['', `🛒 Mais achados: ${p._site.url}`] : []),
    ].join('\n');
  }
  return [
    pick(M_IG_HOOKS),
    '',
    `📦 ${p.title}`,
    '',
    ...igPrice(p),
    ...(p._coupon ? [couponLine(p._coupon, 'instagram')] : []),
    ...igProof(p),
    '',
    '👉 Comenta EU QUERO que eu mando o link',
    siteLine(p._site, 'Ou pega na vitrine:', '🛒'),
    '',
    mascTags(p),
  ].join('\n');
}

function mascGroupCopy(list, channel) {
  const site = list[0] && list[0]._site;
  if (channel === 'whatsapp') {
    return [
      pick([`🔥 *${list.length} ACHADOS QUE VALEM A PENA!*`, `💪 *SEPAREI ${list.length} ACHADOS PRA VOCÊ!*`]),
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
      pick(M_WA_CLOSERS),
      ...(site ? ['', `🛒 Mais achados: ${site.url}`] : []),
    ].join('\n');
  }
  const tags = [...new Set(list.flatMap((p) => mascTags(p).split(' ')))].slice(0, 12).join(' ');
  return [
    `🔥 ${list.length} achados que valem a pena. Arrasta pro lado ➡️`,
    '',
    ...list.map((p, i) => `${NUMS[i]} ${groupLine(p)}`),
    '',
    '👉 Comenta o NÚMERO do produto que eu mando o link',
    siteLine(site, 'Todos na vitrine:', '🛒'),
    '',
    tags,
  ].join('\n');
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
  const formato = p._tone === 'premium'
    ? `Texto ${channel === 'whatsapp' ? 'de WhatsApp (use *negrito* do WhatsApp no nome e no preço)' : 'de legenda do Instagram'} em tom de curadoria premium, elegante e sóbrio: primeira linha "Seleção da Anninha ✨", nome do produto, 2 ou 3 linhas sobre qualidade, material, uso e durabilidade (só com base nos dados), selos de confiança em uma linha (loja oficial, marca, garantia, avaliação, se houver), o preço de forma discreta${channel === 'whatsapp' ? `, a linha "👉 ${p.affiliate_url || PLACEHOLDER}"` : ', "Link na bio." e 3 a 5 hashtags'}. No máximo 2 emojis. Nada de caixa alta, exclamações em excesso, "baratinho", "corre" ou urgência.`
    : channel === 'whatsapp'
      ? `Mensagem de WhatsApp da Anninha, como uma amiga animada que achou algo incrível: primeira linha em *negrito* e caixa alta com emoji, nome do produto em *negrito*, "De: ~preço original~" riscado (se houver) e "Por: *preço*", cada destaque numa linha com emoji (frete grátis, mais vendido etc., só se os dados disserem), depois a linha "👉 ${p.affiliate_url || PLACEHOLDER}" e um fechamento animado. Use a formatação do WhatsApp (*negrito*, ~riscado~). Sem prazos ou "tempo limitado" inventados; pode dizer que o preço pode mudar.`
      : 'Legenda de Instagram: gancho forte na primeira linha, 3 a 4 benefícios curtos com emojis, chamada para "link na bio", 5 a 8 hashtags e o aviso de que preços podem mudar. No máximo 1800 caracteres.';
  const voz = p._tone === 'masculino' ? ' Tom masculino, direto, sem corações nem diminutivos.' : '';
  const prompt = `Escreva em português do Brasil.${voz} ${formato}\nUse SOMENTE os dados abaixo. Não invente especificações, cupons, prazos nem urgência. Se um dado for null, não o mencione.\nDados: ${JSON.stringify(dados)}\nResponda apenas com o texto final.`;
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
async function buildCaption(p0, channel, opts) {
  const out = await buildCaptionRaw(opts.site ? { ...p0, _site: opts.site } : p0, channel, opts);
  const text = out.source === 'ia' ? withSite(out.caption, opts.site, channel) : out.caption;
  return { ...out, caption: withFollow(text, opts.follow, channel, opts.tone === 'masculino') };
}

async function buildCaptionRaw(p00, channel, { ai, cfg, fetchImpl, coupons, tone }) {
  const p0 = tone === 'premium' || tone === 'masculino' ? { ...p00, _tone: tone } : p00;
  // cupom cadastrado que combina com o produto (mesma loja, compra mínima atendida) entra no texto
  const coupon = coupons && coupons.length ? bestCouponFor(p0, coupons) : null;
  const p = coupon ? { ...p0, _coupon: coupon } : p0;
  if (ai && cfg.anthropicKey) {
    try {
      const text = await aiCopy(p, channel, { cfg, fetchImpl });
      return { caption: coupon ? `${text}

${couponLine(coupon, channel)}` : text, source: 'ia' };
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
  if (list[0] && list[0]._tone === 'masculino') return mascGroupCopy(list, channel);
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
      ...(list[0] && list[0]._site ? ['', `🛍️ Mais achadinhos: ${list[0]._site.url}`] : []),
    ].join('\n');
  }
  const tags = [...new Set(list.flatMap((p) => hashtags(p).split(' ')))].slice(0, 12).join(' ');
  return [
    `🔥 ${list.length} achados imperdíveis! Arrasta pro lado ➡️`,
    '',
    ...list.map((p, i) => `${NUMS[i]} ${groupLine(p)}`),
    '',
    '👉 Comenta o NÚMERO do produto que eu te mando o link',
    siteLine(list[0] && list[0]._site, 'Todos na minha vitrine:'),
    '',
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
  const voz = list[0] && list[0]._tone === 'masculino' ? ' Tom masculino, direto, sem corações nem diminutivos.' : '';
  const prompt = `Escreva em português do Brasil.${voz} ${formato}\nUse SOMENTE os dados abaixo, na mesma ordem. Não invente especificações, cupons, prazos nem urgência.\nDados: ${JSON.stringify(dados)}\nResponda apenas com o texto final.`;
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
async function buildGroupCaption(list0, channel, opts) {
  const list = list0.map((p) => ({ ...p, ...(opts.site ? { _site: opts.site } : {}), ...(opts.tone === 'masculino' ? { _tone: 'masculino' } : {}) }));
  const out = await buildGroupCaptionRaw(list, channel, opts);
  const text = out.source === 'ia' ? withSite(out.caption, opts.site, channel) : out.caption;
  return { ...out, caption: withFollow(text, opts.follow, channel, opts.tone === 'masculino') };
}

async function buildGroupCaptionRaw(list, channel, { ai, cfg, fetchImpl }) {
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

/* ---------- tom da conta ---------- */

/** Tom do texto: o pedido pela tela (premium, masculino, feminino) ou, sem pedido, o tom da conta. */
async function resolveTone(pool, uid, requested) {
  if (requested === 'premium' || requested === 'masculino') return requested;
  if (requested === 'anninha' || requested === 'feminino') return undefined;
  const u = (await pool.query('select voice from users where id = $1', [uid])).rows[0];
  return u && u.voice === 'masculino' ? 'masculino' : undefined;
}

/* ---------- vitrine (mini site) ---------- */

/** Vitrine publicada do usuário: { label: domínio próprio ou null, url }. Null se não houver. */
async function vitrineSite(pool, uid, cfg) {
  const r = (await pool.query('select slug, domain, published from storefronts where user_id = $1', [uid])).rows[0];
  if (!r || !r.published) return null;
  return { label: r.domain || null, url: r.domain ? `https://${r.domain}` : `${cfg.appUrl}/v/${r.slug}` };
}

/** Texto da IA: acrescenta a vitrine no fim (no Instagram só com domínio próprio, que dá para ler e digitar). */
function withSite(text, site, channel) {
  if (!site || !text) return text;
  if (channel === 'instagram' && !site.label) return text;
  if (String(text).includes(site.label || site.url)) return text;
  const line = channel === 'instagram' ? `🛍️ Mais achadinhos na minha vitrine: ${site.label}` : `🛍️ Mais achadinhos: ${site.url}`;
  const lines = String(text).replace(/\s+$/, '').split('\n');
  if (channel === 'instagram' && /^#/.test(lines[lines.length - 1] || '')) {
    const tags = lines.pop();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return [...lines, '', line, '', tags].join('\n');
  }
  return [...lines, '', line].join('\n');
}

/* ---------- convite para seguir o perfil ---------- */

/** @ do perfil para o convite: o da marca (capas), senão o do Instagram conectado. */
async function followHandle(pool, uid) {
  const { rows } = await pool.query(
    'select u.brand_handle, c.ig_username from users u left join connections c on c.user_id = u.id where u.id = $1', [uid]);
  const h = rows[0] && (rows[0].brand_handle || rows[0].ig_username);
  return h ? String(h).replace(/^@+/, '') : null;
}

/** Linha do convite: no Instagram o @ (link na legenda não é clicável); no WhatsApp/Telegram o link do perfil. */
function followLine(handle, channel, masc) {
  if (channel === 'instagram') return masc ? `👊 Segue @${handle} pra não perder nenhum achado!` : `💖 Segue @${handle} pra não perder nenhum achadinho!`;
  return `📲 Segue a gente no Instagram: https://www.instagram.com/${handle}/`;
}

/** Põe o convite no fim do texto (no Instagram, antes das hashtags). Não repete se já houver. */
function withFollow(text, handle, channel, masc) {
  if (!handle || !text || String(text).toLowerCase().includes(String(handle).toLowerCase())) return text;
  const line = followLine(handle, channel, masc);
  const lines = String(text).replace(/\s+$/, '').split('\n');
  if (channel === 'instagram' && /^#/.test(lines[lines.length - 1] || '')) {
    const tags = lines.pop();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return [...lines, '', line, '', tags].join('\n');
  }
  return [...lines, '', line].join('\n');
}

module.exports = { buildCaption, buildGroupCaption, templateCopy, templateGroupCopy, followHandle, withFollow, vitrineSite, withSite, resolveTone, PLACEHOLDER };
