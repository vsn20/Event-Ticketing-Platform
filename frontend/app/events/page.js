// ============================================================
// Events Listing Page — /events
//
// The main browsing page for customers. Shows all published
// events in a grid of EventCard components.
//
// Features:
//   - Fetches events from GET /api/events on page load
//   - Filter buttons for category (Music, Sports, Conference, etc.)
//   - Search by city
//   - Shows loading state while fetching
//   - Shows empty state if no events match the filters
//
// API called: GET /api/events?status=published&city=X&category=Y
// ============================================================

'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';
import EventCard from '@/app/components/EventCard';

// Predefined categories for the filter buttons.
// These match what organizers can set when creating events.
const CATEGORIES = ['All', 'Music', 'Sports', 'Conference', 'Comedy', 'Theatre', 'Festival'];

export default function EventsPage() {
  const { user, loading: authLoading } = useAuth();

  // Data state
  const [events, setEvents] = useState([]);

  // Filter state
  const [category, setCategory] = useState('All');
  const [city, setCity] = useState('');

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // ----------------------------------------------------------
  // Fetch events whenever filters change.
  //
  // useEffect runs after every render where [category, city, authLoading]
  // changed. The authLoading check ensures we don't fire the
  // API call before the auth token is loaded from localStorage
  // (which would result in a 401 error).
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading) return; // Wait for auth to initialize

    async function fetchEvents() {
      setLoading(true);
      setError('');

      try {
        // Build query string from active filters.
        // We always filter to published/live events for customers.
        const params = new URLSearchParams();
        params.set('status', 'published');

        if (category !== 'All') {
          params.set('category', category);
        }

        if (city.trim()) {
          params.set('city', city.trim());
        }

        const data = await api.get(`/events?${params.toString()}`);
        setEvents(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchEvents();
  }, [category, city, authLoading]);

  return (
    <div className="page-container py-8 animate-fade-in">

      {/* ---- Page Header ---- */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Upcoming Events</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Find and book tickets for live events near you
        </p>
      </div>

      {/* ---- Filters Bar ---- */}
      <div className="flex flex-col sm:flex-row gap-4 mb-8">

        {/* Category filter buttons */}
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className="px-4 py-2 rounded-full text-sm font-medium transition-all"
              style={{
                background: category === cat ? 'var(--color-primary)' : 'var(--bg-surface)',
                color: category === cat ? 'white' : 'var(--text-secondary)',
                border: `1px solid ${category === cat ? 'var(--color-primary)' : 'var(--border-color)'}`,
              }}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* City search input */}
        <input
          type="text"
          className="input max-w-xs"
          placeholder="🔍 Search by city..."
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
      </div>

      {/* ---- Loading State ---- */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <div className="spinner mx-auto mb-4" style={{ width: 40, height: 40 }}></div>
            <p style={{ color: 'var(--text-muted)' }}>Loading events...</p>
          </div>
        </div>
      )}

      {/* ---- Error State ---- */}
      {error && !loading && (
        <div className="error-message max-w-md mx-auto text-center">{error}</div>
      )}

      {/* ---- Empty State ---- */}
      {!loading && !error && events.length === 0 && (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">🎪</div>
          <h3 className="text-xl font-semibold mb-2">No events found</h3>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {category !== 'All' || city
              ? 'Try adjusting your filters or search terms.'
              : 'No published events yet. Check back soon!'}
          </p>
        </div>
      )}

      {/* ---- Events Grid ---- */}
      {!loading && !error && events.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {events.map((event) => (
            <EventCard key={event.event_id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}
