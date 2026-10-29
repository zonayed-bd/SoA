'use strict';

// Provider side of the OrderPlaced contract. Every consumer contract for
// order.placed.v1 in /contracts is checked against the event the Order service
// really builds. Renaming or removing a field a consumer relies on fails this
// test in Order's pipeline, before anything is deployed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const saga = require('../../src/saga');
const { ROUTES } = require('../../src/messages');
const { buildEnvelope } = require('../../src/lib/outbox');

const contractsDir = path.join(__dirname, '../../../../contracts');
const contracts = fs
  .readdirSync(contractsDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(contractsDir, f), 'utf8')))
  .filter((c) => c.provider === 'order-service' && c.contract === ROUTES.orderPlaced.type);

// Build the real outgoing envelope the same way routes.js does (via the outbox).
function realOrderPlacedEnvelope() {
  const order = {
    id: '9a7e4c1d-2b3f-4a5e-8c6d-7e8f9a0b1c2d',
    customerId: 'cust-1002',
    status: saga.STATUS.PENDING,
    currency: 'EUR',
    totalCents: 129900,
    vatCents: 19815,
    paymentToken: 'tok_visa_approved',
    correlationId: 'corr-123',
    createdAt: new Date().toISOString(),
    items: [{ sku: 'SKU-TV55-OLED', quantity: 1, unitPriceCents: 129900 }],
  };
  const message = saga.start(order).find((m) => m.type === ROUTES.orderPlaced.type);
  const envelope = buildEnvelope({ source: 'order-service', subject: order.id, correlationId: order.correlationId, ...message });
  return { routingKey: message.routingKey, envelope };
}

test('there is at least one consumer contract for order.placed.v1', () => {
  assert.ok(contracts.length > 0);
});

for (const contract of contracts) {
  test(`order.placed.v1 satisfies the ${contract.consumer} contract`, () => {
    const ajv = addFormats(new Ajv({ allErrors: true }));
    const validate = ajv.compile(contract.schema);
    const { routingKey, envelope } = realOrderPlacedEnvelope();
    assert.equal(routingKey, contract.routingKey);
    assert.equal(validate(envelope), true, JSON.stringify(validate.errors));
  });
}
