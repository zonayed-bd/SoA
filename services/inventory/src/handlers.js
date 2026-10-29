'use strict';

const { withInbox } = require('./lib/inbox');
const { enqueue } = require('./lib/outbox');
const { NonRetryableError } = require('./lib/broker');
const stock = require('./stock');

const QUEUE = 'inventory-service.inbox';
const BINDINGS = ['cmd.inventory.#', 'evt.order.confirmed'];

const REPLIES = {
  reserved: { routingKey: 'evt.inventory.stock-reserved', type: 'inventory.stock-reserved.v1' },
  rejected: { routingKey: 'evt.inventory.stock-rejected', type: 'inventory.stock-rejected.v1' },
  released: { routingKey: 'evt.inventory.stock-released', type: 'inventory.stock-released.v1' },
};

function createHandler({ pool, config }) {
  const reply = (client, envelope, route, data) =>
    enqueue(client, {
      source: config.service,
      subject: envelope.subject,
      correlationId: envelope.correlationid,
      ...route,
      data,
    });

  return async function handle(envelope, log) {
    const { orderId } = envelope.data || {};
    const result = await withInbox(pool, envelope, 'inventory', async (client) => {
      switch (envelope.type) {
        case 'inventory.reserve-stock.v1': {
          const r = await stock.reserve(client, orderId, envelope.data.items);
          await reply(client, envelope, REPLIES[r.outcome], { orderId, shortages: r.shortages });
          log.info({ event: `stock.${r.outcome}`, order_id: orderId, shortages: r.shortages }, `stock ${r.outcome}`);
          return r;
        }
        case 'inventory.release-stock.v1': {
          const r = await stock.release(client, orderId);
          if (r.released) await reply(client, envelope, REPLIES.released, { orderId });
          log.info({ event: 'stock.released', order_id: orderId, released: r.released }, 'compensation: stock released');
          return r;
        }
        case 'order.confirmed.v1': {
          const r = await stock.commit(client, orderId);
          log.info({ event: 'stock.committed', order_id: orderId, committed: r.committed }, 'reservation committed');
          return r;
        }
        default:
          throw new NonRetryableError(`unsupported message type ${envelope.type}`);
      }
    });
    if (result.duplicate) log.info({ event: 'message.duplicate', order_id: orderId }, 'duplicate message skipped');
  };
}

module.exports = { QUEUE, BINDINGS, createHandler };
