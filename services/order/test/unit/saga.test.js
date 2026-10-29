'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUS, start, next } = require('../../src/saga');

const order = (status, extra = {}) => ({
  id: '6f1c2a8e-1111-4c3b-9d7e-000000000001',
  customerId: 'cust-1001',
  status,
  currency: 'EUR',
  totalCents: 14997,
  vatCents: 2288,
  paymentToken: 'tok_visa_approved',
  createdAt: '2026-10-30T10:00:00.000Z',
  items: [{ sku: 'SKU-KETTLE-17', quantity: 2, unitPriceCents: 2999 }],
  ...extra,
});

test('start reserves stock first and announces OrderPlaced', () => {
  const messages = start(order(STATUS.PENDING));
  assert.deepEqual(messages.map((m) => m.routingKey), ['cmd.inventory.reserve-stock', 'evt.order.placed']);
  assert.deepEqual(messages[0].data.items, [{ sku: 'SKU-KETTLE-17', quantity: 2 }]);
});

test('stock reserved -> awaiting payment, and payment is requested for the order total', () => {
  const step = next(order(STATUS.PENDING), 'inventory.stock-reserved.v1', {});
  assert.equal(step.status, STATUS.AWAITING_PAYMENT);
  assert.equal(step.messages[0].routingKey, 'cmd.payment.authorise');
  assert.equal(step.messages[0].data.amountCents, 14997);
});

test('stock rejected -> order rejected as OUT_OF_STOCK, nothing to compensate', () => {
  const step = next(order(STATUS.PENDING), 'inventory.stock-rejected.v1', { shortages: [] });
  assert.equal(step.status, STATUS.REJECTED);
  assert.equal(step.reason, 'OUT_OF_STOCK');
  assert.deepEqual(step.messages.map((m) => m.routingKey), ['evt.order.rejected']);
});

test('payment authorised -> order confirmed', () => {
  const step = next(order(STATUS.AWAITING_PAYMENT), 'payment.authorised.v1', {});
  assert.equal(step.status, STATUS.CONFIRMED);
  assert.deepEqual(step.messages.map((m) => m.routingKey), ['evt.order.confirmed']);
});

test('payment failed -> compensate by releasing stock, then reject the order', () => {
  const step = next(order(STATUS.AWAITING_PAYMENT), 'payment.failed.v1', { declineCode: 'insufficient_funds' });
  assert.equal(step.status, STATUS.REJECTED);
  assert.equal(step.reason, 'PAYMENT_DECLINED');
  assert.deepEqual(step.messages.map((m) => m.routingKey), ['cmd.inventory.release-stock', 'evt.order.rejected']);
});

test('duplicate or late replies are ignored, so redelivery cannot corrupt the order', () => {
  assert.equal(next(order(STATUS.CONFIRMED), 'payment.authorised.v1', {}).ignored, true);
  assert.equal(next(order(STATUS.AWAITING_PAYMENT), 'inventory.stock-reserved.v1', {}).ignored, true);
  assert.equal(next(order(STATUS.REJECTED), 'payment.failed.v1', {}).ignored, true);
  assert.equal(next(order(STATUS.PENDING), 'payment.authorised.v1', {}).ignored, true);
});

test('stock released after compensation is logged without changing the final status', () => {
  const step = next(order(STATUS.REJECTED, { reason: 'PAYMENT_DECLINED' }), 'inventory.stock-released.v1', {});
  assert.equal(step.status, STATUS.REJECTED);
  assert.equal(step.step, 'compensation-completed');
  assert.equal(step.messages.length, 0);
});
