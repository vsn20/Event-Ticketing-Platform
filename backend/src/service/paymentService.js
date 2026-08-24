// ============================================================
// paymentService.js — Razorpay payment integration
//
// Uses Razorpay in TEST mode for payment processing.
// Two-step flow:
//   1. createRazorpayOrder() — creates an order on Razorpay's
//      servers, returns order_id for the frontend checkout
//   2. verifyPayment() — verifies the payment signature after
//      the customer completes payment in the Razorpay modal
//
// TEST MODE:
//   Uses Razorpay test keys. Test cards auto-succeed.
//   No real money is charged.
//
// ENV VARS REQUIRED:
//   RAZORPAY_KEY_ID     — starts with 'rzp_test_'
//   RAZORPAY_KEY_SECRET — from Razorpay dashboard
// ============================================================

const Razorpay = require('razorpay');
const crypto = require('crypto');

let razorpay;

if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log('✅ Razorpay initialized (test mode)');
} else {
  console.warn('⚠️  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — using mock payments');
}


// ============================================================
// createRazorpayOrder(orderId, amount)
// ============================================================
// Creates a Razorpay order. The frontend uses the returned
// razorpay_order_id to open the checkout modal.
//
// Amount is in rupees — Razorpay API wants paise (×100).
// ============================================================
async function createRazorpayOrder(orderId, amount) {
  if (!razorpay) {
    // Fallback mock mode
    return {
      razorpayOrderId: `mock_order_${orderId}_${Date.now()}`,
      amount: amount,
      currency: 'INR',
      mock: true,
    };
  }

  const options = {
    amount: Math.round(amount * 100), // Convert to paise
    currency: 'INR',
    receipt: `order_${orderId}`,
    notes: {
      orderId: String(orderId),
    },
  };

  const razorpayOrder = await razorpay.orders.create(options);

  return {
    razorpayOrderId: razorpayOrder.id,
    amount: amount,
    currency: 'INR',
    mock: false,
  };
}


// ============================================================
// verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature)
// ============================================================
// Verifies the payment signature using HMAC SHA256.
// Razorpay sends: order_id|payment_id signed with your secret.
// If the signature matches, the payment is authentic.
// ============================================================
function verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  if (!razorpay) {
    // Mock mode — always valid
    return true;
  }

  // If order was created in mock mode, skip real verification
  if (razorpayOrderId && razorpayOrderId.startsWith('mock_')) {
    return true;
  }

  const body = razorpayOrderId + '|' + razorpayPaymentId;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  return expectedSignature === razorpaySignature;
}


module.exports = { createRazorpayOrder, verifyPayment };
