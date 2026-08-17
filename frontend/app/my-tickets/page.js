// ============================================================
// My Tickets Page — /my-tickets (placeholder)
// Will show all tickets purchased by the logged-in customer.
// ============================================================

export default function MyTicketsPage() {
  return (
    <div className="page-container py-20 text-center animate-fade-in">
      <div className="text-5xl mb-4">🎫</div>
      <h1 className="text-2xl font-bold mb-2">My Tickets</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        Your purchased tickets will appear here once the booking flow is implemented.
      </p>
    </div>
  );
}
