// ============================================================
// Seat Map Page — /events/[id]/seats (placeholder)
// Will show the interactive seat map with real-time locking.
// ============================================================

export default function SeatMapPage() {
  return (
    <div className="page-container py-20 text-center animate-fade-in">
      <div className="text-5xl mb-4">💺</div>
      <h1 className="text-2xl font-bold mb-2">Seat Map</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        The interactive seat map will be available once Redis seat locking is implemented.
      </p>
    </div>
  );
}
