// ============================================================
// Checkout Page — /checkout (placeholder)
//
// This page will be built in Phase B when the order and
// Stripe payment services are implemented. For now it shows
// a "coming soon" message.
// ============================================================

export default function CheckoutPage() {
  return (
    <div className="page-container py-20 text-center animate-fade-in">
      <div className="text-5xl mb-4">🛒</div>
      <h1 className="text-2xl font-bold mb-2">Checkout</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        This page will be available once seat locking and payment services are built.
      </p>
    </div>
  );
}
