'use strict';

const config = require('./config');
const schemaSql = require('./schema');
const { createLogger } = require('./lib/logger');
const { createBroker } = require('./lib/broker');
const { startRelay } = require('./lib/outbox');
const { createPool, createHttpServer, onShutdown } = require('./lib/runtime');
const handlers = require('./handlers');

async function main() {
  const log = createLogger(config);
  const pool = await createPool({ connectionString: config.databaseUrl, log, schemaSql });
  const broker = await createBroker({ url: config.amqpUrl, log });
  await broker.declareQueue(handlers.QUEUE, handlers.BINDINGS);
  const relay = startRelay({ pool, broker, log, intervalMs: config.outboxPollMs });
  await broker.consume(handlers.QUEUE, handlers.createHandler({ pool, config }));

  const { app, markShuttingDown } = createHttpServer({
    log,
    readinessChecks: {
      database: () => pool.query('SELECT 1'),
      broker: async () => {
        if (!broker.isOpen()) throw new Error('broker connection closed');
      },
    },
  });

  // Read-only view of stock, used by the demo and smoke tests.
  app.get('/v1/stock/:sku', async (request, reply) => {
    const { rows } = await pool.query('SELECT sku, available FROM stock WHERE sku = $1', [request.params.sku]);
    if (!rows[0]) return reply.code(404).send({ status: 404, code: 'SKU_NOT_FOUND', message: 'Unknown sku.', correlationId: request.id });
    return rows[0];
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info({ event: 'service.started', port: config.port }, 'inventory-service started');
  onShutdown(log, [markShuttingDown, () => app.close(), () => broker.close(), () => relay.stop(), () => pool.end()]);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', service: config.service, event: 'service.crashed', message: err.message }));
  process.exit(1);
});
