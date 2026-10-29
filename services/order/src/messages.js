'use strict';

// Message catalogue for the place-order saga. Routing keys: "cmd.*" are commands
// sent to one service; "evt.*" are facts that any subscriber may react to.
const ROUTES = {
  orderPlaced: { routingKey: 'evt.order.placed', type: 'order.placed.v1' },
  orderConfirmed: { routingKey: 'evt.order.confirmed', type: 'order.confirmed.v1' },
  orderRejected: { routingKey: 'evt.order.rejected', type: 'order.rejected.v1' },
  reserveStock: { routingKey: 'cmd.inventory.reserve-stock', type: 'inventory.reserve-stock.v1' },
  releaseStock: { routingKey: 'cmd.inventory.release-stock', type: 'inventory.release-stock.v1' },
  authorisePayment: { routingKey: 'cmd.payment.authorise', type: 'payment.authorise.v1' },
};

// OrderPlaced is a published contract (see contracts/). Additive changes only;
// a breaking change means a new type, order.placed.v2.
function orderPlacedData(order) {
  return {
    orderId: order.id,
    customerId: order.customerId,
    items: order.items.map(({ sku, quantity, unitPriceCents }) => ({ sku, quantity, unitPriceCents })),
    totalCents: order.totalCents,
    vatCents: order.vatCents,
    currency: order.currency,
    placedAt: order.createdAt,
  };
}

module.exports = { ROUTES, orderPlacedData };
