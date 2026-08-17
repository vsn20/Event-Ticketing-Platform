// ============================================================
// authService.js — Authentication business logic
//
// This service handles the core authentication operations:
//   1. Signup — create a new customer or organizer account
//   2. Login — verify credentials and issue a JWT
//
// WHY separate from controllers:
//   Controllers handle HTTP concerns (req, res, status codes).
//   This service handles BUSINESS concerns (hashing, token
//   generation, database queries). This separation means the
//   same auth logic could be reused from a WebSocket handler,
//   a CLI tool, or a test — not just an HTTP request.
//
// DESIGN DECISIONS:
//   - Customers and organizers are in SEPARATE tables (not a
//     single "users" table with a role column). This is because
//     they have different fields (customers have default_location,
//     organizers have org_phone, etc.) and the design doc treats
//     them as distinct entities.
//   - The JWT embeds the user's role ("customer" or "organizer")
//     so the auth middleware can enforce role-based access without
//     a database lookup on every request.
//   - Passwords are hashed with bcrypt (adaptive cost function),
//     never stored in plaintext.
// ============================================================

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// Number of bcrypt salt rounds. Higher = more secure but slower.
// 10 is the standard recommended value — it takes ~100ms per
// hash, which is fast enough for login but slow enough to make
// brute-force attacks impractical.
const SALT_ROUNDS = 10;


// ============================================================
// signupCustomer({ name, email, phone, password, defaultLocation })
// ============================================================
// Creates a new customer account.
//
// Steps:
//   1. Hash the password with bcrypt (never store plaintext)
//   2. INSERT into the customers table
//   3. Generate a JWT with the customer's ID and role
//   4. Return the token and basic user info
//
// If the email already exists, Postgres will reject the INSERT
// because customer_email has a UNIQUE constraint — we catch
// that and return a clear error message.
// ============================================================
async function signupCustomer({ name, email, phone, password, defaultLocation }) {
  // Step 1: Hash the password before storing it.
  // bcrypt.hash() generates a random salt internally and
  // combines it with the hash, so two identical passwords
  // produce different hashes — this protects against rainbow
  // table attacks.
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Step 2: Insert the new customer.
  // RETURNING gives us the auto-generated customer_id and
  // created_at without needing a separate SELECT query.
  const result = await pool.query(
    `INSERT INTO customers (customer_name, customer_email, phone_number, password_hash, default_location)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING customer_id, customer_name, customer_email, created_at`,
    [name, email, phone || null, passwordHash, defaultLocation || null]
  );

  const customer = result.rows[0];

  // Step 3: Generate a JWT.
  // The token contains:
  //   - id: the customer's database ID (used to identify them)
  //   - role: "customer" (used by auth middleware to restrict
  //     endpoints — e.g., only organizers can create events)
  // The token expires in 7 days — after that, the user must
  // log in again. This limits damage if a token is stolen.
  const token = jwt.sign(
    { id: customer.customer_id, role: 'customer' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  // Step 4: Return token + user info (never the password hash).
  return {
    token,
    user: {
      id: customer.customer_id,
      name: customer.customer_name,
      email: customer.customer_email,
      role: 'customer',
      createdAt: customer.created_at,
    },
  };
}


// ============================================================
// signupOrganizer({ name, email, phone, password })
// ============================================================
// Creates a new organizer account.
//
// Same flow as signupCustomer, but writes to the organizers
// table instead. Organizers have different fields (org_name,
// org_email, org_phone) and a different role in the JWT.
// ============================================================
async function signupOrganizer({ name, email, phone, password }) {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await pool.query(
    `INSERT INTO organizers (org_name, org_email, org_phone, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING org_id, org_name, org_email, created_at`,
    [name, email, phone || null, passwordHash]
  );

  const organizer = result.rows[0];

  const token = jwt.sign(
    { id: organizer.org_id, role: 'organizer' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    token,
    user: {
      id: organizer.org_id,
      name: organizer.org_name,
      email: organizer.org_email,
      role: 'organizer',
      createdAt: organizer.created_at,
    },
  };
}


// ============================================================
// loginCustomer({ email, password })
// ============================================================
// Authenticates an existing customer.
//
// Steps:
//   1. Look up the customer by email
//   2. Compare the provided password against the stored hash
//   3. If valid, generate and return a JWT
//
// SECURITY NOTE: When login fails, we return the same generic
// error message whether the email doesn't exist OR the password
// is wrong. This prevents attackers from using the login
// endpoint to check whether an email is registered (a technique
// called "user enumeration").
// ============================================================
async function loginCustomer({ email, password }) {
  // Step 1: Find the customer by email.
  const result = await pool.query(
    `SELECT customer_id, customer_name, customer_email, password_hash
     FROM customers
     WHERE customer_email = $1`,
    [email]
  );

  // If no customer found with this email, return a generic error.
  // We deliberately don't say "email not found" — that would
  // reveal whether the email is registered.
  if (result.rows.length === 0) {
    throw new Error('Invalid email or password');
  }

  const customer = result.rows[0];

  // Step 2: Compare passwords.
  // bcrypt.compare() hashes the input password with the same
  // salt that was used during signup and checks if they match.
  // This is a constant-time comparison to prevent timing attacks.
  const isValid = await bcrypt.compare(password, customer.password_hash);

  if (!isValid) {
    throw new Error('Invalid email or password');
  }

  // Step 3: Password is correct — issue a JWT.
  const token = jwt.sign(
    { id: customer.customer_id, role: 'customer' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    token,
    user: {
      id: customer.customer_id,
      name: customer.customer_name,
      email: customer.customer_email,
      role: 'customer',
    },
  };
}


// ============================================================
// loginOrganizer({ email, password })
// ============================================================
// Same flow as loginCustomer, but queries the organizers table.
// ============================================================
async function loginOrganizer({ email, password }) {
  const result = await pool.query(
    `SELECT org_id, org_name, org_email, password_hash
     FROM organizers
     WHERE org_email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    throw new Error('Invalid email or password');
  }

  const organizer = result.rows[0];

  const isValid = await bcrypt.compare(password, organizer.password_hash);

  if (!isValid) {
    throw new Error('Invalid email or password');
  }

  const token = jwt.sign(
    { id: organizer.org_id, role: 'organizer' },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    token,
    user: {
      id: organizer.org_id,
      name: organizer.org_name,
      email: organizer.org_email,
      role: 'organizer',
    },
  };
}


module.exports = {
  signupCustomer,
  signupOrganizer,
  loginCustomer,
  loginOrganizer,
};
