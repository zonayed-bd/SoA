'use strict';

// Consumer side of the OrderPlaced contract. Notification states what it needs
// (contracts/order-placed.v1.notification-service.json) and proves here that it
// can handle a message shaped exactly like the contract's example.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const templates = require('../../src/templates');

const contract = require(path.join(__dirname, '../../../../contracts/order-placed.v1.notification-service.json'));

test('the contract example satisfies the consumer schema', () => {
  const ajv = addFormats(new Ajv({ allErrors: true }));
  const validate = ajv.compile(contract.schema);
  assert.equal(validate(contract.example), true, JSON.stringify(validate.errors));
});

test('notification can render the order-received email from the contract example', () => {
  assert.equal(templates.supports(contract.example.type), true);
  const email = templates.render(contract.example, { firstName: 'Maria' });
  assert.equal(email.template, 'order-received');
  assert.match(email.subject, /6F1C2A8E/);
  assert.match(email.body, /2 item\(s\) totalling €149\.97/);
});

test('personal data is masked before it is logged', () => {
  assert.equal(templates.maskEmail('maria.borg@example.com'), 'm***@example.com');
});
