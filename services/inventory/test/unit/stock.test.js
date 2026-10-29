'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findShortages } = require('../../src/stock');

test('no shortages when every line is covered', () => {
  const stock = new Map([['SKU-KETTLE-17', 100]]);
  assert.deepEqual(findShortages([{ sku: 'SKU-KETTLE-17', quantity: 2 }], stock), []);
});

test('reports each line that cannot be covered, including unknown skus', () => {
  const stock = new Map([
    ['SKU-LAPTOP-14', 0],
    ['SKU-TV55-OLED', 1],
  ]);
  const shortages = findShortages(
    [
      { sku: 'SKU-LAPTOP-14', quantity: 1 },
      { sku: 'SKU-TV55-OLED', quantity: 1 },
      { sku: 'SKU-UNKNOWN', quantity: 3 },
    ],
    stock,
  );
  assert.deepEqual(shortages, [
    { sku: 'SKU-LAPTOP-14', requested: 1, available: 0 },
    { sku: 'SKU-UNKNOWN', requested: 3, available: 0 },
  ]);
});
