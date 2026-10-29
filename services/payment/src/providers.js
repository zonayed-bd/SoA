'use strict';

// Payment provider adapters. Each adapter translates MaltaShop's payment model
// into one provider's API (an anti-corruption layer), so adding a provider means
// adding one adapter, not touching orders or customers.
//
// The two providers here are simulations for the prototype. Like real providers,
// they honour an idempotency key: the same key always returns the same result,
// so a retried authorisation can never charge the customer twice.
const { randomUUID } = require('node:crypto');

function simulatedProvider(name, { outage = () => false, latencyMs = 40 } = {}) {
  const seen = new Map();
  return {
    name,
    async authorise({ idempotencyKey, amountCents, currency, token }) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      if (outage()) throw new Error(`${name} unavailable (HTTP 503)`);
      if (seen.has(idempotencyKey)) return seen.get(idempotencyKey);
      const declined = token.startsWith('tok_declined');
      const result = declined
        ? { outcome: 'DECLINED', provider: name, declineCode: token.replace('tok_declined_', '') || 'do_not_honour' }
        : { outcome: 'APPROVED', provider: name, reference: `${name}_${randomUUID().slice(0, 8)}`, amountCents, currency };
      seen.set(idempotencyKey, result);
      return result;
    },
  };
}

module.exports = { simulatedProvider };
