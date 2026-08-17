// ============================================================
// Waiting Room Page — /events/[id]/waiting-room (placeholder)
// Will show queue position and estimated wait time.
// ============================================================

export default function WaitingRoomPage() {
  return (
    <div className="page-container py-20 text-center animate-fade-in">
      <div className="text-5xl mb-4">⏳</div>
      <h1 className="text-2xl font-bold mb-2">Waiting Room</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        The waiting room queue will be available once Redis and WebSocket services are built.
      </p>
    </div>
  );
}
