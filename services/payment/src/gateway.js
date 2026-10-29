'use strict';

// Resilient access to the payment providers: a timeout and a circuit breaker
// around the primary provider, with failover to the secondary provider as the
// fallback. When the primary keeps failing the breaker opens and calls go
// straight to the secondary, so a provider outage does not stop checkout.
const CircuitBreaker = require('opossum');

function createPaymentGateway({ primary, secondary, timeoutMs, log }) {
  const breaker = new CircuitBreaker((request) => primary.authorise(request), {
    name: `psp-${primary.name}`,
    timeout: timeoutMs,
    errorThresholdPercentage: 50,
    volumeThreshold: 3,
    resetTimeout: 30_000,
  });
  breaker.fallback((request) => {
    log.warn({ event: 'psp.failover', from: primary.name, to: secondary.name }, 'primary provider unavailable, using secondary');
    return secondary.authorise(request);
  });
  breaker.on('open', () => log.warn({ event: 'psp.circuit.open', provider: primary.name }, 'circuit opened'));
  breaker.on('halfOpen', () => log.info({ event: 'psp.circuit.half_open', provider: primary.name }, 'circuit half-open, probing'));
  breaker.on('close', () => log.info({ event: 'psp.circuit.closed', provider: primary.name }, 'circuit closed'));

  return {
    authorise: (request) => breaker.fire(request),
    state: () => (breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed'),
  };
}

module.exports = { createPaymentGateway };
