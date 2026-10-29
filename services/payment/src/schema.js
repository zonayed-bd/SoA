'use strict';

const { OUTBOX_DDL } = require('./lib/outbox');
const { INBOX_DDL } = require('./lib/inbox');

// Payment stores provider references only. Card data never reaches MaltaShop:
// cards are tokenised by the provider's hosted fields in the browser/app.
module.exports = `
CREATE TABLE IF NOT EXISTS payments (
  order_id     uuid        PRIMARY KEY,
  status       text        NOT NULL,
  amount_cents integer     NOT NULL CHECK (amount_cents >= 0),
  currency     char(3)     NOT NULL,
  provider     text,
  provider_ref text,
  decline_code text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

${OUTBOX_DDL}
${INBOX_DDL}
`;
