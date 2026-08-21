// ============================================================
// Seat Map Page — /events/[id]/seats
//
// Interactive seat selection with section-first layout:
//   1. Shows a mini stadium overview with sections as blocks
//   2. Tap a section → expands to show individual seat grid
//   3. Seat colors: white=available, grey=booked, blue=selected
//   4. Bottom bar shows selected count + total + "Proceed" button
//   5. "Proceed" locks seats in Redis (5 min) → redirects to checkout
//
// API calls:
//   GET  /api/events/:eventId/seats      → fetch seat map
//   POST /api/events/:eventId/seats/lock → lock selected seats
// ============================================================

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

export default function SeatMapPage() {
  const params = useParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const eventId = params.id;

  // Data
  const [event, setEvent] = useState(null);
  const [sections, setSections] = useState([]);
  const [selectedSeats, setSelectedSeats] = useState([]); // [{seat_id, section, row, seatNumber, price}]
  const [expandedSection, setExpandedSection] = useState(null);

  // UI
  const [loading, setLoading] = useState(true);
  const [locking, setLocking] = useState(false);
  const [error, setError] = useState('');

  // ----------------------------------------------------------
  // Fetch event details and seat map
  // ----------------------------------------------------------
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [eventData, seatData] = await Promise.all([
        api.get(`/events/${eventId}`),
        api.get(`/events/${eventId}/seats`),
      ]);
      setEvent(eventData);
      setSections(seatData.sections || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    if (!authLoading) fetchData();
  }, [authLoading, fetchData]);

  // ----------------------------------------------------------
  // Toggle seat selection
  // ----------------------------------------------------------
  function toggleSeat(seat, sectionName, rowLabel, price) {
    if (seat.status === 'sold' || (seat.status === 'held' && !seat.held_by_me)) {
      return; // Can't select booked/held seats
    }

    setSelectedSeats(prev => {
      const exists = prev.find(s => s.seat_id === seat.seat_id);
      if (exists) {
        // Deselect
        return prev.filter(s => s.seat_id !== seat.seat_id);
      } else {
        // Select (max 10)
        if (prev.length >= 10) return prev;
        return [...prev, {
          seat_id: seat.seat_id,
          section: sectionName,
          row: rowLabel,
          seatNumber: seat.seat_number,
          price,
        }];
      }
    });
  }

  // ----------------------------------------------------------
  // Lock seats and proceed to checkout
  // ----------------------------------------------------------
  async function handleProceed() {
    if (selectedSeats.length === 0) return;

    try {
      setLocking(true);
      setError('');

      const seatIds = selectedSeats.map(s => s.seat_id);
      await api.post(`/events/${eventId}/seats/lock`, { seatIds });

      // Store selected seats info in sessionStorage for checkout page
      sessionStorage.setItem('checkout_data', JSON.stringify({
        eventId,
        eventName: event?.event_name,
        venueName: event?.venue_name,
        seats: selectedSeats,
        lockedAt: Date.now(),
      }));

      router.push('/checkout');
    } catch (err) {
      setError(err.message);
      // Refresh seat map to show updated status
      fetchData();
    } finally {
      setLocking(false);
    }
  }

  // ----------------------------------------------------------
  // Helper: get seat color
  // ----------------------------------------------------------
  function getSeatStyle(seat) {
    const isSelected = selectedSeats.some(s => s.seat_id === seat.seat_id);

    if (isSelected || (seat.status === 'held' && seat.held_by_me)) {
      return {
        background: '#6366f1', // Indigo — selected by me
        color: 'white',
        cursor: 'pointer',
        border: '2px solid #4f46e5',
      };
    }
    if (seat.status === 'sold' || seat.status === 'held') {
      return {
        background: '#d1d5db', // Grey — booked/held by others
        color: '#9ca3af',
        cursor: 'not-allowed',
        border: '2px solid #d1d5db',
      };
    }
    return {
      background: 'white', // White — available
      color: '#374151',
      cursor: 'pointer',
      border: '2px solid #e5e7eb',
    };
  }

  // ----------------------------------------------------------
  // Section stats
  // ----------------------------------------------------------
  function getSectionStats(section) {
    let total = 0, available = 0;
    for (const row of section.rows) {
      for (const seat of row.seats) {
        total++;
        if (seat.status === 'available') available++;
      }
    }
    return { total, available };
  }

  // ----------------------------------------------------------
  // Total price
  // ----------------------------------------------------------
  const totalPrice = selectedSeats.reduce((sum, s) => sum + s.price, 0);

  // ----------------------------------------------------------
  // RENDER
  // ----------------------------------------------------------
  if (loading) {
    return (
      <div className="page-container py-20 text-center">
        <div className="spinner mx-auto mb-4" style={{ width: 40, height: 40 }}></div>
        <p style={{ color: 'var(--text-muted)' }}>Loading seat map...</p>
      </div>
    );
  }

  if (error && !sections.length) {
    return (
      <div className="page-container py-20 text-center">
        <div className="text-5xl mb-4">😕</div>
        <h2 className="text-xl font-semibold mb-2">Could not load seats</h2>
        <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>{error}</p>
        <Link href={`/events/${eventId}`} className="btn-primary no-underline">Back to Event</Link>
      </div>
    );
  }

  return (
    <div className="page-container py-8 animate-fade-in" style={{ paddingBottom: selectedSeats.length > 0 ? 120 : 32 }}>

      {/* ---- Header ---- */}
      <Link href={`/events/${eventId}`} className="text-sm no-underline mb-4 inline-block"
            style={{ color: 'var(--text-secondary)' }}>
        ← Back to Event
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">{event?.event_name}</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {event?.venue_name} · Select your seats
        </p>
      </div>

      {error && <div className="error-message mb-4">{error}</div>}

      {/* ---- Stage Label ---- */}
      <div className="text-center mb-6">
        <div className="inline-block px-12 py-3 rounded-xl text-sm font-bold tracking-widest"
          style={{
            background: 'linear-gradient(135deg, #1e1b4b, #312e81)',
            color: 'white',
            boxShadow: '0 4px 20px rgba(99, 102, 241, 0.3)',
          }}>
          🎭 STAGE
        </div>
      </div>

      {/* ---- Section Blocks ---- */}
      <div className="flex flex-col gap-4 max-w-2xl mx-auto mb-8">
        {sections.map(section => {
          const stats = getSectionStats(section);
          const isExpanded = expandedSection === section.name;

          return (
            <div key={section.name}>
              {/* Section Header Block */}
              <button
                onClick={() => setExpandedSection(isExpanded ? null : section.name)}
                className="w-full p-4 rounded-xl transition-all"
                style={{
                  background: isExpanded
                    ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
                    : 'var(--bg-surface)',
                  color: isExpanded ? 'white' : 'var(--text-primary)',
                  border: `2px solid ${isExpanded ? '#6366f1' : 'var(--border-color)'}`,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-bold text-lg">{section.name}</div>
                    <div className="text-sm mt-1" style={{ opacity: 0.8 }}>
                      ₹{section.price.toLocaleString()} · {stats.available}/{stats.total} available
                    </div>
                  </div>
                  <div className="text-2xl">
                    {isExpanded ? '▼' : '▶'}
                  </div>
                </div>
              </button>

              {/* Expanded Seat Grid */}
              {isExpanded && (
                <div className="mt-2 p-4 rounded-xl overflow-x-auto"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>

                  {section.rows.map(row => (
                    <div key={row.label} className="flex items-center gap-2 mb-2">
                      {/* Row Label */}
                      <div className="w-8 text-xs font-bold text-center flex-shrink-0"
                        style={{ color: 'var(--text-muted)' }}>
                        {row.label}
                      </div>

                      {/* Seats */}
                      <div className="flex gap-1.5 flex-wrap">
                        {row.seats.map(seat => (
                          <button
                            key={seat.seat_id}
                            onClick={() => toggleSeat(seat, section.name, row.label, section.price)}
                            className="w-9 h-9 rounded-lg text-xs font-bold flex items-center justify-center transition-all"
                            style={getSeatStyle(seat)}
                            title={`${section.name} ${row.label}-${seat.seat_number}`}
                            disabled={seat.status === 'sold' || (seat.status === 'held' && !seat.held_by_me)}
                          >
                            {seat.seat_number}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}

                  {/* Legend */}
                  <div className="flex gap-4 mt-4 pt-3 text-xs"
                    style={{ borderTop: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                    <div className="flex items-center gap-1.5">
                      <div className="w-4 h-4 rounded" style={{ background: 'white', border: '2px solid #e5e7eb' }}></div>
                      Available
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-4 h-4 rounded" style={{ background: '#6366f1' }}></div>
                      Selected
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-4 h-4 rounded" style={{ background: '#d1d5db' }}></div>
                      Booked
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- Bottom Selection Bar ---- */}
      {selectedSeats.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-50 p-4"
          style={{
            background: 'var(--bg-surface)',
            borderTop: '2px solid var(--border-color)',
            boxShadow: '0 -4px 20px rgba(0,0,0,0.1)',
          }}>
          <div className="max-w-2xl mx-auto flex items-center justify-between">
            <div>
              <div className="font-bold">
                🎫 {selectedSeats.length} seat{selectedSeats.length > 1 ? 's' : ''} selected
              </div>
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Total: ₹{totalPrice.toLocaleString()}
              </div>
            </div>
            <button
              onClick={handleProceed}
              disabled={locking}
              className="btn-primary px-6 py-3 font-bold"
            >
              {locking ? 'Locking seats...' : 'Proceed to Payment →'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
