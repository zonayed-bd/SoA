'use strict';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

module.exports = {
  service: 'inventory-service',
  version: process.env.SERVICE_VERSION || 'dev',
  env: process.env.APP_ENV || 'local',
  port: Number(process.env.PORT || 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  databaseUrl: required('DATABASE_URL'),
  amqpUrl: required('AMQP_URL'),
  outboxPollMs: Number(process.env.OUTBOX_POLL_MS || 250),
};
