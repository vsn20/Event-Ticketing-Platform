// ============================================================
// orderRoutes.js — Order + Razorpay payment endpoints
//
// Payment flow (architecture-compliant):
//   1. POST /api/orders → create order + Razorpay order
//   2. POST /api/orders/:orderId/pay → verify Razorpay → finalize
//
// The PG transaction is NEVER open during payment.
// Razorpay completes first, then we finalize atomically.
// ============================================================

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/authMiddleware');
const { createOrder, confirmOrder, failOrder, getOrderById, getConfirmedOrderDetails } = require('../service/orderService');
const { createRazorpayOrder, verifyPayment } = require('../service/paymentService');
const { releaseSlot } = require('../service/waitingRoomService');


// ============================================================
// POST /api/orders
// ============================================================
// Creates a PENDING_PAYMENT order + Razorpay order.
//
// Body: { sessionId, holdId, eventId, seatIds }
// ============================================================
router.post('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can create orders' });
    }

    const { sessionId, holdId, eventId, seatIds } = req.body;

    if (!sessionId || !holdId || !eventId || !seatIds || !Array.isArray(seatIds)) {
      return res.status(400).json({
        message: 'sessionId, holdId, eventId, and seatIds array are required',
      });
    }

    // Step 1: Create app order (frozen prices)
    const order = await createOrder(
      req.user.id,
      parseInt(eventId),
      seatIds,
      holdId,
      sessionId
    );

    // Step 2: Create Razorpay order
    const razorpayOrder = await createRazorpayOrder(order.orderId, order.totalAmount);

    res.status(201).json({
      orderId: order.orderId,
      totalAmount: order.totalAmount,
      razorpayOrderId: razorpayOrder.razorpayOrderId,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || 'mock_key',
      currency: razorpayOrder.currency,
      mock: razorpayOrder.mock,
    });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(400).json({ message: err.message });
  }
});


