// ============================================================
// server.js — Application entry point
//
// This file's ONLY job is to:
//   1. Set up the Express app
//   2. Wire in global middleware (CORS, JSON parsing)
//   3. Mount route files under their URL prefixes
//   4. Start listening on a port
//
// Actual business logic (queries, request handling) lives in
// controllers/routes — not here. This keeps the entry point
// clean and makes it easy to see the full URL structure of
// the API at a glance.
//
// URL STRUCTURE:
//   /health             → liveness check
//   /health/db          → database connectivity check
//   /api/auth/...       → signup and login for customers & organizers
//   /api/venues/...     → venue CRUD (create, list, get)
//   /api/events/...     → event CRUD, publish, pricing
// ============================================================

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./src/config/db');

const app = express();

// ============================================================
// GLOBAL MIDDLEWARE
// ============================================================

// Lets the Next.js frontend (running on a different port/origin
// during development) make requests to this API without the
// browser blocking them. In production, you'd want to restrict
// this to your actual frontend domain.
app.use(cors());

// Parses incoming JSON request bodies (e.g. login credentials,
// order payloads) into req.body. Without this, req.body is
// undefined on POST requests.
app.use(express.json());


// ============================================================
// HEALTH CHECK ROUTES
// ============================================================

// A simple liveness check — hitting this tells you the server
// process is up at all, independent of whether the database is
// reachable. Useful for Railway/Render health checks later too.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// A second check that actually round-trips to Postgres, so you
// can tell "server is up" apart from "server is up AND can reach
// the database" — the two failure modes need different fixes.
app.get('/health/db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', db_time: result.rows[0].now });
  } catch (err) {
    console.error('DB health check failed:', err);
    res.status(500).json({ status: 'error', message: 'Database unreachable' });
  }
});


// ============================================================
// API ROUTES
// ============================================================
// Each route file is mounted under a URL prefix. The route
// file itself defines the sub-paths (e.g., eventRoutes defines
// '/:eventId/publish', which becomes '/api/events/:eventId/publish'
// after mounting here).
// ============================================================

// Auth routes — signup/login for customers and organizers.
// No authentication required on these (you can't be logged in
// before you've signed up).
app.use('/api/auth', require('./src/routes/authRoutes'));

// Venue routes — create, list, and view venues.
// Creating requires organizer role; viewing is any authenticated user.
app.use('/api/venues', require('./src/routes/venueRoutes'));

// Event routes — create, list, view, publish, and update pricing.
// Creating/publishing/pricing requires organizer role;
// listing/viewing is any authenticated user.
app.use('/api/events', require('./src/routes/eventRoutes'));


// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});