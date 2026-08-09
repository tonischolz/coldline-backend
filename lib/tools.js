/*
  Tool-calling setup.

  Instead of letting Claude free-write "the order is booked," we give it
  a fixed set of functions it can call. Claude decides WHEN to call them
  and WITH WHAT arguments, based on the conversation - but the actual
  booking logic (capacity checks, writing to the data store) is real
  code we control. This is what keeps the AI from, say, inventing an
  order that was never actually saved.
*/

import { checkCapacity, createOrder, createRecurringOrder, modifyDelivery } from "./db.js";

// This is the schema Claude sees. Keep descriptions specific -
// Claude uses them to decide which tool to call and how to fill args.
export const toolDefinitions = [
  {
    name: "check_capacity",
    description: "Check whether the business has delivery capacity available on a given date before confirming an order.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to check, format YYYY-MM-DD" },
      },
      required: ["date"],
    },
  },
  {
    name: "create_order",
    description: "Create a one-time (non-recurring) delivery order once you have all required details and capacity has been confirmed.",
    input_schema: {
      type: "object",
      properties: {
        customerName: { type: "string", description: "Name of the business or customer ordering" },
        address: { type: "string" },
        phone: { type: "string" },
        product: { type: "string", description: "e.g. 'Bagged cubed ice'" },
        quantity: { type: "string", description: "e.g. '200 lbs' or '20 bags'" },
        date: { type: "string", description: "Delivery date, format YYYY-MM-DD" },
      },
      required: ["customerName", "address", "phone", "product", "quantity", "date"],
    },
  },
  {
    name: "create_recurring_order",
    description: "Set up a standing/recurring delivery order (e.g. every Friday) once all details are confirmed.",
    input_schema: {
      type: "object",
      properties: {
        customerName: { type: "string" },
        address: { type: "string" },
        phone: { type: "string" },
        product: { type: "string" },
        quantity: { type: "string" },
        frequency: { type: "string", description: "e.g. 'weekly', 'biweekly'" },
        nextDate: { type: "string", description: "Date of the first delivery, format YYYY-MM-DD" },
      },
      required: ["customerName", "address", "phone", "product", "quantity", "frequency", "nextDate"],
    },
  },
  {
    name: "modify_delivery",
    description: "Change or cancel an existing order - e.g. skip a delivery, change quantity, or update the date.",
    input_schema: {
      type: "object",
      properties: {
        orderId: { type: "number" },
        updates: {
          type: "object",
          description: "Fields to change, e.g. { \"status\": \"cancelled\" } or { \"nextDate\": \"2026-08-20\" }",
        },
      },
      required: ["orderId", "updates"],
    },
  },
];

/** Executes a tool call Claude requested and returns the result to send back.
 *  clientConfig is the full parsed JSON from /clients/<id>.json - passed in
 *  (rather than just an id) so capacity checks know that client's real limits. */
export function runTool(clientConfig, toolName, toolInput) {
  const clientId = clientConfig.clientId;

  switch (toolName) {
    case "check_capacity":
      return checkCapacity(clientConfig, toolInput.date);

    case "create_order":
      return createOrder({ clientId, ...toolInput });

    case "create_recurring_order":
      return createRecurringOrder({ clientId, ...toolInput });

    case "modify_delivery":
      return modifyDelivery(toolInput);

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
