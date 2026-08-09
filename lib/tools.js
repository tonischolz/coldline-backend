/*
  Tool-calling setup.
  Instead of letting Claude free-write "the order is booked," we give it
  a fixed set of functions it can call. Claude decides WHEN to call them
  and WITH WHAT arguments, based on the conversation - but the actual
  booking logic (capacity checks, equipment availability, writing to the
  data store) is real code we control. This is what keeps the AI from,
  say, inventing an order or a free truck that was never actually there.
*/
import { checkCapacity, createOrder, createRecurringOrder, createEventOrder, modifyDelivery } from "./db.js";
import { checkEquipmentAvailability, bookEquipment } from "./equipment.js";

// This is the schema Claude sees. Keep descriptions specific -
// Claude uses them to decide which tool to call and how to fill args.
export const toolDefinitions = [
  {
    name: "check_capacity",
    description: "Check whether the business has shared daily production capacity available on a given date, for STANDARD delivery orders. Pass the customer's requested quantity (e.g. '20 large bags' or '200 lbs') and the product whenever you know them.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to check, format YYYY-MM-DD" },
        quantity: { type: "string", description: "e.g. '20 large bags', '5 small bags', or '200 lbs'." },
        product: { type: "string", description: "e.g. 'Large bag - cubed ice'. Helps determine bag size if the quantity doesn't specify it." },
      },
      required: ["date"],
    },
  },
  {
    name: "create_order",
    description: "Create a one-time (non-recurring) STANDARD delivery order once you have all required details and capacity has been confirmed.",
    input_schema: {
      type: "object",
      properties: {
        customerName: { type: "string", description: "Name of the business or customer ordering" },
        address: { type: "string" },
        phone: { type: "string" },
        product: { type: "string", description: "e.g. 'Large bag - cubed ice'" },
        quantity: { type: "string", description: "e.g. '200 lbs' or '20 large bags'" },
        date: { type: "string", description: "Delivery date, format YYYY-MM-DD" },
      },
      required: ["customerName", "address", "phone", "product", "quantity", "date"],
    },
  },
  {
    name: "create_recurring_order",
    description: "Set up a standing/recurring STANDARD delivery order (e.g. every Friday) once all details are confirmed.",
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
    name: "check_equipment_availability",
    description: "Check whether a piece of SPECIAL EVENT equipment (merchandise box or freezer truck) is available for the requested dates and quantity, before booking. Always call this before create_event_order.",
    input_schema: {
      type: "object",
      properties: {
        equipmentId: { type: "string", description: "One of: small_merch_box, large_merch_box, small_freezer_truck, large_freezer_truck" },
        startDate: { type: "string", description: "Event drop-off date, format YYYY-MM-DD" },
        endDate: { type: "string", description: "Pickup date, format YYYY-MM-DD. Optional for merchandise boxes (defaults to a 2-day/weekend window); ask the customer for this and include it for freezer trucks, since their event length varies." },
        quantityBags: { type: "number", description: "How many large bags of ice the event needs." },
      },
      required: ["equipmentId", "startDate"],
    },
  },
  {
    name: "create_event_order",
    description: "Book a SPECIAL EVENT order (merchandise box or freezer truck) once check_equipment_availability has confirmed it fits and all details are collected.",
    input_schema: {
      type: "object",
      properties: {
        customerName: { type: "string" },
        address: { type: "string" },
        phone: { type: "string" },
        equipmentId: { type: "string", description: "One of: small_merch_box, large_merch_box, small_freezer_truck, large_freezer_truck" },
        quantityBags: { type: "number", description: "How many large bags of ice the event needs." },
        startDate: { type: "string", description: "Event drop-off date, format YYYY-MM-DD" },
        endDate: { type: "string", description: "Pickup date, format YYYY-MM-DD. Optional for merchandise boxes." },
      },
      required: ["customerName", "address", "phone", "equipmentId", "quantityBags", "startDate"],
    },
  },
  {
    name: "modify_delivery",
    description: "Change or cancel an existing order (standard or special event) - e.g. skip a delivery, change quantity, or update the date.",
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
 *  (rather than just an id) so capacity/equipment checks know that client's
 *  real limits. */
export async function runTool(clientConfig, toolName, toolInput) {
  const clientId = clientConfig.clientId;
  switch (toolName) {
    case "check_capacity":
      return checkCapacity(clientConfig, toolInput.date, toolInput.quantity, toolInput.product);

    case "create_order":
      return createOrder({ clientId, ...toolInput }, clientConfig);

    case "create_recurring_order":
      return createRecurringOrder({ clientId, ...toolInput }, clientConfig);

    case "check_equipment_availability":
      return checkEquipmentAvailability(
        clientConfig,
        toolInput.equipmentId,
        toolInput.startDate,
        toolInput.endDate,
        toolInput.quantityBags
      );

    case "create_event_order": {
      const equipment = clientConfig.equipment?.find((e) => e.id === toolInput.equipmentId);
      if (!equipment) return { error: `Unknown equipment: ${toolInput.equipmentId}` };

      // Re-check everything server-side - never trust that the AI's prior
      // check_equipment_availability call is still valid by the time it
      // actually tries to book (another order could have landed first).
      const availability = checkEquipmentAvailability(
        clientConfig,
        toolInput.equipmentId,
        toolInput.startDate,
        toolInput.endDate,
        toolInput.quantityBags
      );
      if (!availability.fitsCapacity) {
        return { error: `${equipment.label} only holds up to ${equipment.capacityBags} large bags - offer a bigger option or ask them to reduce quantity.` };
      }
      if (!availability.meetsMinimum) {
        return { error: `${equipment.label} requires a minimum of ${equipment.minBags} large bags.` };
      }
      if (!availability.unitAvailable) {
        return { error: `No ${equipment.label} units are free for those dates - ask the customer for a different date.` };
      }
      if (!availability.dailyPoolAvailable) {
        return { error: `Not enough daily production capacity on ${toolInput.startDate} - ask the customer for a different date.` };
      }

      const booking = bookEquipment(clientConfig, toolInput.equipmentId, toolInput.startDate, toolInput.endDate, null);
      if (!booking) {
        return { error: `No ${equipment.label} units are free for those dates - ask the customer for a different date.` };
      }

      const order = createEventOrder({ clientId, ...toolInput, endDate: booking.endDate }, clientConfig);
      booking.orderId = order.id;
      return order;
    }

    case "modify_delivery":
      return modifyDelivery(toolInput, clientConfig);

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
