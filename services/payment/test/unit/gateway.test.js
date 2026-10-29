'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simulatedProvider } = require('../../src/providers');
const { createPaymentGateway } = require('../../src/gateway');

const silentLog = { info() {}, warn() {}, error() {} };
const request = (key, token = 'tok_visa_approved') => ({ idempotencyKey: key, amountCents: 14997, currency: 'EUR', token });

test('the same idempotency key never produces a second charge', async () => {
  const provider = simulatedProvider('acmepay', { latencyMs: 0 });
  const first = await provider.authorise(request('order-1'));
  const retry = await provider.authorise(request('order-1'));
  assert.equal(first.outcome, 'APPROVED');
  assert.deepEqual(retry, first);
});

test('declined tokens are declined with the provider reason', async () => {
  const provider = simulatedProvider('acmepay', { latencyMs: 0 });
  const result = await provider.authorise(request('order-2', 'tok_declined_insufficient_funds'));
  assert.equal(result.outcome, 'DECLINED');
  assert.equal(result.declineCode, 'insufficient_funds');
});

test('when the primary provider is down, payments fail over and the breaker opens', async () => {
  const gateway = createPaymentGateway({
    primary: simulatedProvider('acmepay', { outage: () => true, latencyMs: 0 }),
    secondary: simulatedProvider('betapay', { latencyMs: 0 }),
    timeoutMs: 500,
    log: silentLog,
  });
  for (let i = 0; i < 4; i++) {
    const result = await gateway.authorise(request(`order-fo-${i}`));
    assert.equal(result.provider, 'betapay');
  }
  assert.equal(gateway.state(), 'open');
});
