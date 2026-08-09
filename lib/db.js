/*
  In-memory data store.

  This is intentionally NOT a real database yet - it's here so you can
  build and test the conversation + tool-calling logic without also
  standing up Postgres on day one. Everything resets when the server
  restarts.

  When you're ready for a real database (Supabase/Neon Postgres is a
  good free-tier choice), swap the functions below for real queries.
  The shape of each function (inputs/outputs) is designed to map
  cleanly onto a `deliveries` table, so the rest of the app won't need
  to change.

  Suggested real table:

    deliveries (
      id            serial primary key,
      client_id     text,       -- which business this order belongs to
      customer_name text,
      address       text,
      phone         text,
      product       text,
      quantity      text,
      frequency     text,       -- 'one-time' | 'weekly' | 'biweekly' etc
      next_date     date,
      status        text,       -- 'confirmed' | 'cancelled' | 'completed'
      created_at    timestamp default now()
    )
*/

const deliveries = [];
let nextId = 1;

/** Rough daily capacity check. In-memory version just counts orders
 *  landing on the same date; a real version would sum quantities. */
export function checkCapacity(clientConfig, date) {
  const ordersOnDate = deliveries.filter(
    (d) => d.clientId === clientConfig.clientId && d.nextDate === date && d.status === "confirmed"
  );
  const capacity = clientConfig.dailyCapacityBags || 999;
  const used = ordersOnDate.length; // placeholder - refine to sum real quantities later
  return {
    date,
    capacity,
    used,
    available: used < capacity,
  };
}

export function createOrder({ clientId, customerName, address, phone, product, quantity, date }) {
  const order = {
    id: nextId++,
    clientId,
    customerName,
    address,
    phone,
    product,
    quantity,
    frequency: "one-time",
    nextDate: date,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };
  deliveries.push(order);
  return order;
}

export function createRecurringOrder({ clientId, customerName, address, phone, product, quantity, frequency, nextDate }) {
  const order = {
    id: nextId++,
    clientId,
    customerName,
    address,
    phone,
    product,
    quantity,
    frequency, // e.g. "weekly", "biweekly"
    nextDate,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };
  deliveries.push(order);
  return order;
}

export function modifyDelivery({ orderId, updates }) {
  const order = deliveries.find((d) => d.id === orderId);
  if (!order) return null;
  Object.assign(order, updates);
  return order;
}

export function listOrdersForClient(clientId) {
  return deliveries.filter((d) => d.clientId === clientId);
}
