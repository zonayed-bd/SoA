'use strict';

const config = require('./config');
const schemaSql = require('./schema');
const { createLogger } = require('./lib/logger');
const { createBroker } = require('./lib/broker');
const { startRelay } = require('./lib/outbox');
const { createPool, createHttpServer, onShutdown } = require('./lib/runtime');
const { registerRoutes } = require('./routes');
const replies = require('./replies');

async function main() {
  const log = createLogger(config);
  const pool = await createPool({ connectionString: config.databaseUrl, log, schemaSql });
  const broker = await createBroker({ url: config.amqpUrl, log });
  await broker.declareQueue(replies.QUEUE, replies.BINDINGS);

  const relay = startRelay({ pool, broker, log, intervalMs: config.outboxPollMs });
  await broker.consume(replies.QUEUE, replies.createReplyHandler({ pool, config }));

  const { app, markShuttingDown } = createHttpServer({
    log,
    readinessChecks: {
      database: () => pool.query('SELECT 1'),
      broker: async () => {
        if (!broker.isOpen()) throw new Error('broker connection closed');
      },
    },
  });
  registerRoutes(app, { pool, config });
  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info({ event: 'service.started', port: config.port }, 'order-service started');

  onShutdown(log, [markShuttingDown, () => app.close(), () => relay.stop(), () => broker.close(), () => pool.end()]);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', service: config.service, event: 'service.crashed', message: err.message }));
  process.exit(1);
});
