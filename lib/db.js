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
      client_id     text,
      order_type    text,       -- 'standard' | 'special_event'
      customer_name text,
      address       text,
      phone         text,
      product       text,       -- bag type, or equipment label for events
      quantity      text,       -- human-readable, e.g. "20 large bags"
      quantity_lbs  numeric,    -- parsed quantity, normalized to pounds -
                                 -- this is what counts against the shared
                                 -- daily production pool for BOTH order types
      equipment_id  text,       -- set only for special_event orders
      frequency     text,       -- 'one-time' | 'weekly' | 'biweekly' etc
      next_date     date,       -- delivery/drop-off date
      end_date      date,       -- pickup date, set only for special_event
      status        text,       -- 'confirmed' | 'cancelled' | 'completed'
      created_at    timestamp default now()
    )
*/
import { parseQuantityToLbs } from "./quantity.js";

const deliveries = [];
let nextId = 1;

/** Capacity check against the SHARED daily production pool (6,000 large
 *  bags = 96,000 lbs). This is the one constraint every order draws
 *  from - standard deliveries and special-event equipment alike - since
 *  both ultimately need bagged ice made that day. Equipment availability
 *  (which physical truck/box is free) is a separate check in
 *  equipment.js. */
export function checkCapacity(clientConfig, date, quantityText, productName) {
  const capacityLbs = clientConfig.dailyCapacityLbs || 999999;

  const ordersOnDate = deliveries.filter(
    (d) => d.clientId === clientConfig.clientId && d.nextDate === date && d.status === "confirmed"
  );
  const usedLbs = ordersOnDate.reduce((sum, d) => sum + (d.quantityLbs || 0), 0);

  const parsed = quantityText ? parseQuantityToLbs(quantityText, clientConfig, productName) : null;
  const requestedLbs = parsed ? parsed.lbs : null;
  const quantityUnclear = !!(parsed && parsed.unclear);

  const remainingLbs = Math.max(capacityLbs - usedLbs, 0);
  const available = requestedLbs == null
    ? usedLbs < capacityLbs
    : usedLbs + requestedLbs <= capacityLbs;

  return {
    date,
    capacityLbs,
    usedLbs: round1(usedLbs),
    remainingLbs: round1(remainingLbs),
    requestedLbs: requestedLbs == null ? null : round1(requestedLbs),
    available,
    quantityUnclear, // true if the bag size couldn't be determined - ask before booking
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function createOrder({ clientId, customerName, address, phone, product, quantity, date }, clientConfig) {
  const { lbs } = parseQuantityToLbs(quantity, clientConfig, product);
  const order = {
    id: nextId++,
    clientId,
    orderType: "standard",
    customerName,
    address,
    phone,
    product,
    quantity,
    quantityLbs: lbs,
    frequency: "one-time",
    nextDate: date,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };
  deliveries.push(order);
  return order;
}

export function createRecurringOrder({ clientId, customerName, address, phone, product, quantity, frequency, nextDate }, clientConfig) {
  const { lbs } = parseQuantityToLbs(quantity, clientConfig, product);
  const order = {
    id: nextId++,
    clientId,
    orderType: "standard",
    customerName,
    address,
    phone,
    product,
    quantity,
    quantityLbs: lbs,
    frequency, // e.g. "weekly", "biweekly"
    nextDate,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };
  deliveries.push(order);
  return order;
}

/** Creates a special-event order (merchandise box or freezer truck).
 *  quantityBags is always a large-bag count (that's how event capacity
 *  is specified), so quantityLbs is derived directly rather than parsed
 *  from free text. Sharing the `deliveries` array with standard orders
 *  is what makes the shared daily pool work automatically for both. */
export function createEventOrder({ clientId, customerName, address, phone, equipmentId, quantityBags, startDate, endDate }, clientConfig) {
  const equipment = clientConfig.equipment?.find((e) => e.id === equipmentId);
  const order = {
    id: nextId++,
    clientId,
    orderType: "special_event",
    customerName,
    address,
    phone,
    equipmentId,
    product: equipment?.label || equipmentId,
    quantity: `${quantityBags} large bags`,
    quantityBags,
    quantityLbs: quantityBags * 16,
    frequency: "one-time",
    nextDate: startDate, // drop-off date - counts against the daily pool
    endDate,
    status: "confirmed",
    createdAt: new Date().toISOString(),
  };
  deliveries.push(order);
  return order;
}

export function modifyDelivery({ orderId, updates }, clientConfig) {
  const order = deliveries.find((d) => d.id === orderId);
  if (!order) return null;
  Object.assign(order, updates);
  if (updates.quantity) {
    const { lbs } = parseQuantityToLbs(updates.quantity, clientConfig, updates.product || order.product);
    order.quantityLbs = lbs;
  }
  return order;
}

export function listOrdersForClient(clientId) {
  return deliveries.filter((d) => d.clientId === clientId);
}
