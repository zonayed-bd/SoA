'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { enqueue } = require('./lib/outbox');
const { priceOrder } = require('./pricing');
const saga = require('./saga');
const orders = require('./orders');

const createOrderSchema = {
  headers: {
    type: 'object',
    required: ['idempotency-key'],
    properties: { 'idempotency-key': { type: 'string', minLength: 8, maxLength: 128 } },
  },
  body: {
    type: 'object',
    required: ['customerId', 'items', 'paymentToken'],
    additionalProperties: false,
    properties: {
      customerId: { type: 'string', minLength: 1, maxLength: 64 },
      paymentToken: { type: 'string', minLength: 4, maxLength: 128 },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          required: ['sku', 'quantity'],
          additionalProperties: false,
          properties: {
            sku: { type: 'string', minLength: 1, maxLength: 64 },
            quantity: { type: 'integer', minimum: 1, maximum: 20 },
          },
        },
      },
    },
  },
};

function requestHash(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function accepted(reply, view, replayed) {
  return reply
    .code(202)
    .header('location', view.links.self)
    .header('idempotent-replayed', String(replayed))
    .send(view);
}

function registerRoutes(app, { pool, config }) {
  // POST /v1/orders: accept the order and start the saga. Returns 202 Accepted
  // because confirmation happens asynchronously; the client polls the order.
  app.post('/v1/orders', { schema: createOrderSchema }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    const hash = requestHash(request.body);
    const client = await pool.connect();
    let orderId;
    try {
      await client.query('BEGIN');

      // Idempotency: a retried request with the same key returns the original order.
      const existing = await orders.findByIdempotencyKey(client, key);
      if (existing) {
        await client.query('ROLLBACK');
        if (existing.request_hash !== hash) return conflict(reply, request);
        request.log.info({ event: 'order.request.replayed', order_id: existing.id }, 'idempotent replay');
        return accepted(reply, await orders.getOrderView(pool, existing.id), true);
      }

      const skus = request.body.items.map((i) => i.sku);
      const priced = priceOrder(request.body.items, await orders.loadPriceList(client, skus));
      const order = {
        id: randomUUID(),
        customerId: request.body.customerId,
        status: saga.STATUS.PENDING,
        currency: 'EUR',
        items: priced.lines,
        totalCents: priced.totalCents,
        vatCents: priced.vatCents,
        paymentToken: request.body.paymentToken,
        idempotencyKey: key,
        requestHash: hash,
        correlationId: request.id,
        createdAt: new Date().toISOString(),
      };

      // One local ACID transaction: the order row, the saga log entry and the
      // outgoing messages commit together, or not at all.
      await orders.insertOrder(client, order);
      await orders.logStep(client, order.id, 'order-placed');
      for (const message of saga.start(order)) {
        await enqueue(client, {
          source: config.service,
          subject: order.id,
          correlationId: order.correlationId,
          ...message,
        });
      }
      await client.query('COMMIT');
      orderId = order.id;
      request.log.info(
        { event: 'order.placed', order_id: order.id, total_cents: order.totalCents, item_count: order.items.length },
        'order accepted, saga started',
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Two identical requests raced: the unique key let only one in.
      if (err.code === '23505') {
        const winner = await orders.findByIdempotencyKey(pool, key);
        if (winner && winner.request_hash === hash) return accepted(reply, await orders.getOrderView(pool, winner.id), true);
        return conflict(reply, request);
      }
      throw err;
    } finally {
      client.release();
    }
    return accepted(reply, await orders.getOrderView(pool, orderId), false);
  });

  app.get('/v1/orders/:orderId', async (request, reply) => {
    const { orderId } = request.params;
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return notFound(reply, request);
    const view = await orders.getOrderView(pool, orderId);
    if (!view) return notFound(reply, request);
    return view;
  });
}

function conflict(reply, request) {
  return reply.code(409).send({
    status: 409,
    code: 'IDEMPOTENCY_KEY_REUSED',
    message: 'This Idempotency-Key was already used with a different request body.',
    correlationId: request.id,
  });
}

function notFound(reply, request) {
  return reply.code(404).send({ status: 404, code: 'ORDER_NOT_FOUND', message: 'No order with that id.', correlationId: request.id });
}

module.exports = { registerRoutes };
