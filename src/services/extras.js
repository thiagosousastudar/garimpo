/**
 * Detalhes extras do produto vindos da loja: galeria de fotos, características principais e selos
 * (frete grátis, entrega Full, loja oficial, garantia, número de vendedores, marca, posição nos mais vendidos).
 * Ficam em products.extras como JSON, sempre passando por clean() para não gravar nada fora do formato.
 */
const httpsUrl = (u) => {
  try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.toString() : null; } catch (_) { return null; }
};
const text = (v, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

function clean(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {
    images: (Array.isArray(e.images) ? e.images : []).map(httpsUrl).filter(Boolean).slice(0, 12),
    features: (Array.isArray(e.features) ? e.features : []).map((f) => text(f, 220)).filter(Boolean).slice(0, 6),
    free_shipping: e.free_shipping === true,
    full: e.full === true,
    official_store: e.official_store === true,
    warranty: text(e.warranty, 100),
    sellers: int(e.sellers),
    brand: text(e.brand, 80),
    best_seller_rank: int(e.best_seller_rank),
    // categoria principal na loja (para aplicar a comissão da tabela) e se a comissão foi preenchida pelo app
    category_id: /^MLB\d+$/.test(String(e.category_id || '')) ? String(e.category_id) : null,
    commission_auto: e.commission_auto === true,
  };
  const empty = !out.images.length && !out.features.length && !out.free_shipping && !out.full && !out.official_store
    && !out.warranty && !out.sellers && !out.brand && !out.best_seller_rank && !out.category_id && !out.commission_auto;
  return empty ? null : out;
}

/** Lê o JSON gravado (texto) e devolve o objeto, ou {} se não houver. */
function parse(raw) {
  if (!raw) return {};
  try { return clean(typeof raw === 'string' ? JSON.parse(raw) : raw) || {}; } catch (_) { return {}; }
}

/** Junta detalhes novos com os já gravados (o que a loja não mandou agora é mantido). */
function merge(oldRaw, fresh) {
  const a = parse(oldRaw);
  const b = clean(fresh) || {};
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v) ? v.length : v !== null && v !== undefined) out[k] = v;
  }
  // selos booleanos refletem a oferta atual (frete grátis pode acabar)
  if (fresh && typeof fresh === 'object') for (const k of ['free_shipping', 'full', 'official_store', 'commission_auto']) if (k in fresh) out[k] = fresh[k] === true;
  const c = clean(out);
  return c ? JSON.stringify(c) : null;
}

const serialize = (e) => { const c = clean(e); return c ? JSON.stringify(c) : null; };

module.exports = { cleanExtras: clean, parseExtras: parse, mergeExtras: merge, serializeExtras: serialize };
