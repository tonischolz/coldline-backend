/*
  Invoice Ninja integration (cloud version: invoicing.co).

  Creates a DRAFT invoice whenever an order is confirmed - draft, not
  auto-sent, so nothing reaches a customer until it's been reviewed.
  This matters because product prices aren't part of the ordering
  conversation (the AI is deliberately told never to quote pricing) -
  so unless you've added prices to a client's config, invoices come
  through with the amount left at $0 and a note flagging it for review.

  Requires environment variables (set these in Render, not in this file):
    INVOICE_NINJA_API_KEY  - Invoice Ninja > Settings > Account Management
                              > Integrations > API Tokens > create one
    INVOICE_NINJA_URL      - only needed for self-hosted; cloud accounts
                              can leave this unset (defaults below)
*/

const BASE_URL = process.env.INVOICE_NINJA_URL || "https://invoicing.co/api/v1";
const API_KEY = process.env.INVOICE_NINJA_API_KEY;

async function ninjaFetch(path, options = {}) {
  if (!API_KEY) {
    throw new Error("INVOICE_NINJA_API_KEY is not set - add it in Render's environment settings.");
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "X-Api-Token": API_KEY,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Invoice Ninja request failed (${res.status}): ${body}`);
  }
  return res.json();
}

/** Finds an existing Invoice Ninja client by name, or creates one. */
async function findOrCreateClient({ customerName, address, phone }) {
  const search = await ninjaFetch(`/clients?filter=${encodeURIComponent(customerName)}`);
  const existing = search.data?.find(
    (c) => c.name?.toLowerCase() === customerName.toLowerCase()
  );
  if (existing) return existing;

  const created = await ninjaFetch("/clients", {
    method: "POST",
    body: JSON.stringify({
      name: customerName,
      address1: address,
      contacts: [{ phone }],
    }),
  });
  return created.data;
}

/** Looks up a per-unit price from the client config, if one has been set. */
function findUnitPrice(clientConfig, productName) {
  const product = clientConfig.products?.find(
    (p) => p.name.toLowerCase() === productName.toLowerCase()
  );
  return typeof product?.priceEach === "number" ? product.priceEach : null;
}

/** Looks up a flat rental price for a piece of special-event equipment. */
function findEquipmentPrice(clientConfig, equipmentId) {
  const equipment = clientConfig.equipment?.find((e) => e.id === equipmentId);
  return typeof equipment?.price === "number" ? equipment.price : null;
}

/**
 * Creates a DRAFT invoice for a confirmed order (standard or special
 * event). Returns { invoiceId, invoiceNumber, needsPricing }.
 * Throws on failure - the caller (tools.js) treats this as non-fatal to
 * the order itself, since the delivery/event should still be booked even
 * if invoicing has a hiccup.
 */
export async function createDraftInvoice(clientConfig, order) {
  const client = await findOrCreateClient(order);

  const isEvent = !!order.equipmentId;
  const price = isEvent
    ? findEquipmentPrice(clientConfig, order.equipmentId)
    : findUnitPrice(clientConfig, order.product);
  const needsPricing = price === null;

  const scheduleNote = isEvent
    ? `${order.nextDate} through ${order.endDate}`
    : order.frequency === "one-time"
      ? `Delivery ${order.nextDate}`
      : `${order.frequency} delivery starting ${order.nextDate}`;

  const invoice = await ninjaFetch("/invoices", {
    method: "POST",
    body: JSON.stringify({
      client_id: client.id,
      line_items: [
        {
          notes:
            `${order.product} — ${order.quantity} — ${scheduleNote}` +
            (needsPricing ? " (price not set — update before sending)" : ""),
          quantity: 1,
          cost: price ?? 0,
        },
      ],
    }),
  });

  return {
    invoiceId: invoice.data.id,
    invoiceNumber: invoice.data.number,
    needsPricing,
  };
}
