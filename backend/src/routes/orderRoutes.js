// ============================================================
// orderRoutes.js — Order creation and Razorpay payment
//
// Payment flow (two-step):
//   1. POST /api/orders → create order + Razorpay order
//      Returns razorpayOrderId for the frontend checkout modal
//   2. POST /api/orders/:orderId/pay → verify Razorpay signature
//      + confirm order (seats → sold, tickets + QR generated)
//
// Endpoints:
//   POST /api/orders                    → Create order + Razorpay order
//   POST /api/orders/:orderId/pay       → Verify payment + confirm
//   POST /api/orders/:orderId/mock-pay  → DEMO ONLY: skip Razorpay
//                                          entirely, confirm the order
//                                          as if payment succeeded.
//   GET  /api/orders/:orderId           → Get order details
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
// Creates a pending order AND a Razorpay order.
// Returns both the app order details and the Razorpay order ID
// that the frontend needs to open the checkout modal.
//
// Body: { eventId: 5, seatIds: [1, 2, 3] }
// ============================================================
router.post('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can create orders' });
    }

    const { eventId, seatIds } = req.body;

    if (!eventId || !seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ message: 'eventId and seatIds array are required' });
    }

    // Step 1: Create the app order (freezes prices)
    const order = await createOrder(req.user.id, eventId, seatIds);

    // Step 2: Create Razorpay order
    const razorpayOrder = await createRazorpayOrder(order.orderId, order.totalAmount);

    res.status(201).json({
      ...order,
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
// Verifies the Razorpay payment and confirms the order.
//
// Body: {
//   razorpay_order_id: '...',
//   razorpay_payment_id: '...',
//   razorpay_signature: '...'
// }
//
// On success: seats → sold, tickets + QR codes generated.
// On failure: seats released, order → failed.
// ============================================================
router.post('/:orderId/pay', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can pay for orders' });
    }

    const { orderId } = req.params;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Step 1: Get order
    const order = await getOrderById(orderId, req.user.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ message: `Order is already ${order.status}` });
    }

    // Step 2: Verify Razorpay payment signature
    const isValid = verifyPayment(razorpay_order_id, razorpay_payment_id, razorpay_signature);

    if (isValid) {
      // Step 3: Confirm order — marks seats sold, generates tickets
      const confirmedOrder = await confirmOrder(orderId, req.user.id);

      // Release waiting room slot so next person can enter
      try { await releaseSlot(order.eventId, req.user.id); } catch { }

      res.json(confirmedOrder);
    } else {
      // Step 3b: Invalid signature — fail order
      await failOrder(orderId, req.user.id);

      // Release waiting room slot
      try { await releaseSlot(order.eventId, req.user.id); } catch { }

      res.status(400).json({ message: 'Payment verification failed' });
    }
  } catch (err) {
    console.error('Error processing payment:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// POST /api/orders/:orderId/mock-pay
// ============================================================
// DEMO-ONLY ENDPOINT. Skips Razorpay entirely — no checkout
// modal, no signature verification, no real (or even test-mode)
// payment gateway call. It just confirms the order directly, as
// if payment had succeeded.
//
// WHY THIS EXISTS SEPARATELY FROM THE `mock` FALLBACK IN
// paymentService.js:
//   paymentService already auto-mocks payment when RAZORPAY_KEY_ID
//   / RAZORPAY_KEY_SECRET aren't set in the environment — but that
//   only helps if you've deliberately left those env vars empty.
//   If real Razorpay keys ARE configured (e.g. you want to keep
//   the real checkout flow working for demo purposes too), the
//   normal /pay endpoint would actually try to verify a real
//   Razorpay signature, which a fake mock response can't produce.
//
//   This endpoint sidesteps that entirely — it's a second,
//   independent "confirm this order" path that never touches
//   Razorpay at all, regardless of whether real keys are
//   configured. This is what lets a portfolio/demo deployment
//   offer BOTH "pay for real via Razorpay test mode" AND "skip
//   payment, just mark it complete" as two separate buttons on
//   the same checkout page.
//
// SECURITY NOTE: this endpoint intentionally has no payment
// verification at all — anyone who can create an order can
// confirm it for free. That's fine for a portfolio project where
// no real money or real inventory is at stake, but this route
// should be removed (or gated behind an admin/dev-only flag)
// before this code is ever used for a real production ticketing
// system with real payments.
// ============================================================
router.post('/:orderId/mock-pay', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can pay for orders' });
    }

    const { orderId } = req.params;

    // Step 1: Get order — also confirms it belongs to this customer
    const order = await getOrderById(orderId, req.user.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ message: `Order is already ${order.status}` });
    }

    // Step 2: Confirm directly — same seats->sold + optimistic
    // locking + ticket/QR generation as the real payment path,
    // just without any Razorpay call in between.
    const confirmedOrder = await confirmOrder(orderId, req.user.id);

    // Release their waiting room slot so the next person can enter,
    // same as the real payment success path does.
    try { await releaseSlot(order.eventId, req.user.id); } catch { }

    res.json(confirmedOrder);
  } catch (err) {
    console.error('Error mock-confirming order:', err);
    res.status(400).json({ message: err.message });
  }
});


// ============================================================
// GET /api/orders/:orderId
// ============================================================
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    const order = await getOrderById(req.params.orderId, req.user.id);
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