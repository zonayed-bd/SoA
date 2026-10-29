'use strict';

// Thin wrapper around RabbitMQ (amqplib). The broker is a "dumb pipe": one topic
// exchange for all commands and events, and every service declares its own queue.
//   - publisher confirms: a message counts as sent only when the broker has stored it
//   - quorum queues with a delivery limit: a poison message is retried 5 times and
//     then dead-lettered instead of blocking the queue
//   - manual acknowledgements: a message is removed only after the handler's
//     database transaction has committed (at-least-once delivery)
const amqp = require('amqplib');

const EXCHANGE = 'maltashop.events';
const DEAD_LETTER_EXCHANGE = 'maltashop.dlx';
const DELIVERY_LIMIT = 5;

class NonRetryableError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectWithRetry(url, log, attempts = 30) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      if (attempt >= attempts) throw err;
      log.warn({ event: 'broker.connect.retry', attempt, err: err.message }, 'broker not reachable yet, retrying');
      await sleep(Math.min(500 * attempt, 5000));
    }
  }
}

async function createBroker({ url, log }) {
  const connection = await connectWithRetry(url, log);
  const publishChannel = await connection.createConfirmChannel();
  const consumeChannel = await connection.createChannel();
  await publishChannel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await publishChannel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });

  const state = { open: true, closing: false, consumerTags: [] };

  // Crash-only design: if the broker connection drops, exit and let the platform
  // (Docker restart policy / Kubernetes) start a fresh copy. Unacked messages are
  // redelivered, which is safe because every consumer is idempotent.
  connection.on('close', () => {
    state.open = false;
    if (!state.closing) {
      log.error({ event: 'broker.connection.lost' }, 'broker connection lost, exiting so the platform restarts us');
      process.exit(1);
    }
  });
  connection.on('error', (err) => log.error({ event: 'broker.connection.error', err: err.message }, 'broker error'));

  async function declareQueue(queue, bindingKeys) {
    const dlq = `${queue}.dlq`;
    await consumeChannel.assertQueue(dlq, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await consumeChannel.bindQueue(dlq, DEAD_LETTER_EXCHANGE, queue);
    await consumeChannel.assertQueue(queue, {
      durable: true,
      arguments: {
        'x-queue-type': 'quorum',
        'x-delivery-limit': DELIVERY_LIMIT,
        'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
        'x-dead-letter-routing-key': queue,
      },
    });
    for (const key of bindingKeys) await consumeChannel.bindQueue(queue, EXCHANGE, key);
  }

  function publish(routingKey, envelope) {
    return new Promise((resolve, reject) => {
      publishChannel.publish(
        EXCHANGE,
        routingKey,
        Buffer.from(JSON.stringify(envelope)),
        {
          persistent: true,
          contentType: 'application/json',
          messageId: envelope.id,
          correlationId: envelope.correlationid,
          type: envelope.type,
          timestamp: Math.floor(Date.now() / 1000),
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  // handler(envelope, log) must be idempotent; it is acked only after it resolves.
  async function consume(queue, handler, { prefetch = 10 } = {}) {
    await consumeChannel.prefetch(prefetch);
    const { consumerTag } = await consumeChannel.consume(queue, async (msg) => {
      if (!msg) return;
      let envelope;
      try {
        envelope = JSON.parse(msg.content.toString());
      } catch {
        log.error({ event: 'message.unparseable', queue }, 'unparseable message sent to dead-letter queue');
        consumeChannel.nack(msg, false, false);
        return;
      }
      const mlog = log.child({
        correlation_id: envelope.correlationid,
        message_id: envelope.id,
        message_type: envelope.type,
      });
      const deliveryCount = msg.properties.headers?.['x-delivery-count'] ?? 0;
      try {
        await handler(envelope, mlog);
        consumeChannel.ack(msg);
      } catch (err) {
        const retry = !(err instanceof NonRetryableError);
        mlog.error(
          { event: 'message.failed', queue, retry, delivery_count: deliveryCount, err: err.message },
          retry ? 'handler failed, message will be redelivered' : 'handler rejected message, dead-lettering it',
        );
        consumeChannel.nack(msg, false, retry);
      }
    });
    state.consumerTags.push(consumerTag);
  }

  async function close() {
    state.closing = true;
    for (const tag of state.consumerTags) await consumeChannel.cancel(tag).catch(() => {});
    await connection.close().catch(() => {});
  }

  return { declareQueue, publish, consume, close, isOpen: () => state.open };
}

module.exports = { createBroker, NonRetryableError, EXCHANGE };
