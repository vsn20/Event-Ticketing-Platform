// ============================================================
// eventService.js — Event business logic
//
// Events are the core entity in the system — a concert, a
// sports match, a conference, etc. Each event:
//   - Belongs to one organizer (org_id)
//   - Takes place at one venue (venue_id)
//   - Has a lifecycle: draft → published → live → sold_out → closed
//
// This service handles:
//   1. createEvent — insert a new event in 'draft' status
//   2. getAllEvents — list events (with optional filters)
//   3. getEventById — get a single event with full details
//
// NOTE: Publishing (draft → published) and pricing are handled
// by seatService.js, not here. This service only deals with
// basic CRUD — creating the event record, listing, and viewing.
// ============================================================

const pool = require('../config/db');


// ============================================================
// createEvent({ orgId, venueId, name, description, category,
//               startTime, endTime, saleWindowStart, saleWindowEnd })
// ============================================================
// Creates a new event in 'draft' status.
//
// A draft event:
//   - Is NOT visible to customers yet
//   - Has NO seats generated (that happens at publish time)
//   - Can be edited freely before publishing
//
// The organizer must provide:
//   - venueId: which venue this event will be held at
//   - name: the event title
//   - startTime/endTime: when the event actually happens
//
// Optional fields:
//   - description: longer text about the event
//   - category: for filtering (Music, Sports, Conference, etc.)
//   - saleWindowStart/End: when ticket sales open/close
//     (if not set, the waiting room logic won't activate —
//     tickets are available immediately when the event is published)
//
// The orgId comes from req.user.id (the authenticated organizer),
// NOT from the request body. This prevents an organizer from
// creating events under someone else's account.
// ============================================================
async function createEvent({ orgId, venueId, name, description, category,
                             startTime, endTime, saleWindowStart, saleWindowEnd }) {
  // ----------------------------------------------------------
  // Verify the venue exists before creating the event.
  // If the organizer passes a venueId that doesn't exist,
  // Postgres would throw a foreign key violation — but we
  // check here first for a clearer error message.
  // ----------------------------------------------------------
  const venueCheck = await pool.query(
    'SELECT venue_id FROM venues WHERE venue_id = $1',
    [venueId]
  );

  if (venueCheck.rows.length === 0) {
    throw new Error(`Venue with ID ${venueId} does not exist. Create the venue first.`);
  }

  // ----------------------------------------------------------
  // Insert the event with status = 'draft'.
  // The event won't have seats until the organizer calls
  // POST /api/events/:eventId/publish (which triggers
  // seatService.generateSeatsForEvent).
  // ----------------------------------------------------------
  const result = await pool.query(
    `INSERT INTO events
       (org_id, venue_id, event_name, description, category,
        event_start_time, event_end_time, sale_window_start, sale_window_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING event_id, org_id, venue_id, event_name, description, category,
               event_start_time, event_end_time, status,
               sale_window_start, sale_window_end, created_at`,
    [orgId, venueId, name, description || null, category || null,
     startTime, endTime, saleWindowStart || null, saleWindowEnd || null]
  );

  return result.rows[0];
}


// ============================================================
// getAllEvents(filters)
// ============================================================
// Returns a list of events, optionally filtered by:
//   - status: only show events in a specific status
//   - city: only show events at venues in a specific city
//   - category: only show events in a specific category
//   - orgId: only show events created by a specific organizer
//
// The query JOINs with the venues table to include venue name
// and city in the response — this saves the frontend from
// making a separate API call for each event's venue.
//
// Results are ordered by event_start_time ascending (soonest
// events first) — this is the natural ordering customers
// expect when browsing upcoming events.
//
// NOTE: For customers, we typically filter to published/live
// events only. Organizers can see their own drafts too.
// ============================================================
async function getAllEvents(filters = {}) {
  // ----------------------------------------------------------
  // Build the WHERE clause dynamically based on which filters
  // were provided. We start with "1=1" (always true) so every
  // subsequent filter can use "AND" without worrying about
  // whether it's the first condition or not.
  // ----------------------------------------------------------
  const conditions = ['1=1'];
  const values = [];
  let paramIndex = 1;

  // Filter by event status (e.g., 'published', 'live')
  if (filters.status) {
    conditions.push(`e.status = $${paramIndex}`);
    values.push(filters.status);
    paramIndex++;
  }

  // Filter by venue city (e.g., 'Bangalore')
  if (filters.city) {
    conditions.push(`v.city ILIKE $${paramIndex}`);
    values.push(`%${filters.city}%`);
    paramIndex++;
  }

  // Filter by event category (e.g., 'Music')
  if (filters.category) {
    conditions.push(`e.category ILIKE $${paramIndex}`);
    values.push(`%${filters.category}%`);
    paramIndex++;
  }

  // Filter by organizer (for organizer dashboard — "show my events")
  if (filters.orgId) {
    conditions.push(`e.org_id = $${paramIndex}`);
    values.push(filters.orgId);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT e.event_id, e.event_name, e.description, e.category,
            e.event_start_time, e.event_end_time, e.status,
            e.sale_window_start, e.sale_window_end,
            e.created_at, e.updated_at,
            v.venue_id, v.venue_name, v.city
     FROM events e
     JOIN venues v ON e.venue_id = v.venue_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.event_start_time ASC`,
    values
  );

  return result.rows;
}


// ============================================================
// getEventById(eventId)
// ============================================================
// Returns a single event with full details, including:
//   - All event fields
//   - Venue info (name, address, city, capacity)
//   - Organizer name
//   - Current section pricing (from event_section_pricing,
//     only if the event has been published)
//
// This is used for the event detail page that customers see
// before deciding to buy tickets.
// ============================================================
async function getEventById(eventId) {
  // ----------------------------------------------------------
  // Main query: JOIN events with venues and organizers to get
  // everything in one round-trip.
  // ----------------------------------------------------------
  const result = await pool.query(
    `SELECT e.event_id, e.event_name, e.description, e.category,
            e.event_start_time, e.event_end_time, e.status,
            e.sale_window_start, e.sale_window_end,
            e.created_at, e.updated_at,
            v.venue_id, v.venue_name, v.address, v.city, v.total_capacity,
            o.org_id, o.org_name
     FROM events e
     JOIN venues v ON e.venue_id = v.venue_id
     JOIN organizers o ON e.org_id = o.org_id
     WHERE e.event_id = $1`,
    [eventId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Event with ID ${eventId} not found`);
  }

  const event = result.rows[0];

  // ----------------------------------------------------------
  // If the event is published (or beyond), also fetch the
  // current section pricing. This tells the frontend what
  // each section costs right now, which it can display on
  // the event detail page before the customer enters the
  // seat map.
  //
  // For draft events, this table has no rows — pricing doesn't
  // exist until publish time.
  // ----------------------------------------------------------
  let sectionPricing = [];

  if (event.status !== 'draft') {
    const pricingResult = await pool.query(
      `SELECT section, price
       FROM event_section_pricing
       WHERE event_id = $1
       ORDER BY price DESC`,
      [eventId]
    );
    sectionPricing = pricingResult.rows;
  }

  return {
    ...event,
    sectionPricing,
  };
}


module.exports = { createEvent, getAllEvents, getEventById };
