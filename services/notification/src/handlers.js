'use strict';

const { withInbox } = require('./lib/inbox');
const { NonRetryableError } = require('./lib/broker');
const templates = require('./templates');

const QUEUE = 'notification-service.order-events';
const BINDINGS = ['evt.order.*'];

function createHandler({ pool }) {
  return async function handle(envelope, log) {
    // Malformed or unknown messages can never succeed: dead-letter them at once.
    const data = envelope.data;
    if (!templates.supports(envelope.type) || !data || !data.orderId || !data.customerId) {
      throw new NonRetryableError(`cannot handle message of type ${envelope.type}`);
    }

    const result = await withInbox(pool, envelope, 'notification', async (client) => {
      const { rows } = await client.query('SELECT first_name, email FROM customer_contacts WHERE customer_id = $1', [data.customerId]);
      if (!rows[0]) {
        log.warn({ event: 'notification.skipped', order_id: data.orderId, reason: 'no-contact' }, 'no contact details, skipping');
        return null;
      }
      const email = templates.render(envelope, { firstName: rows[0].first_name });
      // A real service hands the email to a provider here; the prototype records it.
      await client.query(
        `INSERT INTO notifications (message_id, order_id, customer_id, template, channel, status)
         VALUES ($1, $2, $3, $4, 'email', 'SENT')`,
        [envelope.id, data.orderId, data.customerId, email.template],
      );
      log.info(
        {
          event: 'notification.sent',
          order_id: data.orderId,
          template: email.template,
          recipient: templates.maskEmail(rows[0].email),
          subject: email.subject,
        },
        `email '${email.template}' sent`,
      );
      return email;
    });
    if (result.duplicate) log.info({ event: 'message.duplicate', order_id: data.orderId }, 'duplicate event skipped, no second email');
  };
}

module.exports = { QUEUE, BINDINGS, createHandler };
