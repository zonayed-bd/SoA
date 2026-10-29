'use strict';

// Applies saga replies from Inventory and Payment. Each reply is handled in one
// local transaction: inbox record + order update + saga log + outgoing messages.
const { withInbox } = require('./lib/inbox');
const { enqueue } = require('./lib/outbox');
const saga = require('./saga');
const orders = require('./orders');

const QUEUE = 'order-service.saga-replies';
const BINDINGS = ['evt.inventory.#', 'evt.payment.#'];

function createReplyHandler({ pool, config }) {
  return async function handleReply(envelope, log) {
    const orderId = envelope.data && envelope.data.orderId;
    const outcome = await withInbox(pool, envelope, 'order-saga', async (client) => {
      const order = await orders.lockOrder(client, orderId);
      if (!order) throw new Error(`reply for unknown order ${orderId}`);

      const step = saga.next(order, envelope.type, envelope.data);
      if (step.ignored) {
        log.warn({ event: 'saga.reply.ignored', order_id: orderId, reason: step.reason }, 'reply ignored');
        return step;
      }
      await orders.updateStatus(client, order.id, step.status, step.reason);
      await orders.logStep(client, order.id, step.step, envelope.data);
      for (const message of step.messages) {
        await enqueue(client, { source: config.service, subject: order.id, correlationId: order.correlationId, ...message });
      }
      log.info(
        { event: 'saga.step', order_id: orderId, step: step.step, status: step.status, reason: step.reason },
        `saga ${step.step}: order ${step.status}`,
      );
      return step;
    });
    if (outcome.duplicate) log.info({ event: 'message.duplicate', order_id: orderId }, 'duplicate reply skipped');
  };
}

module.exports = { QUEUE, BINDINGS, createReplyHandler };
