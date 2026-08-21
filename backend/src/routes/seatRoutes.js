// ============================================================
// seatRoutes.js — Seat map and locking endpoints
//
// These are nested under /api/events/:eventId/seats in server.js
//
// Endpoints:
//   GET  /                → Get all seats with real-time status
//   POST /lock            → Lock selected seats (Redis + DB)
// ============================================================

const express = require('express');
const router = express.Router({ mergeParams: true });
const { authenticate } = require('../middleware/authMiddleware');
const { getSeatsForEvent, lockSeats } = require('../service/seatService');


// ============================================================
// GET /api/events/:eventId/seats
// ============================================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { eventId } = req.params;
    const customerId = req.user.role === 'customer' ? req.user.id : null;

    const seatMap = await getSeatsForEvent(eventId, customerId);
    res.json(seatMap);
  } catch (err) {
    console.error('Error fetching seats:', err);
    res.status(500).json({ message: err.message });
  }
});


// ============================================================
// POST /api/events/:eventId/seats/lock
// ============================================================
router.post('/lock', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ message: 'Only customers can book seats' });
    }

    const { eventId } = req.params;
    const { seatIds } = req.body;

    if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
      return res.status(400).json({ message: 'seatIds array is required' });
    }

    if (seatIds.length > 10) {
      return res.status(400).json({ message: 'Maximum 10 seats per booking' });
    }

    // ---- Sale window check ----
    // Only allow booking within the sale window.
    const pool = require('../config/db');
    const eventResult = await pool.query(
      `SELECT status, sale_window_start, sale_window_end FROM events WHERE event_id = $1`,
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ message: 'Event not found' });
    }

    const event = eventResult.rows[0];
    const now = new Date();

    if (event.status !== 'published' && event.status !== 'live') {
      return res.status(400).json({ message: 'Tickets are not available for this event' });
    }

    if (event.sale_window_start && now < new Date(event.sale_window_start)) {
      return res.status(400).json({ message: 'Sales have not started yet' });
    }

    if (event.sale_window_end && now > new Date(event.sale_window_end)) {
      return res.status(400).json({ message: 'Sales window has closed' });
    }

    const result = await lockSeats(eventId, seatIds, req.user.id);
    res.json(result);
  } catch (err) {
    console.error('Error locking seats:', err);
    res.status(409).json({ message: err.message });
  }
});


module.exports = router;
