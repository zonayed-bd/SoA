'use strict';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

module.exports = {
  service: 'payment-service',
  version: process.env.SERVICE_VERSION || 'dev',
  env: process.env.APP_ENV || 'local',
  port: Number(process.env.PORT || 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  databaseUrl: required('DATABASE_URL'),
  amqpUrl: required('AMQP_URL'),
  outboxPollMs: Number(process.env.OUTBOX_POLL_MS || 250),
  psp: {
    timeoutMs: Number(process.env.PSP_TIMEOUT_MS || 2000),
    // Demo switch: make the primary provider fail so the breaker opens and
    // traffic fails over to the secondary provider.
    primaryOutage: process.env.PSP_PRIMARY_SIMULATE_OUTAGE === 'true',
  },
};
