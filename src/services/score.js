const clamp = (x) => Math.max(0, Math.min(1, x));

/**
 * Nota de prioridade (0-100): 30% desconto, 30% comissão, 20% avaliação, 20% volume de vendas.
 * Campos ausentes contribuem com zero.
 */
function scoreProduct(p) {
  const price = Number(p.price) || 0;
  const orig = Number(p.original_price) || 0;
  const desc = orig > price && orig > 0 ? Math.round((1 - price / orig) * 100) : 0;
  const com = Number(p.commission_pct) || 0;
  const rating = Number(p.rating) || 0;
  const sales = Number(p.sales_k) || 0;
  const s =
    0.3 * clamp(desc / 60) +
    0.3 * clamp(com / 16) +
    0.2 * clamp((rating - 4) / 1) +
    0.2 * clamp(sales / 20);
  return { desc, earn_per_sale: Math.round(price * com) / 100, score: Math.round(100 * s) };
}

module.exports = { scoreProduct };
