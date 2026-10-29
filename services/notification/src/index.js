'use strict';

const config = require('./config');
const schemaSql = require('./schema');
const { createLogger } = require('./lib/logger');
const { createBroker } = require('./lib/broker');
const { createPool, createHttpServer, onShutdown } = require('./lib/runtime');
const handlers = require('./handlers');

async function main() {
  const log = createLogger(config);
  const pool = await createPool({ connectionString: config.databaseUrl, log, schemaSql });
  const broker = await createBroker({ url: config.amqpUrl, log });
  await broker.declareQueue(handlers.QUEUE, handlers.BINDINGS);
  await broker.consume(handlers.QUEUE, handlers.createHandler({ pool }));

  // No public API: the HTTP server exists for health probes only.
  const { app, markShuttingDown } = createHttpServer({
    log,
    readinessChecks: {
      database: () => pool.query('SELECT 1'),
      broker: async () => {
        if (!broker.isOpen()) throw new Error('broker connection closed');
      },
    },
  });
  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info({ event: 'service.started', port: config.port }, 'notification-service started');
  onShutdown(log, [markShuttingDown, () => broker.close(), () => app.close(), () => pool.end()]);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', service: config.service, event: 'service.crashed', message: err.message }));
  process.exit(1);
});