// ============================================================
// POST /api/orders/:orderId/pay
// ============================================================
// Razorpay payment completed → verify signature → finalize.
//
// This is where the entire finalization happens:
//   1. Verify Razorpay payment signature
//   2. confirmOrder() handles:
//      → Lua: HELD → FINALIZING
//      → Short PG TX: seats → BOOKED, tickets created
//      → Redis: FINALIZING → BOOKED
//
// Idempotent: duplicate callbacks return existing booking.
// ============================================================
router.post('/:orderId/pay', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can pay for orders' });
    }

    const { orderId } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Step 1: Verify Razorpay payment signature
    const isValid = verifyPayment(razorpay_order_id, razorpay_payment_id, razorpay_signature);

    if (!isValid) {
      // Invalid signature — fail order
      await failOrder(parseInt(orderId), req.user.id);
      // Release waiting room slot
      try {
        const order = await getOrderById(parseInt(orderId), req.user.id);
        if (order) await releaseSlot(order.eventId, req.user.id);
      } catch {}
      return res.status(400).json({ message: 'Payment verification failed' });
    }

    // Step 2: Confirm order (Lua → PG TX → Redis BOOKED)
    // This is idempotent — if already confirmed, returns existing booking
    const confirmedOrder = await confirmOrder(parseInt(orderId), req.user.id);

    // Release waiting room slot
    try { await releaseSlot(confirmedOrder.eventId, req.user.id); } catch {}

    // Step 3: Record payment in PostgreSQL
    const pool = require('../config/db');
    await pool.query(
      `INSERT INTO payments (order_id, provider, provider_payment_id, amount, status)
       VALUES ($1, 'razorpay', $2, $3, 'succeeded')
       ON CONFLICT DO NOTHING`,
      [parseInt(orderId), razorpay_payment_id, confirmedOrder.totalAmount]
    );

    res.json(confirmedOrder);
  } catch (err) {
    console.error('Error processing payment:', err);

    // If finalization fails, try to fail the order cleanly
    try {
      await failOrder(parseInt(req.params.orderId), req.user.id);
      const order = await getOrderById(parseInt(req.params.orderId), req.user.id);
      if (order) await releaseSlot(order.event_id || order.eventId, req.user.id);
    } catch {}

    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// GET /api/orders/:orderId
// ============================================================
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    // First check basic order info
    const order = await getOrderById(parseInt(req.params.orderId), req.user.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // For confirmed orders, return full details with tickets
    if (order.status === 'confirmed') {
      const fullOrder = await getConfirmedOrderDetails(parseInt(req.params.orderId));
      return res.json(fullOrder);
    }

    res.json(order);
  } catch (err) {
    console.error('Error fetching order:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// POST /api/orders/:orderId/cancel
// ============================================================
// Called when the payment timer expires or user abandons.
// Releases Redis holds (seats → AVAILABLE) and marks
// the order as FAILED in PostgreSQL.
// ============================================================
router.post('/:orderId/cancel', authenticate, async (req, res) => {
  try {
    console.log(`🔴 CANCEL called for order ${req.params.orderId} by user ${req.user.id}`);
    const result = await failOrder(parseInt(req.params.orderId), req.user.id);
    console.log(`🔴 CANCEL failOrder result:`, result);

    // Release waiting room slot
    try {
      const order = await getOrderById(parseInt(req.params.orderId), req.user.id);
      if (order) await releaseSlot(order.event_id || order.eventId, req.user.id);
    } catch {}

    // Broadcast seat releases via WebSocket
    try {
      const { broadcastMultiSeatUpdate } = require('../ws/seatBroadcast');
      const pool = require('../config/db');
      const items = await pool.query(
        `SELECT s.seat_id, o.event_id
         FROM order_items oi
         JOIN seats s ON oi.seat_id = s.seat_id
         JOIN orders o ON oi.order_id = o.order_id
         WHERE oi.order_id = $1`,
        [parseInt(req.params.orderId)]
      );
      if (items.rows.length > 0) {
        const eventId = items.rows[0].event_id;
        const seatIds = items.rows.map(r => r.seat_id);
        console.log(`🔴 CANCEL broadcasting SEAT_AVAILABLE for seats:`, seatIds, 'event:', eventId);
        broadcastMultiSeatUpdate(eventId, 'SEAT_AVAILABLE', seatIds);
      }
    } catch {}

    res.json(result);
  } catch (err) {
    console.error('Error cancelling order:', err);
    res.status(500).json({ message: err.message });
  }
});

// ============================================================
// POST /api/orders/:orderId/cancel-beacon
// ============================================================
// Same as /cancel but accepts JWT in the body instead of
// the Authorization header. Used by navigator.sendBeacon()
// which cannot set custom headers.
// ============================================================
router.post('/:orderId/cancel-beacon', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(401).json({ message: 'No token' });

    // Verify JWT manually
    const jwt = require('jsonwebtoken');
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Invalid token' });
    }

    const result = await failOrder(parseInt(req.params.orderId), decoded.userId);

    // Broadcast seat releases via WebSocket
    try {
      const { broadcastMultiSeatUpdate } = require('../ws/seatBroadcast');
      const pool = require('../config/db');
      const items = await pool.query(
        `SELECT s.seat_id, o.event_id
         FROM order_items oi
         JOIN seats s ON oi.seat_id = s.seat_id
         JOIN orders o ON oi.order_id = o.order_id
         WHERE oi.order_id = $1`,
        [parseInt(req.params.orderId)]
      );
      if (items.rows.length > 0) {
        const eventId = items.rows[0].event_id;
        const seatIds = items.rows.map(r => r.seat_id);
        broadcastMultiSeatUpdate(eventId, 'SEAT_AVAILABLE', seatIds);
      }
    } catch {}

    res.json(result);
  } catch (err) {
    console.error('Error cancelling order (beacon):', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;