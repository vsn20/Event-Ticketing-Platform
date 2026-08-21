// ============================================================
// waitingRoomService.js — Queue management for high-demand events
//
// Uses Redis Sorted Sets to manage a FIFO queue per event.
// When more customers want to buy tickets than the system can
// handle simultaneously, excess customers are placed in a
// waiting room queue and admitted in order (FCFS).
//
// ARCHITECTURE:
//   - Redis Sorted Set: waiting_room:{eventId}
//     Score = join timestamp (ms), Value = customerId
//     → FIFO ordering by join time
//
//   - Redis Set: admitted:{eventId}
//     → Set of customer IDs currently admitted to buy tickets
//
//   - Threshold: max concurrent buyers per event (default: 200)
//     Stored in Redis as: waiting_room_config:{eventId}
//
// FLOW:
//   1. Customer clicks "Buy Tickets"
//   2. Backend checks: admitted count < threshold?
//      YES → admit immediately, redirect to seat map
//      NO  → add to waiting room queue, show position
//   3. When a buyer finishes (payment or timeout), call releaseSlot()
//   4. releaseSlot() admits the next person from the queue
//   5. Frontend polls getPosition() every few seconds
// ============================================================

const redis = require('../config/redis');

const DEFAULT_THRESHOLD = 200; // max concurrent buyers
const ADMITTED_TTL = 600;       // 10 minutes to complete purchase


// ============================================================
// getThreshold(eventId)
// ============================================================
// Returns the max concurrent buyers for an event.
// Falls back to DEFAULT_THRESHOLD if not configured.
// ============================================================
async function getThreshold(eventId) {
  const val = await redis.get(`waiting_room_config:${eventId}`);
  return val ? parseInt(val) : DEFAULT_THRESHOLD;
}


// ============================================================
// setThreshold(eventId, threshold)
// ============================================================
// Organizer can configure the threshold per event.
// ============================================================
async function setThreshold(eventId, threshold) {
  await redis.set(`waiting_room_config:${eventId}`, String(threshold));
}


// ============================================================
// tryAdmit(eventId, customerId)
// ============================================================
// Main entry point. Checks if the customer can be admitted
// immediately or needs to wait in the queue.
//
// Returns:
//   { admitted: true }  → go to seat map
//   { admitted: false, position: 5, totalInQueue: 42 }  → wait
// ============================================================
async function tryAdmit(eventId, customerId) {
  const customerStr = String(customerId);

  // Already admitted? Let them through.
  const alreadyAdmitted = await redis.sismember(`admitted:${eventId}`, customerStr);
  if (alreadyAdmitted) {
    return { admitted: true };
  }

  // Check how many are currently admitted
  const admittedCount = await redis.scard(`admitted:${eventId}`);
  const threshold = await getThreshold(eventId);

  if (admittedCount < threshold) {
    // Room available — admit immediately
    await redis.sadd(`admitted:${eventId}`, customerStr);
    // Set a TTL on the admitted membership (auto-release if they abandon)
    // We use a separate key for per-member TTL since sets don't support per-member TTL
    await redis.set(`admitted_ttl:${eventId}:${customerStr}`, '1', 'EX', ADMITTED_TTL);
    return { admitted: true };
  }

  // Queue is full — add to waiting room (if not already there)
  const score = await redis.zscore(`waiting_room:${eventId}`, customerStr);
  if (!score) {
    await redis.zadd(`waiting_room:${eventId}`, Date.now(), customerStr);
  }

  // Get their position
  const position = await redis.zrank(`waiting_room:${eventId}`, customerStr);
  const totalInQueue = await redis.zcard(`waiting_room:${eventId}`);

  return {
    admitted: false,
    position: (position !== null ? position + 1 : totalInQueue), // 1-based
    totalInQueue,
  };
}


// ============================================================
// getPosition(eventId, customerId)
// ============================================================
// Returns current queue status for polling.
// If admitted in the meantime, returns { admitted: true }.
// ============================================================
async function getPosition(eventId, customerId) {
  const customerStr = String(customerId);

  // Check if admitted
  const isAdmitted = await redis.sismember(`admitted:${eventId}`, customerStr);
  if (isAdmitted) {
    return { admitted: true };
  }

  // Check queue position
  const position = await redis.zrank(`waiting_room:${eventId}`, customerStr);
  if (position === null) {
    // Not in queue and not admitted — try to admit
    return tryAdmit(eventId, customerId);
  }

  const totalInQueue = await redis.zcard(`waiting_room:${eventId}`);

  return {
    admitted: false,
    position: position + 1, // 1-based
    totalInQueue,
  };
}


// ============================================================
// releaseSlot(eventId, customerId)
// ============================================================
// Called when a customer finishes buying (payment success/fail)
// or their admitted TTL expires. Removes them from the admitted
// set and admits the next person from the queue.
// ============================================================
async function releaseSlot(eventId, customerId) {
  const customerStr = String(customerId);

  // Remove from admitted set
  await redis.srem(`admitted:${eventId}`, customerStr);
  await redis.del(`admitted_ttl:${eventId}:${customerStr}`);

  // Also remove from queue if they were there
  await redis.zrem(`waiting_room:${eventId}`, customerStr);

  // Admit the next person from the queue
  const next = await redis.zrange(`waiting_room:${eventId}`, 0, 0);
  if (next && next.length > 0) {
    const nextCustomer = next[0];
    await redis.zrem(`waiting_room:${eventId}`, nextCustomer);
    await redis.sadd(`admitted:${eventId}`, nextCustomer);
    await redis.set(`admitted_ttl:${eventId}:${nextCustomer}`, '1', 'EX', ADMITTED_TTL);
  }

  return { released: true };
}


// ============================================================
// isAdmitted(eventId, customerId)
// ============================================================
// Quick check — used by seat lock endpoint to verify the
// customer is admitted before allowing seat selection.
// ============================================================
async function isAdmitted(eventId, customerId) {
  const result = await redis.sismember(`admitted:${eventId}`, String(customerId));
  return !!result;
}


module.exports = {
  tryAdmit,
  getPosition,
  releaseSlot,
  isAdmitted,
  setThreshold,
  getThreshold,
  DEFAULT_THRESHOLD,
};
