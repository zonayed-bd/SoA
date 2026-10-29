'use strict';

const { INBOX_DDL } = require('./lib/inbox');

// Notification owns contact preferences and a delivery log. Contact details are
// personal data under GDPR, so they live only here and are never logged in clear.
module.exports = `
CREATE TABLE IF NOT EXISTS customer_contacts (
  customer_id text PRIMARY KEY,
  first_name  text NOT NULL,
  email       text NOT NULL,
  locale      text NOT NULL DEFAULT 'en-MT'
);

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial   PRIMARY KEY,
  message_id  uuid        NOT NULL UNIQUE,
  order_id    uuid        NOT NULL,
  customer_id text        NOT NULL,
  template    text        NOT NULL,
  channel     text        NOT NULL,
  status      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

${INBOX_DDL}

INSERT INTO customer_contacts (customer_id, first_name, email) VALUES
  ('cust-1001', 'Maria',  'maria.borg@example.com'),
  ('cust-1002', 'Joseph', 'joseph.camilleri@example.com')
ON CONFLICT (customer_id) DO NOTHING;
`;
