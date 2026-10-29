'use strict';

// Prices are VAT-inclusive (EU consumer pricing). Malta's standard VAT rate is 18%,
// so the VAT inside a gross amount is gross * 18 / 118. All money is in integer cents.
const VAT_RATE_PERCENT = 18;

function priceOrder(items, priceList) {
  const lines = items.map(({ sku, quantity }) => {
    const product = priceList.get(sku);
    if (!product) {
      const err = new Error(`Unknown product ${sku}`);
      err.statusCode = 422;
      err.code = 'UNKNOWN_SKU';
      throw err;
    }
    return { sku, quantity, unitPriceCents: product.unitPriceCents };
  });
  const totalCents = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
  const vatCents = Math.round((totalCents * VAT_RATE_PERCENT) / (100 + VAT_RATE_PERCENT));
  return { lines, totalCents, vatCents };
}

module.exports = { priceOrder, VAT_RATE_PERCENT };
