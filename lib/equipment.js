/*
  Equipment availability + booking for special-event orders (merchandise
  boxes and freezer trucks).

  This is deliberately a different kind of check than standard delivery's
  daily pool: standard orders only need a single date and a shared total,
  but equipment is a small, fixed inventory (3 small boxes, 2 large boxes,
  1 small truck, 2 large trucks) - a specific unit that's out at one event
  isn't available for another until its rental period ends. So bookings
  are tracked as a DATE RANGE per unit, not a single-day total.

  In-memory for now, same as db.js - resets on server restart. Maps
  cleanly onto a real table later:
    equipment_bookings (
      id            serial primary key,
      client_id     text,
      equipment_id  text,       -- matches an id in clientConfig.equipment
      unit_number   integer,    -- which physical unit (1, 2, 3...)
      start_date    date,
      end_date      date,
      order_id      integer references deliveries(id)
    )
*/
import { checkCapacity } from "./db.js";

const equipmentBookings = [];
let nextBookingId = 1;

function findEquipment(clientConfig, equipmentId) {
  return clientConfig.equipment?.find((e) => e.id === equipmentId) || null;
}

function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  const from = new Date(fromStr + "T00:00:00Z");
  const to = new Date(toStr + "T00:00:00Z");
  return Math.round((to - from) / 86400000);
}

/**
 * Full availability check for one piece of equipment: is a unit free for
 * these dates, does the requested quantity fit within that unit's
 * capacity/minimum, is there enough lead time, AND is there still room
 * in the shared daily production pool on the drop-off date. Everything
 * the AI needs before it can safely book.
 */
export function checkEquipmentAvailability(clientConfig, equipmentId, startDate, endDate, quantityBags) {
  const equipment = findEquipment(clientConfig, equipmentId);
  if (!equipment) {
    return { error: `Unknown equipment: ${equipmentId}` };
  }

  const end = endDate || addDays(startDate, equipment.rentalDays || 2);

  const overlapping = equipmentBookings.filter(
    (b) => b.clientId === clientConfig.clientId &&
      b.equipmentId === equipmentId &&
      datesOverlap(b.startDate, b.endDate, startDate, end)
  );
  const unitsBooked = overlapping.length;
  const unitsAvailable = Math.max(equipment.units - unitsBooked, 0);

  const today = new Date().toISOString().slice(0, 10);
  const daysNotice = daysBetween(today, startDate);
  const leadTimeOk = equipment.leadTimeDays == null || daysNotice >= equipment.leadTimeDays;

  const fitsCapacity = quantityBags == null ? null : quantityBags <= equipment.capacityBags;
  const meetsMinimum = quantityBags == null || !equipment.minBags ? true : quantityBags >= equipment.minBags;

  const poolCheck = quantityBags != null
    ? checkCapacity(clientConfig, startDate, `${quantityBags} large bags`, "Large bag - cubed ice")
    : null;

  return {
    equipmentId,
    label: equipment.label,
    startDate,
    endDate: end,
    unitsTotal: equipment.units,
    unitsBooked,
    unitsAvailable,
    unitAvailable: unitsAvailable > 0,
    capacityBags: equipment.capacityBags,
    minBags: equipment.minBags,
    fitsCapacity,
    meetsMinimum,
    leadTimeDays: equipment.leadTimeDays,
    daysNotice,
    leadTimeOk,
    dailyPoolAvailable: poolCheck ? poolCheck.available : null,
  };
}

/** Reserves the lowest-numbered free unit of this equipment type for the
 *  given date range. Call only after checkEquipmentAvailability confirms
 *  a unit is free - returns null if none actually is (e.g. a race with
 *  another booking). */
export function bookEquipment(clientConfig, equipmentId, startDate, endDate, orderId) {
  const equipment = findEquipment(clientConfig, equipmentId);
  if (!equipment) return null;

  const end = endDate || addDays(startDate, equipment.rentalDays || 2);

  const overlapping = equipmentBookings.filter(
    (b) => b.clientId === clientConfig.clientId &&
      b.equipmentId === equipmentId &&
      datesOverlap(b.startDate, b.endDate, startDate, end)
  );
  const takenUnitNumbers = new Set(overlapping.map((b) => b.unitNumber));

  let unitNumber = null;
  for (let n = 1; n <= equipment.units; n++) {
    if (!takenUnitNumbers.has(n)) { unitNumber = n; break; }
  }
  if (unitNumber === null) return null;

  const booking = {
    id: nextBookingId++,
    clientId: clientConfig.clientId,
    equipmentId,
    unitNumber,
    startDate,
    endDate: end,
    orderId,
  };
  equipmentBookings.push(booking);
  return booking;
}
