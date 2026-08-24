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
const { createOrder, confirmOrder, failOrder, getOrderById } = require('../service/orderService');
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
    } catch {}

    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// GET /api/orders/:orderId
// ============================================================
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    const order = await getOrderById(parseInt(req.params.orderId), req.user.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    res.json(order);
  } catch (err) {
    console.error('Error fetching order:', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;