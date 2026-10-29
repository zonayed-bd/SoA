'use strict';

const config = require('./config');
const schemaSql = require('./schema');
const { createLogger } = require('./lib/logger');
const { createBroker } = require('./lib/broker');
const { startRelay } = require('./lib/outbox');
const { createPool, createHttpServer, onShutdown } = require('./lib/runtime');
const { simulatedProvider } = require('./providers');
const { createPaymentGateway } = require('./gateway');
const handlers = require('./handlers');

async function main() {
  const log = createLogger(config);
  const pool = await createPool({ connectionString: config.databaseUrl, log, schemaSql });
  const broker = await createBroker({ url: config.amqpUrl, log });
  await broker.declareQueue(handlers.QUEUE, handlers.BINDINGS);

  const gateway = createPaymentGateway({
    primary: simulatedProvider('acmepay', { outage: () => config.psp.primaryOutage }),
    secondary: simulatedProvider('betapay'),
    timeoutMs: config.psp.timeoutMs,
    log,
  });

  const relay = startRelay({ pool, broker, log, intervalMs: config.outboxPollMs });
  // prefetch 5: at most five provider calls in flight per copy (a simple bulkhead).
  await broker.consume(handlers.QUEUE, handlers.createHandler({ pool, gateway, config }), { prefetch: 5 });

  const { app, markShuttingDown } = createHttpServer({
    log,
    readinessChecks: {
      database: () => pool.query('SELECT 1'),
      broker: async () => {
        if (!broker.isOpen()) throw new Error('broker connection closed');
      },
    },
  });
  app.get('/v1/payments/:orderId', async (request, reply) => {
    const { rows } = await pool.query(
      'SELECT order_id, status, amount_cents, currency, provider, provider_ref, decline_code FROM payments WHERE order_id::text = $1',
      [request.params.orderId],
    );
    if (!rows[0]) return reply.code(404).send({ status: 404, code: 'PAYMENT_NOT_FOUND', message: 'No payment for that order.', correlationId: request.id });
    return { ...rows[0], circuit: gateway.state() };
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info({ event: 'service.started', port: config.port, primary_outage: config.psp.primaryOutage }, 'payment-service started');
  onShutdown(log, [markShuttingDown, () => app.close(), () => broker.close(), () => relay.stop(), () => pool.end()]);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', service: config.service, event: 'service.crashed', message: err.message }));
  process.exit(1);
});
