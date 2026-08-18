// ============================================================
// Events Listing Page — /events
//
// The main browsing page for customers. Shows all published
// events in a grid of EventCard components.
//
// Features:
//   - Fetches events from GET /api/events on page load
//   - Filter buttons for category (Music, Sports, Conference, etc.)
//   - City filter DROPDOWN (fed by GET /api/cities), defaulting
//     to the logged-in customer's own default city
//   - Shows loading state while fetching
//   - Shows empty state if no events match the filters
//
// API called: GET /api/events?status=published&cityId=X&category=Y
//
// CITY FILTER DEFAULT BEHAVIOR:
//   The first time this page loads for a logged-in customer, the
//   city dropdown is pre-set to `user.defaultCityId` (the city
//   they picked at signup, returned on every login). This is what
//   "by default filtering should be based on the address" means
//   in practice — the customer sees events near them immediately,
//   without touching any filter. They can then freely change the
//   dropdown to "All" or any other city for that session; we
//   don't overwrite their choice again once they've changed it.
// ============================================================

'use client';

import { useState, useEffect, useRef } from 'react';
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

  // City dropdown data — fetched once from the public /api/cities
  // endpoint, same as the signup page.
  const [cities, setCities] = useState([]);

  // Filter state.
  // cityId starts as 'all' (no filter) until we know the logged-in
  // customer's default city — see the effect below that sets it
  // the FIRST time `user` becomes available.
  const [category, setCategory] = useState('All');
  const [cityId, setCityId] = useState('all');

  // Tracks whether we've already applied the customer's default
  // city once, so we don't keep resetting their manual dropdown
  // choice back to their home city on every re-render.
  const didApplyDefaultCity = useRef(false);

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // ----------------------------------------------------------
  // Fetch the city dropdown options once on mount.
  // ----------------------------------------------------------
  useEffect(() => {
    async function fetchCities() {
      try {
        const data = await api.get('/cities');
        setCities(data);
      } catch {
        // Non-fatal — the "All" option and category filters still work
        // even if the city dropdown fails to load.
      }
    }

    fetchCities();
  }, []);

  // ----------------------------------------------------------
  // Apply the logged-in customer's default city to the filter,
  // but ONLY ONCE — the first time `user` becomes available after
  // auth finishes loading. Using a ref (didApplyDefaultCity)
  // instead of a plain state check prevents this from firing
  // again and clobbering the dropdown if the customer manually
  // switches to a different city afterward.
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading) return;

    if (user?.defaultCityId && !didApplyDefaultCity.current) {
      setCityId(String(user.defaultCityId));
      didApplyDefaultCity.current = true;
    }
  }, [user, authLoading]);

  // ----------------------------------------------------------
  // Fetch events whenever filters change.
  //
  // useEffect runs after every render where [category, cityId,
  // authLoading] changed. The authLoading check ensures we don't
  // fire the API call before the auth token is loaded from
  // localStorage (which would result in a 401 error).
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

        // 'all' means "don't filter by city" — we simply omit the
        // param, same effect as the backend's explicit "all" handling.
        if (cityId && cityId !== 'all') {
          params.set('cityId', cityId);
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
  }, [category, cityId, authLoading]);

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

        {/* City filter dropdown. 'all' shows events in every city;
            defaults to the logged-in customer's own city (see the
            effect above), and the customer is free to change it. */}
        <select
          className="input max-w-xs"
          value={cityId}
          onChange={(e) => setCityId(e.target.value)}
        >
          <option value="all">All Cities</option>
          {cities.map((c) => (
            <option key={c.city_id} value={c.city_id}>
              {c.city_name}
            </option>
          ))}
        </select>
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
            {category !== 'All' || cityId !== 'all'
              ? 'Try adjusting your filters.'
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
