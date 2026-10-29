'use strict';

// Structured JSON logger implementing the MaltaShop mandatory log schema:
// every line carries timestamp, level, service, version, env and message, and
// request/message handlers add correlation_id and event via child loggers.
// Personal data (emails, payment tokens) is redacted before it leaves the process.
const pino = require('pino');

function createLogger({ service, version, env, level }) {
  return pino({
    level: level || 'info',
    messageKey: 'message',
    base: { service, version, env },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ['email', '*.email', 'paymentToken', '*.paymentToken', 'req.headers.authorization'],
      censor: '[REDACTED]',
    },
  });
}

module.exports = { createLogger };
