'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { priceOrder } = require('../../src/pricing');

const priceList = new Map([
  ['SKU-KETTLE-17', { unitPriceCents: 2999 }],
  ['SKU-AIRFRYER-5L', { unitPriceCents: 8999 }],
]);

test('totals are summed in cents and include 18% Maltese VAT', () => {
  const priced = priceOrder(
    [
      { sku: 'SKU-KETTLE-17', quantity: 2 },
      { sku: 'SKU-AIRFRYER-5L', quantity: 1 },
    ],
    priceList,
  );
  // 2 x 29.99 + 89.99 = 149.97 gross; VAT = 149.97 x 18/118 = 22.876... -> 22.88
  assert.equal(priced.totalCents, 14997);
  assert.equal(priced.vatCents, 2288);
});

test('unknown products are rejected with 422 UNKNOWN_SKU', () => {
  assert.throws(() => priceOrder([{ sku: 'SKU-NOPE', quantity: 1 }], priceList), (err) => {
    assert.equal(err.statusCode, 422);
    assert.equal(err.code, 'UNKNOWN_SKU');
    return true;
  });
});
