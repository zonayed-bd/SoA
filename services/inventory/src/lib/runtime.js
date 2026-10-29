'use strict';

// Shared start-up plumbing: database pool with schema migration, the HTTP
// server with correlation IDs and health endpoints, and graceful shutdown.
const { randomUUID } = require('node:crypto');
const Fastify = require('fastify');
const { Pool } = require('pg');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createPool({ connectionString, log, schemaSql }) {
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn({ event: 'db.connect.retry', attempt, err: err.message }, 'database not reachable yet, retrying');
      await sleep(Math.min(500 * attempt, 5000));
    }
  }
  // Prototype shortcut: the schema is applied at start-up under an advisory lock.
  // In production this runs as a one-off migration job (12-factor admin process).
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(4242)');
    await client.query(schemaSql);
    await client.query('SELECT pg_advisory_unlock(4242)');
  } finally {
    client.release();
  }
  return pool;
}

function createHttpServer({ log, readinessChecks }) {
  const app = Fastify({
    loggerInstance: log,
    disableRequestLogging: true,
    requestIdHeader: 'x-correlation-id',
    requestIdLogLabel: 'correlation_id',
    genReqId: () => randomUUID(),
  });

  let shuttingDown = false;

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/health')) return;
    request.log.info(
      {
        event: 'http.request.completed',
        http_method: request.method,
        http_route: request.routeOptions.url,
        http_status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
      },
      `${request.method} ${request.url} -> ${reply.statusCode}`,
    );
  });

  // Errors follow one shape everywhere: status, code, message, correlationId.
  app.setErrorHandler((err, request, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    const code = err.validation ? 'VALIDATION_FAILED' : err.code && status < 500 ? err.code : 'INTERNAL_ERROR';
    if (status >= 500) request.log.error({ event: 'http.request.error', err: err.message }, 'unhandled error');
    reply.code(status).send({
      status,
      code,
      message: status >= 500 ? 'Something went wrong on our side.' : err.message,
      correlationId: request.id,
    });
  });

  // Liveness: is the process able to serve at all? Deliberately has no dependencies,
  // so a slow database never triggers a restart storm.
  app.get('/health/live', async () => ({ status: 'ok' }));

  // Readiness: can this copy take traffic right now?
  app.get('/health/ready', async (request, reply) => {
    if (shuttingDown) return reply.code(503).send({ status: 'shutting-down' });
    const results = {};
    for (const [name, check] of Object.entries(readinessChecks)) {
      try {
        await check();
        results[name] = 'ok';
      } catch (err) {
        results[name] = err.message;
      }
    }
    const ok = Object.values(results).every((r) => r === 'ok');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not-ready', checks: results });
  });

  return { app, markShuttingDown: () => (shuttingDown = true) };
}

// Disposability: on SIGTERM stop taking work, finish in-flight work, then exit.
function onShutdown(log, steps) {
  let called = false;
  const handler = async (signal) => {
    if (called) return;
    called = true;
    log.info({ event: 'service.stopping', signal }, 'shutting down gracefully');
    const timer = setTimeout(() => process.exit(1), 10_000).unref();
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        log.warn({ event: 'service.stopping.step_failed', err: err.message }, 'shutdown step failed');
      }
    }
    clearTimeout(timer);
    log.info({ event: 'service.stopped' }, 'stopped');
    process.exit(0);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

module.exports = { createPool, createHttpServer, onShutdown };
