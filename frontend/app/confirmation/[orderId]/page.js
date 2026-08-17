// ============================================================
// Order Confirmation Page — /confirmation/[orderId] (placeholder)
// Will show ticket + QR code after payment confirmation.
// ============================================================

export default function ConfirmationPage() {
  return (
    <div className="page-container py-20 text-center animate-fade-in">
      <div className="text-5xl mb-4">🎉</div>
      <h1 className="text-2xl font-bold mb-2">Order Confirmation</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        Your ticket and QR code will appear here after payment is confirmed.
      </p>
    </div>
  );
}
