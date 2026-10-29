'use strict';

// Authorises a payment for an order. Calling an external provider cannot be part
// of our database transaction, so the work is split into three idempotent steps:
//   1. record the intent (PENDING) – a crash after this is recoverable
//   2. call the provider with idempotency key "order-<id>" – safe to repeat
//   3. in one transaction: mark the command processed, store the outcome and
//      queue the reply event in the outbox
// If the process dies between steps, the unacked command is redelivered and
// the same steps run again without charging twice.
const { withInbox, alreadyProcessed } = require('./lib/inbox');
const { enqueue } = require('./lib/outbox');
const { NonRetryableError } = require('./lib/broker');

const QUEUE = 'payment-service.commands';
const BINDINGS = ['cmd.payment.#'];
const REPLIES = {
  APPROVED: { routingKey: 'evt.payment.authorised', type: 'payment.authorised.v1' },
  DECLINED: { routingKey: 'evt.payment.failed', type: 'payment.failed.v1' },
};

function createHandler({ pool, gateway, config }) {
  return async function handle(envelope, log) {
    if (envelope.type !== 'payment.authorise.v1') throw new NonRetryableError(`unsupported message type ${envelope.type}`);
    const { orderId, amountCents, currency, paymentToken } = envelope.data;

    if (await alreadyProcessed(pool, envelope.id, 'payment')) {
      log.info({ event: 'message.duplicate', order_id: orderId }, 'duplicate command skipped');
      return;
    }

    // Step 1: record intent.
    await pool.query(
      `INSERT INTO payments (order_id, status, amount_cents, currency) VALUES ($1, 'PENDING', $2, $3)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, amountCents, currency],
    );
    const { rows } = await pool.query('SELECT status, provider, provider_ref, decline_code FROM payments WHERE order_id = $1', [orderId]);
    let result;
    if (rows[0].status === 'PENDING') {
      // Step 2: provider call (timeout + circuit breaker + failover).
      result = await gateway.authorise({ idempotencyKey: `order-${orderId}`, amountCents, currency, token: paymentToken });
    } else {
      // Already decided by an earlier command: re-send the same answer.
      result = {
        outcome: rows[0].status === 'AUTHORISED' ? 'APPROVED' : 'DECLINED',
        provider: rows[0].provider,
        reference: rows[0].provider_ref,
        declineCode: rows[0].decline_code,
      };
    }

    // Step 3: store outcome and reply atomically.
    await withInbox(pool, envelope, 'payment', async (client) => {
      await client.query(
        `UPDATE payments SET status = $2, provider = $3, provider_ref = $4, decline_code = $5, updated_at = now()
          WHERE order_id = $1 AND status = 'PENDING'`,
        [orderId, result.outcome === 'APPROVED' ? 'AUTHORISED' : 'DECLINED', result.provider, result.reference || null, result.declineCode || null],
      );
      await enqueue(client, {
        source: config.service,
        subject: orderId,
        correlationId: envelope.correlationid,
        ...REPLIES[result.outcome],
        data: { orderId, provider: result.provider, reference: result.reference, declineCode: result.declineCode },
      });
    });
    log.info(
      { event: result.outcome === 'APPROVED' ? 'payment.authorised' : 'payment.declined', order_id: orderId, provider: result.provider, amount_cents: amountCents },
      `payment ${result.outcome.toLowerCase()} by ${result.provider}`,
    );
  };
}

module.exports = { QUEUE, BINDINGS, createHandler };
