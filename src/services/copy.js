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
  if (desc > 0 && p.original_price) out.push(`de ${brl(p.original_price)} por ${brl(p.price)} (−${desc}%)`);
  else out.push(`por ${brl(p.price)}`);
  if (d.best_seller_rank && d.best_seller_rank <= 20) out.push(`${d.best_seller_rank}º mais vendido da categoria`);
  if (Number(p.rating)) out.push(`avaliação ★ ${Number(p.rating).toFixed(1)}`);
  if (Number(p.sales_k)) out.push(`mais de ${Math.floor(Number(p.sales_k))} mil vendidos`);
  if (d.free_shipping) out.push(d.full ? 'frete grátis com entrega Full' : 'frete grátis');
  if (d.official_store) out.push('vendido por loja oficial');
  return out;
}

/** Características principais (até 2), curtas, para o Instagram. */
function highlights(p) {
  return (details(p).features || []).slice(0, 2).map((f) => (f.length > 110 ? `${f.slice(0, 107).replace(/\s+\S*$/, '')}…` : f));
}

function templateCopy(p, channel) {
  const f = facts(p);
  if (channel === 'whatsapp') {
    return [
      `🔥 ${p.title} ${f[0]} no ${marketplaceName(p)}.`,
      ...(f.length > 1 ? [f.slice(1).join(' · ') + '. Vale conferir!'] : []),
      `👉 ${p.affiliate_url || PLACEHOLDER}`,
      '(Confere o preço no link, ele pode mudar)',
    ].join('\n');
  }
  return [
    'Achado do dia 👀',
    `${p.title} ${f[0]}.`,
    ...f.slice(1).map((x) => `✅ ${x[0].toUpperCase()}${x.slice(1)}`),
    ...highlights(p).map((x) => `▫️ ${x}`),
    '👉 Link na bio! Comenta EU QUERO que eu te mando.',
    'Preços e estoque podem mudar.',
    hashtags(p),
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
  const formato =
    channel === 'whatsapp'
      ? `Mensagem de WhatsApp com no máximo 5 linhas, tom de amigo indicando um achado, emojis moderados. Termine com a linha "👉 ${p.affiliate_url || PLACEHOLDER}".`
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

module.exports = { buildCaption, templateCopy, PLACEHOLDER };
