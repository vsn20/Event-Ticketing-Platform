// ============================================================
// Create Event Page — /organizer/events/create
//
// A multi-step form for organizers to:
//   Step 1: Select an existing venue OR create a new one
//   Step 2: Fill in event details (name, dates, category)
//   Step 3: Review and submit
//
// This page connects to TWO backend endpoints:
//   - POST /api/venues (to create a new venue if needed)
//   - POST /api/events (to create the event as a draft)
//
// After creating the event, the organizer is redirected to
// the event management page where they can publish it.
// ============================================================

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/context/AuthContext';
import api from '@/app/lib/api';

// Pre-defined categories for the dropdown
const CATEGORIES = ['Music', 'Sports', 'Conference', 'Comedy', 'Theatre', 'Festival', 'Other'];

export default function CreateEventPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  // ----------------------------------------------------------
  // VENUE STATE
  // The organizer can either pick an existing venue or create
  // a new one. venueMode toggles which form is shown.
  // ----------------------------------------------------------
  const [venueMode, setVenueMode] = useState('select'); // 'select' or 'create'
  const [venues, setVenues] = useState([]);
  const [selectedVenueId, setSelectedVenueId] = useState('');

  // Cities dropdown data — used both to show each existing venue's
  // city in the "select" list, and to populate the city dropdown
  // in the "create new venue" form below.
  const [cities, setCities] = useState([]);

  // New venue form fields.
  // venueCityId replaces the old free-text venueCity — it's the
  // selected <option> value from a dropdown fed by GET /api/cities
  // (fetched below), matching the backend's city_id foreign key.
  const [venueName, setVenueName] = useState('');
  const [venueAddress, setVenueAddress] = useState('');
  const [venueCityId, setVenueCityId] = useState('');
  const [venueSections, setVenueSections] = useState([
    // Start with one section by default. The organizer can add more.
    { name: 'General', rows: 'A,B,C', seatsPerRow: 20, defaultPrice: 50 },
  ]);

  // ----------------------------------------------------------
  // EVENT STATE
  // ----------------------------------------------------------
  const [eventName, setEventName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [saleWindowStart, setSaleWindowStart] = useState('');
  const [saleWindowEnd, setSaleWindowEnd] = useState('');

  // Buffer hours — how long before and after the event the venue
  // should be blocked (for setup/teardown/cleaning etc.)
  const [bufferHoursBefore, setBufferHoursBefore] = useState(2);
  const [bufferHoursAfter, setBufferHoursAfter] = useState(2);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [venuesLoading, setVenuesLoading] = useState(true);

  // ----------------------------------------------------------
  // Redirect non-organizers
  // ----------------------------------------------------------
  useEffect(() => {
    if (!authLoading && (!user || user.role !== 'organizer')) {
      router.push('/organizer/login');
    }
  }, [user, authLoading, router]);

  // ----------------------------------------------------------
  // Fetch existing venues for the dropdown
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading || !user) return;

    async function fetchVenues() {
      try {
        const data = await api.get('/venues');
        setVenues(data);
      } catch (err) {
        console.error('Failed to load venues:', err);
      } finally {
        setVenuesLoading(false);
      }
    }

    fetchVenues();
  }, [authLoading, user]);

  // ----------------------------------------------------------
  // Fetch the list of cities for the venue-creation dropdown.
  // Public endpoint, but we still wait for auth to settle first
  // just to keep this effect's timing consistent with the others
  // on this page.
  // ----------------------------------------------------------
  useEffect(() => {
    if (authLoading || !user) return;

    async function fetchCities() {
      try {
        const data = await api.get('/cities');
        setCities(data);
      } catch (err) {
        console.error('Failed to load cities:', err);
      }
    }

    fetchCities();
  }, [authLoading, user]);

  // ----------------------------------------------------------
  // addSection — adds a new empty section to the venue form
  // ----------------------------------------------------------
  function addSection() {
    setVenueSections([
      ...venueSections,
      { name: '', rows: '', seatsPerRow: 10, defaultPrice: 0 },
    ]);
  }

  // ----------------------------------------------------------
  // removeSection — removes a section by index
  // ----------------------------------------------------------
  function removeSection(index) {
    setVenueSections(venueSections.filter((_, i) => i !== index));
  }

  // ----------------------------------------------------------
  // updateSection — updates a field in a specific section
  // ----------------------------------------------------------
  function updateSection(index, field, value) {
    const updated = [...venueSections];
    updated[index] = { ...updated[index], [field]: value };
    setVenueSections(updated);
  }

  // ----------------------------------------------------------
  // handleSubmit — creates the venue (if new) and then the event
  // ----------------------------------------------------------
  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let venueId = selectedVenueId;

      // ---- Step 1: Create venue if in "create" mode ----
      if (venueMode === 'create') {
        // Convert the section form data into the seat_layout_json format
        // that the backend expects.
        const seatLayoutJson = {
          sections: venueSections.map((s) => ({
            name: s.name,
            // Convert comma-separated row string "A,B,C" into array ["A","B","C"]
            rows: s.rows.split(',').map((r) => r.trim()).filter(Boolean),
            seats_per_row: parseInt(s.seatsPerRow) || 10,
            default_price: parseFloat(s.defaultPrice) || 0,
          })),
        };

        // cityId is required by the backend (see venueController.js
        // validation) — there's no "undefined" fallback here the
        // way there is for the optional address field.
        const venueData = await api.post('/venues', {
          name: venueName,
          address: venueAddress || undefined,
          cityId: venueCityId,
          seatLayoutJson: seatLayoutJson,
        });

        venueId = venueData.venue_id;
      }

      if (!venueId) {
        setError('Please select or create a venue.');
        setLoading(false);
        return;
      }

      // ---- Step 2: Create the event as a draft ----
      const eventData = await api.post('/events', {
        venueId: parseInt(venueId),
        name: eventName,
        description: description || undefined,
        category: category || undefined,
        startTime,
        endTime,
        saleWindowStart: saleWindowStart || undefined,
        saleWindowEnd: saleWindowEnd || undefined,
        bufferHoursBefore: parseFloat(bufferHoursBefore) || 2,
        bufferHoursAfter: parseFloat(bufferHoursAfter) || 2,
      });

      // Redirect to the event management page where they can publish
      router.push(`/organizer/events/${eventData.event_id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (authLoading || !user || user.role !== 'organizer') return null;

  return (
    <div className="page-container py-8 animate-fade-in">
      <h1 className="text-3xl font-bold mb-2">Create New Event</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
        Set up your venue and event details. You can publish and set pricing later.
      </p>

      <form onSubmit={handleSubmit} className="max-w-2xl">

        {/* ============================================================
            SECTION 1: VENUE SELECTION
            ============================================================ */}
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-lg font-semibold mb-4">📍 Venue</h2>

          {/* Toggle between select/create */}
          <div className="flex rounded-lg overflow-hidden mb-5"
            style={{ border: '1px solid var(--border-color)' }}>
            <button type="button"
              onClick={() => setVenueMode('select')}
              className="flex-1 py-2.5 text-sm font-medium transition-all"
              style={{
                background: venueMode === 'select' ? 'var(--color-primary)' : 'transparent',
                color: venueMode === 'select' ? 'white' : 'var(--text-secondary)',
              }}>
              Select Existing
            </button>
            <button type="button"
              onClick={() => setVenueMode('create')}
              className="flex-1 py-2.5 text-sm font-medium transition-all"
              style={{
                background: venueMode === 'create' ? 'var(--color-primary)' : 'transparent',
                color: venueMode === 'create' ? 'white' : 'var(--text-secondary)',
              }}>
              Create New
            </button>
          </div>

          {/* ---- SELECT existing venue ---- */}
          {venueMode === 'select' && (
            <div>
              {venuesLoading ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading venues...</p>
              ) : venues.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  No venues yet. Switch to &quot;Create New&quot; to add one.
                </p>
              ) : (
                <div>
                  <label className="label">Select a venue</label>
                  <select
                    className="input"
                    value={selectedVenueId}
                    onChange={(e) => setSelectedVenueId(e.target.value)}
                    required={venueMode === 'select'}
                  >
                    <option value="">Choose a venue...</option>
                    {venues.map((v) => (
                      <option key={v.venue_id} value={v.venue_id}>
                        {/* v.city_name comes from the backend's JOIN
                            to the cities table (see venueService.js) */}
                        {v.venue_name} — {v.city_name || 'No city'} ({v.total_capacity || '?'} seats)
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* ---- CREATE new venue ---- */}
          {venueMode === 'create' && (
            <div className="flex flex-col gap-4">
              <div>
                <label className="label">Venue Name</label>
                <input type="text" className="input" placeholder="Bangalore Indoor Stadium"
                  value={venueName} onChange={(e) => setVenueName(e.target.value)} required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Address <span style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
                  <input type="text" className="input" placeholder="123 Stadium Road"
                    value={venueAddress} onChange={(e) => setVenueAddress(e.target.value)} />
                </div>
                <div>
                  <label className="label">City</label>
                  {/* Required dropdown, not free text — matches the
                      backend's city_id foreign key (migration 003).
                      Options come from GET /api/cities, fetched above. */}
                  <select className="input" value={venueCityId}
                    onChange={(e) => setVenueCityId(e.target.value)} required>
                    <option value="" disabled>Select a city</option>
                    {cities.map((c) => (
                      <option key={c.city_id} value={c.city_id}>
                        {c.city_name}{c.state ? `, ${c.state}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Sections builder */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="label mb-0">Seating Sections</label>
                  <button type="button" onClick={addSection}
                    className="text-xs font-medium px-3 py-1 rounded-full"
                    style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>
                    + Add Section
                  </button>
                </div>

                {venueSections.map((section, i) => (
                  <div key={i} className="p-4 rounded-lg mb-3"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' }}>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-medium">Section {i + 1}</span>
                      {venueSections.length > 1 && (
                        <button type="button" onClick={() => removeSection(i)}
                          className="text-xs" style={{ color: 'var(--color-error)' }}>
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="label text-xs">Section Name</label>
                        <input type="text" className="input text-sm py-2" placeholder="VIP"
                          value={section.name}
                          onChange={(e) => updateSection(i, 'name', e.target.value)} required />
                      </div>
                      <div>
                        <label className="label text-xs">Rows (comma-separated)</label>
                        <input type="text" className="input text-sm py-2" placeholder="A,B,C"
                          value={section.rows}
                          onChange={(e) => updateSection(i, 'rows', e.target.value)} required />
                      </div>
                      <div>
                        <label className="label text-xs">Seats per Row</label>
                        <input type="number" className="input text-sm py-2" min="1"
                          value={section.seatsPerRow}
                          onChange={(e) => updateSection(i, 'seatsPerRow', e.target.value)} required />
                      </div>
                      <div>
                        <label className="label text-xs">Default Price (₹)</label>
                        <input type="number" className="input text-sm py-2" min="0" step="0.01"
                          value={section.defaultPrice}
                          onChange={(e) => updateSection(i, 'defaultPrice', e.target.value)} required />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ============================================================
            SECTION 2: EVENT DETAILS
            ============================================================ */}
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-lg font-semibold mb-4">🎪 Event Details</h2>
          <div className="flex flex-col gap-4">
            <div>
              <label className="label">Event Name</label>
              <input type="text" className="input" placeholder="Rock Concert 2026"
                value={eventName} onChange={(e) => setEventName(e.target.value)} required />
            </div>
            <div>
              <label className="label">Description <span style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
              <textarea className="input" rows={3} placeholder="Tell attendees what to expect..."
                value={description} onChange={(e) => setDescription(e.target.value)}
                style={{ resize: 'vertical' }} />
            </div>
            <div>
              <label className="label">Category <span style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Select a category...</option>
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Start Time</label>
                <input type="datetime-local" className="input"
                  value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
              </div>
              <div>
                <label className="label">End Time</label>
                <input type="datetime-local" className="input"
                  value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
              </div>
            </div>
          </div>
        </div>

        {/* ============================================================
            SECTION 3: SALE WINDOW (optional)
            ============================================================ */}
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-lg font-semibold mb-1">🕐 Sale Window</h2>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Optional — when should ticket sales open and close? This controls the waiting room activation.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Sales Open</label>
              <input type="datetime-local" className="input"
                value={saleWindowStart} onChange={(e) => setSaleWindowStart(e.target.value)} />
            </div>
            <div>
              <label className="label">Sales Close</label>
              <input type="datetime-local" className="input"
                value={saleWindowEnd} onChange={(e) => setSaleWindowEnd(e.target.value)} />
            </div>
          </div>
        </div>

        {/* ============================================================
            SECTION 4: VENUE BUFFER TIME
            ============================================================ */}
        <div className="card p-6 mb-6" style={{ cursor: 'default' }}>
          <h2 className="text-lg font-semibold mb-1">🔒 Venue Buffer Time</h2>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Block the venue before and after your event (setup, teardown, cleaning).
            Other organizers won&apos;t be able to book overlapping slots.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Hours Before Event</label>
              <input type="number" className="input" min="0" max="24" step="0.5"
                value={bufferHoursBefore}
                onChange={(e) => setBufferHoursBefore(e.target.value)} />
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>For setup / sound check</p>
            </div>
            <div>
              <label className="label">Hours After Event</label>
              <input type="number" className="input" min="0" max="24" step="0.5"
                value={bufferHoursAfter}
                onChange={(e) => setBufferHoursAfter(e.target.value)} />
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>For teardown / cleaning</p>
            </div>
          </div>
        </div>

        {/* ---- Error message ---- */}
        {error && <div className="error-message mb-4">{error}</div>}

        {/* ---- Submit button ---- */}
        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="spinner" style={{ width: 18, height: 18 }}></span>
              Creating event...
            </span>
          ) : (
            'Create Event as Draft'
          )}
        </button>

        <p className="text-xs text-center mt-3" style={{ color: 'var(--text-muted)' }}>
          The event will be created as a draft. You can set pricing and publish it on the next page.
        </p>
      </form>
    </div>
  );
}
