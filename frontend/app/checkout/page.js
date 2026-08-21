// ============================================================
// Checkout Page — /checkout
//
// Shows order summary with a 5-minute countdown timer.
// "Pay Now" opens the Razorpay checkout modal.
//
// On payment success → redirect to /confirmation/:orderId
// On timeout (5 min) → redirect back to /events/:eventId
//
// Reads checkout data from sessionStorage (set by seat map).
// ============================================================

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function CheckoutPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [checkoutData, setCheckoutData] = useState(null);
  const [order, setOrder] = useState(null); // includes razorpayOrderId
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [timeLeft, setTimeLeft] = useState(300); // 5 minutes
  const timerRef = useRef(null);
  const razorpayLoaded = useRef(false);

  // ----------------------------------------------------------
  // Load Razorpay checkout script
  // ----------------------------------------------------------
  useEffect(() => {
    if (razorpayLoaded.current) return;

    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => { razorpayLoaded.current = true; };
    document.body.appendChild(script);

    return () => {
      // Don't remove — it's fine to keep loaded
    };
  }, []);

  // ----------------------------------------------------------
  // Load checkout data from sessionStorage
  // ----------------------------------------------------------
  useEffect(() => {
    const raw = sessionStorage.getItem('checkout_data');
    if (!raw) {
      setError('No checkout data found. Please select seats first.');
      return;
    }

    const data = JSON.parse(raw);
    setCheckoutData(data);

    // Calculate remaining lock time
    const elapsed = Math.floor((Date.now() - data.lockedAt) / 1000);
    const remaining = Math.max(0, 300 - elapsed);
    setTimeLeft(remaining);

    if (remaining <= 0) {
      setError('Your seat hold has expired.');
      // Redirect to event page after a short delay
      setTimeout(() => {
        sessionStorage.removeItem('checkout_data');
        router.push(`/events/${data.eventId}`);
      }, 2000);
    }
  }, [router]);

  // ----------------------------------------------------------
  // Create order once we have checkout data
  // ----------------------------------------------------------
  useEffect(() => {
    if (!checkoutData || authLoading || order) return;

    async function createOrder() {
      try {
        const seatIds = checkoutData.seats.map(s => s.seat_id);
        const result = await api.post('/orders', {
          eventId: parseInt(checkoutData.eventId),
          seatIds,
        });
        setOrder(result);
      } catch (err) {
        setError(err.message);
      }
    }

    createOrder();
  }, [checkoutData, authLoading, order]);

  // ----------------------------------------------------------
  // Countdown timer — redirects to event page on expiry
  // ----------------------------------------------------------
  useEffect(() => {
    if (timeLeft <= 0) return;

    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          // Timeout — redirect back to event page
          sessionStorage.removeItem('checkout_data');
          if (checkoutData?.eventId) {
            router.push(`/events/${checkoutData.eventId}`);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [checkoutData, router]);

  // ----------------------------------------------------------
  // Format time as M:SS
  // ----------------------------------------------------------
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ----------------------------------------------------------
  // Open Razorpay checkout modal
  // ----------------------------------------------------------
  const handlePay = useCallback(() => {
    if (!order || paying) return;

    setPaying(true);
    setError('');

    // If mock mode (no Razorpay keys), simulate payment
    if (order.mock) {
      handlePaymentSuccess({
        razorpay_order_id: order.razorpayOrderId,
        razorpay_payment_id: `mock_pay_${Date.now()}`,
        razorpay_signature: 'mock_signature',
      });
      return;
    }

    const options = {
      key: order.razorpayKeyId,
      amount: Math.round(order.totalAmount * 100), // paise
      currency: order.currency || 'INR',
      name: 'Event Ticketing',
      description: checkoutData?.eventName || 'Ticket Purchase',
      order_id: order.razorpayOrderId,
      handler: function (response) {
        // Payment successful — verify on backend
        handlePaymentSuccess(response);
      },
      modal: {
        ondismiss: function () {
          setPaying(false);
        },
      },
      prefill: {
        name: user?.name || '',
        email: user?.email || '',
      },
      theme: {
        color: '#6366f1',
      },
    };

    const rzp = new window.Razorpay(options);
    rzp.open();
  }, [order, paying, checkoutData, user]);

  // ----------------------------------------------------------
  // Handle successful Razorpay payment
  // ----------------------------------------------------------
  async function handlePaymentSuccess(response) {
    try {
      const result = await api.post(`/orders/${order.orderId}/pay`, {
        razorpay_order_id: response.razorpay_order_id,
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_signature: response.razorpay_signature,
      });

      // Clear checkout data
      sessionStorage.removeItem('checkout_data');
      clearInterval(timerRef.current);

      // Redirect to confirmation page
      router.push(`/confirmation/${order.orderId}`);
    } catch (err) {
      setError(err.message);
      setPaying(false);
    }
  }

  // ----------------------------------------------------------
  // RENDER
  // ----------------------------------------------------------
  if (!checkoutData && !error) {
    return (
      <div className="page-container py-20 text-center">
        <div className="spinner mx-auto mb-4" style={{ width: 40, height: 40 }}></div>
        <p style={{ color: 'var(--text-muted)' }}>Loading checkout...</p>
      </div>
    );
  }

  const totalPrice = checkoutData?.seats?.reduce((sum, s) => sum + s.price, 0) || 0;
  const isExpired = timeLeft <= 0;

  return (
    <div className="page-container py-8 animate-fade-in max-w-xl mx-auto">

      <Link href={checkoutData ? `/events/${checkoutData.eventId}/seats` : '/events'}
            className="text-sm no-underline mb-4 inline-block"
            style={{ color: 'var(--text-secondary)' }}>
        ← Back to Seat Map
      </Link>

      <h1 className="text-2xl font-bold mb-6">Checkout</h1>

      {/* ---- Timer ---- */}
      <div className="p-4 rounded-xl mb-6 text-center"
        style={{
          background: isExpired
            ? 'linear-gradient(135deg, #ef4444, #dc2626)'
            : timeLeft < 60
              ? 'linear-gradient(135deg, #f59e0b, #d97706)'
              : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: 'white',
        }}>
        <div className="text-sm mb-1">
          {isExpired ? '⏰ Seat hold expired — redirecting...' : '⏱️ Seats held for'}
        </div>
        <div className="text-3xl font-bold font-mono">
          {isExpired ? '0:00' : formatTime(timeLeft)}
        </div>
      </div>

      {error && <div className="error-message mb-4">{error}</div>}

      {checkoutData && (
        <>
          {/* ---- Event Info ---- */}
          <div className="card p-5 mb-4">
            <h2 className="text-lg font-bold mb-1">{checkoutData.eventName}</h2>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              📍 {checkoutData.venueName}
            </p>
          </div>

          {/* ---- Selected Seats ---- */}
          <div className="card p-5 mb-4">
            <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--text-muted)' }}>
              SELECTED SEATS
            </h3>
            <div className="flex flex-col gap-2">
              {checkoutData.seats.map(seat => (
                <div key={seat.seat_id}
                  className="flex items-center justify-between p-3 rounded-lg"
                  style={{ background: 'var(--bg-secondary)' }}>
                  <div>
                    <span className="font-medium">{seat.section}</span>
                    <span className="text-sm ml-2" style={{ color: 'var(--text-secondary)' }}>
                      Row {seat.row} · Seat {seat.seatNumber}
                    </span>
                  </div>
                  <span className="font-bold">₹{seat.price.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ---- Total ---- */}
          <div className="card p-5 mb-6">
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold">Total</span>
              <span className="text-2xl font-bold" style={{ color: 'var(--color-primary)' }}>
                ₹{totalPrice.toLocaleString()}
              </span>
            </div>
            <div className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
              {checkoutData.seats.length} ticket{checkoutData.seats.length > 1 ? 's' : ''} · Price includes all taxes
            </div>
          </div>

          {/* ---- Pay Button ---- */}
          <button
            onClick={handlePay}
            disabled={paying || isExpired || !order}
            className="btn-primary w-full py-4 text-lg font-bold"
            style={{ opacity: (paying || isExpired || !order) ? 0.5 : 1 }}
          >
            {paying ? (
              <span className="flex items-center justify-center gap-2">
                <div className="spinner" style={{ width: 20, height: 20 }}></div>
                Processing...
              </span>
            ) : isExpired ? (
              '⏰ Session Expired — Redirecting...'
            ) : (
              `💳 Pay ₹${totalPrice.toLocaleString()} with Razorpay`
            )}
          </button>

          <p className="text-xs text-center mt-3" style={{ color: 'var(--text-muted)' }}>
            Secure payment powered by Razorpay
          </p>
        </>
      )}
    </div>
  );
}
