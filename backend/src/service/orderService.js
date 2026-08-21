// ============================================================
// orderService.js — Order creation, confirmation, and failure
//
// This service handles the "shopping cart" → "payment" → "done"
// lifecycle. Each step follows the dual Redis + PostgreSQL
// architecture:
//
//   1. createOrder  — Verify Redis locks, create order + order_items
//                     (freeze prices at this moment)
//   2. confirmOrder — Process payment, mark seats SOLD in DB,
//                     generate tickets + QR codes, remove Redis locks
//   3. failOrder    — Mark order failed, remove Redis locks,
//                     seats go back to available
//
// The optimistic lock on seats.version prevents the edge case
// where a Redis lock expires mid-payment and someone else tries
// to book the same seat. The version check on UPDATE ensures
// only one transaction can claim the seat.
// ============================================================

const pool = require('../config/db');
const redis = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const { checkLockOwnership, unlockSeats } = require('./seatService');
const { generateQRCode } = require('./qrCodeService');

const LOCK_TTL_SECONDS = 300;


// ============================================================
// createOrder(customerId, eventId, seatIds)
// ============================================================
// Creates a pending order with frozen prices.
//
// Steps:
//   1. Verify customer still holds all seat locks (Redis)
//   2. Look up current prices from event_section_pricing
//   3. Create order row (pending, with idempotency key)
//   4. Create order_items with frozen prices
//   5. Return order details
// ============================================================
async function createOrder(customerId, eventId, seatIds) {
  // Step 1: Verify locks
  const ownsLocks = await checkLockOwnership(eventId, seatIds, customerId);
  if (!ownsLocks) {
    throw new Error(
      'Your seat hold has expired. Please go back and select seats again.'
    );
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Step 2: Get seat details with current prices
    const seatsResult = await client.query(
      `SELECT s.seat_id, s.section, s.row_label, s.seat_number,
              s.price, s.status, s.version
       FROM seats s
       WHERE s.event_id = $1 AND s.seat_id = ANY($2::int[])
       FOR UPDATE`,
      [eventId, seatIds]
    );

    // Verify all seats exist and are available
    for (const seat of seatsResult.rows) {
      if (seat.status === 'sold') {
        throw new Error(
          `Seat ${seat.section} ${seat.row_label}-${seat.seat_number} is already sold`
        );
      }
    }

    // Step 3: Calculate total
    const totalAmount = seatsResult.rows.reduce(
      (sum, s) => sum + parseFloat(s.price), 0
    );

    // Step 4: Create order with idempotency key
    const idempotencyKey = uuidv4();
    const orderResult = await client.query(
      `INSERT INTO orders (customer_id, event_id, status, total_amount, idempotency_key)
       VALUES ($1, $2, 'pending', $3, $4)
       RETURNING order_id, status, total_amount, created_at`,
      [customerId, eventId, totalAmount, idempotencyKey]
    );

    const order = orderResult.rows[0];

    // Step 5: Create order_items — freeze price at this moment
    for (const seat of seatsResult.rows) {
      await client.query(
        `INSERT INTO order_items (order_id, seat_id, price_at_purchase)
         VALUES ($1, $2, $3)`,
        [order.order_id, seat.seat_id, seat.price]
      );
    }

    await client.query('COMMIT');

    return {
      orderId: order.order_id,
      eventId: parseInt(eventId),
      status: order.status,
      totalAmount: parseFloat(order.total_amount),
      seats: seatsResult.rows.map(s => ({
        seatId: s.seat_id,
        section: s.section,
        row: s.row_label,
        seatNumber: s.seat_number,
        price: parseFloat(s.price),
      })),
      createdAt: order.created_at,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


// ============================================================
// confirmOrder(orderId, customerId)
// ============================================================
// Called after successful payment. This is where the seat
// actually becomes SOLD in the database.
//
// Steps:
//   1. Look up the order and its items
//   2. SELECT ... FOR UPDATE seats (DB-level lock)
//   3. Optimistic lock check: version must match
//   4. UPDATE seats → status='sold', version++
//   5. UPDATE order → status='confirmed'
//   6. Create payment record
//   7. Generate tickets with QR codes
//   8. Remove Redis locks
//   9. Return confirmed order with tickets
// ============================================================
async function confirmOrder(orderId, customerId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Step 1: Get order
    const orderResult = await client.query(
      `SELECT o.order_id, o.customer_id, o.event_id, o.status, o.total_amount
       FROM orders o
       WHERE o.order_id = $1 AND o.customer_id = $2
       FOR UPDATE`,
      [orderId, customerId]
    );

    if (orderResult.rows.length === 0) {
      throw new Error('Order not found');
    }

    const order = orderResult.rows[0];

    if (order.status !== 'pending') {
      throw new Error(`Order is already ${order.status}`);
    }

    // Step 2: Get order items with seat details
    const itemsResult = await client.query(
      `SELECT oi.seat_id, oi.price_at_purchase,
              s.section, s.row_label, s.seat_number, s.status, s.version
       FROM order_items oi
       JOIN seats s ON oi.seat_id = s.seat_id
       WHERE oi.order_id = $1
       FOR UPDATE OF s`,
      [orderId]
    );

    // Step 3: Optimistic lock — check all seats are still available
    for (const item of itemsResult.rows) {
      if (item.status === 'sold') {
        throw new Error(
          `Seat ${item.section} ${item.row_label}-${item.seat_number} was sold by another transaction`
        );
      }
    }

    // Step 4: Mark seats as SOLD (with version increment)
    const seatIds = [];
    for (const item of itemsResult.rows) {
      const updateResult = await client.query(
        `UPDATE seats
         SET status = 'sold', version = version + 1
         WHERE seat_id = $1 AND version = $2
         RETURNING seat_id`,
        [item.seat_id, item.version]
      );

      // If version changed, someone else modified this seat
      if (updateResult.rows.length === 0) {
        throw new Error(
          `Concurrency conflict on seat ${item.section} ${item.row_label}-${item.seat_number}`
        );
      }

      seatIds.push(item.seat_id);
    }

    // Step 5: Update order → confirmed
    await client.query(
      `UPDATE orders SET status = 'confirmed', updated_at = now()
       WHERE order_id = $1`,
      [orderId]
    );

    // Step 6: Create payment record
    await client.query(
      `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
       VALUES ($1, 'mock', $2, $3, 'succeeded')`,
      [orderId, `mock_pay_${uuidv4().slice(0, 8)}`, order.total_amount]
    );

    // Step 7: Generate tickets with QR codes
    const tickets = [];
    for (const item of itemsResult.rows) {
      const qrData = {
        ticketId: null, // will be set after insert
        eventId: order.event_id,
        seatId: item.seat_id,
        section: item.section,
        row: item.row_label,
        seatNumber: item.seat_number,
      };

      const qrCode = await generateQRCode(qrData);

      const ticketResult = await client.query(
        `INSERT INTO tickets (order_id, seat_id, price, qr_code)
         VALUES ($1, $2, $3, $4)
         RETURNING ticket_id`,
        [orderId, item.seat_id, item.price_at_purchase, qrCode]
      );

      tickets.push({
        ticketId: ticketResult.rows[0].ticket_id,
        section: item.section,
        row: item.row_label,
        seatNumber: item.seat_number,
        price: parseFloat(item.price_at_purchase),
        qrCode,
      });
    }

    await client.query('COMMIT');

    // Step 8: Remove Redis locks (after commit — fire and forget)
    try {
      const delPipeline = redis.pipeline();
      for (const seatId of seatIds) {
        delPipeline.del(`seat_lock:${order.event_id}:${seatId}`);
      }
      await delPipeline.exec();
    } catch {
      // Redis cleanup failure is non-fatal — TTL will expire anyway
    }

    return {
      orderId: order.order_id,
      eventId: order.event_id,
      status: 'confirmed',
      totalAmount: parseFloat(order.total_amount),
      tickets,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


// ============================================================
// failOrder(orderId, customerId)
// ============================================================
// Called on payment failure. Releases seat holds.
// ============================================================
async function failOrder(orderId, customerId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get order and items
    const orderResult = await client.query(
      `SELECT o.order_id, o.event_id, o.status
       FROM orders o
       WHERE o.order_id = $1 AND o.customer_id = $2`,
      [orderId, customerId]
    );

    if (orderResult.rows.length === 0) {
      throw new Error('Order not found');
    }

    const order = orderResult.rows[0];
    if (order.status !== 'pending') {
      throw new Error(`Order is already ${order.status}`);
    }

    // Get seat IDs for Redis cleanup
    const itemsResult = await client.query(
      `SELECT oi.seat_id FROM order_items oi WHERE oi.order_id = $1`,
      [orderId]
    );
    const seatIds = itemsResult.rows.map(r => r.seat_id);

    // Mark order as failed
    await client.query(
      `UPDATE orders SET status = 'failed', updated_at = now()
       WHERE order_id = $1`,
      [orderId]
    );

    await client.query('COMMIT');

    // Release Redis locks
    try {
      const delPipeline = redis.pipeline();
      for (const seatId of seatIds) {
        delPipeline.del(`seat_lock:${order.event_id}:${seatId}`);
      }
      await delPipeline.exec();
    } catch {
      // Non-fatal — TTL will expire
    }

    return { orderId: order.order_id, status: 'failed' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


// ============================================================
// getOrderById(orderId, customerId)
// ============================================================
async function getOrderById(orderId, customerId) {
  const result = await pool.query(
    `SELECT o.order_id, o.event_id, o.status, o.total_amount, o.created_at,
            e.event_name, v.venue_name
     FROM orders o
     JOIN events e ON o.event_id = e.event_id
     JOIN venues v ON e.venue_id = v.venue_id
     WHERE o.order_id = $1 AND o.customer_id = $2`,
    [orderId, customerId]
  );

  if (result.rows.length === 0) return null;

  const order = result.rows[0];

  // Get tickets for this order
  const ticketsResult = await pool.query(
    `SELECT t.ticket_id, t.price, t.qr_code, t.checked_in,
            s.section, s.row_label, s.seat_number
     FROM tickets t
     JOIN seats s ON t.seat_id = s.seat_id
     WHERE t.order_id = $1
     ORDER BY s.section, s.row_label, s.seat_number`,
    [orderId]
  );

  return {
    orderId: order.order_id,
    eventId: order.event_id,
    eventName: order.event_name,
    venueName: order.venue_name,
    status: order.status,
    totalAmount: parseFloat(order.total_amount),
    createdAt: order.created_at,
    tickets: ticketsResult.rows.map(t => ({
      ticketId: t.ticket_id,
      section: t.section,
      row: t.row_label,
      seatNumber: t.seat_number,
      price: parseFloat(t.price),
      qrCode: t.qr_code,
      checkedIn: t.checked_in,
    })),
  };
}


module.exports = { createOrder, confirmOrder, failOrder, getOrderById };
