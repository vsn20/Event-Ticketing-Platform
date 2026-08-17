# EventTix — Complete Project Workflow

> A real-time, seat-based event ticketing platform. This document explains the **complete architecture, data flow, and implementation** of everything built so far.

---

## 1. System Overview

```mermaid
flowchart TB
    subgraph "🌐 Frontend — Next.js 16 (port 3000)"
        FE_PAGES["16 Pages\n(Landing, Auth, Events, Dashboard, etc.)"]
        FE_API["api.js — HTTP client"]
        FE_AUTH["AuthContext — JWT state"]
    end

    subgraph "🔧 Backend — Express.js (port 5000)"
        ROUTES["Routes Layer\n(authRoutes, eventRoutes, venueRoutes)"]
        CONTROLLERS["Controller Layer\n(validation + HTTP responses)"]
        SERVICES["Service Layer\n(business logic + SQL queries)"]
        MIDDLEWARE["Middleware\n(JWT auth, role check, error handler)"]
    end

    subgraph "🗄️ Database — PostgreSQL"
        TABLES["Tables:\ncustomers, organizers,\nvenues, events,\nseats, event_section_pricing,\norders, order_items, tickets, payments"]
    end

    FE_PAGES --> FE_API
    FE_API -- "HTTP + JWT" --> ROUTES
    ROUTES --> MIDDLEWARE --> CONTROLLERS --> SERVICES --> TABLES

    style FE_PAGES fill:#ede9fe,stroke:#c4b5fd,color:#1e1b4b
    style ROUTES fill:#6366f1,stroke:#4f46e5,color:#fff
    style SERVICES fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style TABLES fill:#10b981,stroke:#059669,color:#fff
```

---

## 2. Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 16 (App Router) | Server components, file-based routing, React 19 |
| Styling | Tailwind CSS v4 + Vanilla CSS | Utility classes + custom design tokens |
| Backend | Express.js | Lightweight, well-known, great for REST APIs |
| Database | PostgreSQL | Relational data (events→venues→seats), ACID transactions |
| Auth | JWT (jsonwebtoken) + bcrypt | Stateless auth, secure password hashing |
| Future | Redis, Stripe, Socket.io, QR code | Phase B — seat locking, payments, real-time |

---

## 3. Database Schema

```mermaid
erDiagram
    CUSTOMERS {
        int customer_id PK
        string name
        string email UK
        string phone
        string password_hash
        string default_location
        timestamp created_at
    }

    ORGANIZERS {
        int org_id PK
        string org_name
        string email UK
        string phone
        string password_hash
        timestamp created_at
    }

    VENUES {
        int venue_id PK
        string venue_name
        string address
        string city
        int total_capacity
        json seat_layout_json
        timestamp created_at
    }

    EVENTS {
        int event_id PK
        int org_id FK
        int venue_id FK
        string event_name
        text description
        string category
        timestamp event_start_time
        timestamp event_end_time
        string status
        timestamp sale_window_start
        timestamp sale_window_end
        timestamp created_at
    }

    SEATS {
        int seat_id PK
        int event_id FK
        string section
        string row_label
        int seat_number
        decimal price
        string status
    }

    EVENT_SECTION_PRICING {
        int event_id FK
        string section
        decimal price
    }

    ORGANIZERS ||--o{ EVENTS : "creates"
    VENUES ||--o{ EVENTS : "hosts"
    EVENTS ||--o{ SEATS : "has"
    EVENTS ||--o{ EVENT_SECTION_PRICING : "prices"
```

### Key Design Decisions

1. **Separate `customers` and `organizers` tables** — different roles need different fields. No shared "users" table with a role column that could be spoofed.

2. **`seat_layout_json` is a TEMPLATE** — it lives on the venue and describes the structure (sections, rows, seats per row). Real seat rows are generated per event when published.

3. **Event lifecycle**: `draft → published → live → sold_out → closed`. Draft events are invisible to customers and have no seats.

4. **`event_section_pricing`** is the authoritative price record. Individual seat prices can be changed but this table tracks the "official" section price.

---

## 4. Backend Architecture

### Layered Architecture

```mermaid
flowchart LR
    REQ["HTTP Request"] --> ROUTE["Route\n(URL matching)"]
    ROUTE --> MW["Middleware\n(authenticate + requireRole)"]
    MW --> CTRL["Controller\n(validation + response)"]
    CTRL --> SVC["Service\n(business logic + SQL)"]
    SVC --> DB["PostgreSQL"]

    style REQ fill:#f1f5f9,stroke:#cbd5e1,color:#1e1b4b
    style MW fill:#f59e0b,stroke:#d97706,color:#fff
    style CTRL fill:#6366f1,stroke:#4f46e5,color:#fff
    style SVC fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style DB fill:#10b981,stroke:#059669,color:#fff
```

**Why 3 layers?**
- **Controller**: Validates HTTP input, sends HTTP responses. Knows about `req` and `res`.
- **Service**: Pure business logic. Knows about database queries. Does NOT know about `req`/`res`.
- **Middleware**: Cross-cutting concerns (auth, rate limiting, error handling).

This separation means the service layer is reusable (e.g., a CLI tool or cron job could call `createEvent()` without going through HTTP).

---

### 4.1 Authentication Flow

```mermaid
sequenceDiagram
    participant C as Client (Browser)
    participant S as Express Server
    participant DB as PostgreSQL

    Note over C,DB: === SIGNUP ===
    C->>S: POST /api/auth/customer/signup<br/>{name, email, password}
    S->>S: bcrypt.hash(password, 10)<br/>→ password_hash
    S->>DB: INSERT INTO customers<br/>(name, email, password_hash)
    DB-->>S: customer_id
    S->>S: jwt.sign({id, role:'customer'},<br/>SECRET, {expiresIn:'7d'})
    S-->>C: 201 {token, user}

    Note over C,DB: === LOGIN ===
    C->>S: POST /api/auth/customer/login<br/>{email, password}
    S->>DB: SELECT * FROM customers<br/>WHERE email = $1
    DB-->>S: customer row
    S->>S: bcrypt.compare(password,<br/>password_hash)
    S->>S: jwt.sign({id, role:'customer'})
    S-->>C: 200 {token, user}

    Note over C,DB: === PROTECTED REQUEST ===
    C->>S: GET /api/events<br/>Authorization: Bearer {token}
    S->>S: jwt.verify(token, SECRET)<br/>→ req.user = {id, role}
    S->>DB: SELECT FROM events...
    DB-->>S: events array
    S-->>C: 200 [events]
```

### 4.2 Event Creation + Venue Conflict Check

```mermaid
sequenceDiagram
    participant O as Organizer
    participant S as Express Server
    participant DB as PostgreSQL

    O->>S: POST /api/events<br/>{venueId, name, startTime,<br/>endTime, bufferHoursBefore: 2,<br/>bufferHoursAfter: 2}

    S->>DB: Does venue exist?<br/>SELECT FROM venues WHERE venue_id=$1
    DB-->>S: ✅ Yes (venue_name = "Stadium X")

    Note over S,DB: CONFLICT CHECK
    S->>DB: SELECT FROM events<br/>WHERE venue_id = $1<br/>AND status != 'closed'<br/>AND time ranges overlap<br/>(including buffer hours)

    alt No conflict
        DB-->>S: 0 rows (no overlap)
        S->>DB: INSERT INTO events<br/>(status = 'draft')
        DB-->>S: new event
        S-->>O: 201 {event}
    else Conflict found
        DB-->>S: 1 row (existing event)
        S-->>O: 400 "Venue 'Stadium X'<br/>is already booked!"
    end
```

**Buffer time example:**
- Event runs **4pm–10pm** with **2hr buffer before**, **2hr buffer after**
- Venue is blocked **2pm–12am (midnight)**
- Any other event overlapping this window is rejected

### 4.3 Event Publishing + Seat Generation

```mermaid
sequenceDiagram
    participant O as Organizer
    participant S as Express Server
    participant DB as PostgreSQL

    O->>S: POST /api/events/3/publish<br/>{sectionPricing: {VIP:200, General:75}}

    S->>DB: GET event (check sale_window_start)
    alt sale_window_start is NULL
        S-->>O: 400 "Cannot publish:<br/>Sale Window Start must be set"
    else sale_window_start is set
        S->>DB: SELECT seat_layout_json<br/>FROM venues WHERE venue_id = event.venue_id
        DB-->>S: {sections: [{name:"VIP",rows:["A","B"],<br/>seats_per_row:10}, ...]}

        loop For each section in layout
            loop For each row in section
                loop For each seat 1..seats_per_row
                    S->>DB: INSERT INTO seats<br/>(event_id, section, row_label,<br/>seat_number, price, status='available')
                end
            end
            S->>DB: INSERT INTO event_section_pricing<br/>(event_id, section, price)
        end

        S->>DB: UPDATE events SET status='published'<br/>WHERE event_id = 3
        S-->>O: 200 {message, seatsCreated: 50}
    end
```

### 4.4 Organizer Privacy (Dashboard)

```mermaid
flowchart TD
    A["Organizer A logs in\n→ JWT contains org_id=1"]
    B["Dashboard calls\nGET /api/events?myEvents=true"]
    C["Backend reads JWT → org_id = 1"]
    D["SQL: WHERE e.org_id = 1"]
    E["Returns ONLY org A's events"]

    F["Organizer B logs in\n→ JWT contains org_id=2"]
    G["Dashboard calls\nGET /api/events?myEvents=true"]
    H["Backend reads JWT → org_id = 2"]
    I["SQL: WHERE e.org_id = 2"]
    J["Returns ONLY org B's events"]

    A --> B --> C --> D --> E
    F --> G --> H --> I --> J

    style D fill:#ef4444,stroke:#dc2626,color:#fff
    style I fill:#ef4444,stroke:#dc2626,color:#fff
    style E fill:#10b981,stroke:#059669,color:#fff
    style J fill:#10b981,stroke:#059669,color:#fff
```

**Key**: The orgId comes from the **JWT token**, not from query parameters. This prevents Organizer A from passing `?orgId=2` to see Organizer B's events.

---

## 5. Frontend Architecture

### 5.1 Application Structure

```
frontend/app/
├── layout.js              ← Root layout (AuthProvider + Navbar wraps ALL pages)
├── globals.css            ← Design system (light theme, CSS variables)
├── page.js                ← Landing page (/)
├── lib/
│   └── api.js             ← HTTP client (auto-attaches JWT)
├── context/
│   └── AuthContext.js     ← Global auth state (login/logout/user)
├── components/
│   ├── Navbar.js          ← Dark gradient navbar, role-based links
│   └── EventCard.js       ← Reusable card for event listings
├── auth/
│   ├── login/page.js      ← Customer login
│   └── signup/page.js     ← Customer signup
├── organizer/
│   ├── login/page.js      ← Organizer login + signup (tab toggle)
│   ├── dashboard/page.js  ← My events only (privacy filtered)
│   └── events/
│       ├── create/page.js ← Create venue + event + buffer time
│       └── [id]/page.js   ← Edit details + publish + inline pricing
└── events/
    ├── page.js            ← Browse published events (filter by category/city)
    └── [id]/page.js       ← Event detail page (customer view)
```

### 5.2 Auth State Management

```mermaid
flowchart TD
    A["User opens app"]
    B["AuthProvider checks localStorage"]
    C{"Token\nexists?"}
    D["Decode JWT payload"]
    E{"Token\nexpired?"}
    F["Set user = null\n(not logged in)"]
    G["Restore user state\nfrom localStorage"]
    H["Navbar renders based on role"]

    I["User clicks Login"]
    J["Submit email + password"]
    K["API returns {token, user}"]
    L["Save to localStorage\n+ update React state"]
    M["Redirect to dashboard/events"]

    N["User clicks Logout"]
    O["Clear localStorage\n+ set user = null"]
    P["Redirect to home"]

    A --> B --> C
    C -- no --> F --> H
    C -- yes --> D --> E
    E -- yes --> F
    E -- no --> G --> H

    I --> J --> K --> L --> M
    N --> O --> P

    style L fill:#6366f1,stroke:#4f46e5,color:#fff
    style O fill:#ef4444,stroke:#dc2626,color:#fff
```

### 5.3 Design System (CSS)

**Theme**: Light, warm, modern — inspired by Linear, Luma, and Vercel.

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#fafafa` | Page background |
| `--bg-surface` | `#ffffff` | Card surfaces |
| `--color-primary` | `#6366f1` | Indigo — buttons, links |
| `--color-accent` | `#f43f5e` | Rose — highlights |
| `--text-primary` | `#1e1b4b` | Headings, body text |
| `--text-secondary` | `#64748b` | Muted descriptions |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.06)` | Card shadows |

**Navbar**: Dark indigo gradient (`#1e1b4b → #312e81`) — contrasts against the light page.

---

## 6. API Reference

### Auth Endpoints

| Method | Endpoint | Body | Response | Auth |
|--------|----------|------|----------|------|
| POST | `/api/auth/customer/signup` | `{name, email, password}` | `{token, user}` | No |
| POST | `/api/auth/customer/login` | `{email, password}` | `{token, user}` | No |
| POST | `/api/auth/organizer/signup` | `{name, email, password}` | `{token, user}` | No |
| POST | `/api/auth/organizer/login` | `{email, password}` | `{token, user}` | No |

### Venue Endpoints

| Method | Endpoint | Body | Response | Auth |
|--------|----------|------|----------|------|
| POST | `/api/venues` | `{name, city, seatLayoutJson}` | venue object | Organizer |
| GET | `/api/venues` | — | array of venues | Any |
| GET | `/api/venues/:id` | — | single venue | Any |

### Event Endpoints

| Method | Endpoint | Body | Response | Auth |
|--------|----------|------|----------|------|
| POST | `/api/events` | `{venueId, name, startTime, endTime, bufferHoursBefore, bufferHoursAfter, ...}` | event object | Organizer |
| GET | `/api/events?myEvents=true` | — | organizer's events only | Organizer |
| GET | `/api/events?status=published` | — | published events | Any |
| GET | `/api/events/:eventId` | — | event + venue + pricing | Any |
| PATCH | `/api/events/:eventId` | `{name?, description?, saleWindowStart?, ...}` | updated event | Organizer |
| POST | `/api/events/:eventId/publish` | `{sectionPricing: {VIP:200}}` | `{seatsCreated}` | Organizer |
| PATCH | `/api/events/:eventId/pricing` | `{section, price}` | `{newPrice, seatsUpdated}` | Organizer |

---

## 7. Complete User Workflows

### 7.1 Organizer: From Signup to Published Event

```mermaid
flowchart TD
    A["1. Organizer signs up\n/organizer/login → Sign Up tab"]
    B["2. Gets JWT token\n→ stored in localStorage"]
    C["3. Lands on Dashboard\n(empty — no events yet)"]
    D["4. Clicks 'Create Event'"]
    E["5. Creates venue\n(or selects existing)"]
    F["6. Fills event details:\nname, dates, category,\nbuffer time (setup/teardown)"]
    G{"7. Venue time\nconflict?"}
    H["Error: venue booked!\nAdjust time or pick different venue"]
    I["8. Event created as DRAFT\n→ redirected to manage page"]
    J["9. Clicks Edit → sets\nSale Window Start/End"]
    K["10. Sets pricing per section:\nVIP=200, General=75"]
    L["11. Clicks 'Publish'\n→ 50 seats generated"]
    M["12. Event is PUBLISHED\n→ visible to customers"]
    N["13. Can update prices anytime\nvia inline Edit buttons"]

    A --> B --> C --> D --> E --> F --> G
    G -- yes --> H --> F
    G -- no --> I --> J --> K --> L --> M --> N

    style A fill:#ede9fe,stroke:#c4b5fd,color:#1e1b4b
    style G fill:#f59e0b,stroke:#d97706,color:#fff
    style L fill:#ef4444,stroke:#dc2626,color:#fff
    style M fill:#10b981,stroke:#059669,color:#fff
```

### 7.2 Customer: From Signup to Browsing Events

```mermaid
flowchart TD
    A["1. Customer signs up\n/auth/signup"]
    B["2. Gets JWT token"]
    C["3. Browses /events\n→ sees published events only"]
    D["4. Filters by category\nor searches by city"]
    E["5. Clicks an event card"]
    F["6. Event detail page:\nvenue info, dates, section prices"]
    G["7. Clicks 'Buy Tickets'\n(Phase B — not yet implemented)"]

    A --> B --> C --> D --> E --> F --> G

    style A fill:#ede9fe,stroke:#c4b5fd,color:#1e1b4b
    style F fill:#6366f1,stroke:#4f46e5,color:#fff
    style G fill:#f1f5f9,stroke:#cbd5e1,color:#1e1b4b
```

---

## 8. Security Measures

| Threat | Protection |
|--------|-----------|
| Password theft | bcrypt hashing (10 salt rounds) |
| Token forgery | JWT signed with server-side secret |
| Organizer impersonation | `org_id` comes from JWT, not request body |
| Cross-organizer data leak | `?myEvents=true` reads org_id from JWT, not query params |
| Venue double-booking | SQL overlap check with buffer hours |
| Price manipulation | Seat prices are set server-side, never from client |
| CORS attacks | Express CORS middleware configured |

---

## 9. File Structure

```
Event_Ticketing_System/
│
├── backend/
│   ├── server.js                    ← Entry point (Express app)
│   ├── .env                         ← Database URL, JWT secret
│   └── src/
│       ├── config/
│       │   ├── db.js                ← PostgreSQL connection pool
│       │   ├── redis.js             ← Redis client (Phase B)
│       │   └── stripe.js            ← Stripe config (Phase B)
│       ├── middleware/
│       │   ├── authMiddleware.js    ← JWT verify + role check
│       │   ├── errorHandler.js      ← Global error handler
│       │   └── rateLimiter.js       ← Rate limiting (Phase B)
│       ├── routes/
│       │   ├── authRoutes.js        ← /api/auth/*
│       │   ├── venueRoutes.js       ← /api/venues/*
│       │   ├── eventRoutes.js       ← /api/events/*
│       │   └── ... (Phase B routes)
│       ├── controllers/
│       │   ├── authController.js    ← Signup/login handlers
│       │   ├── venueController.js   ← CRUD venue handlers
│       │   ├── eventController.js   ← CRUD + publish + pricing
│       │   └── ... (Phase B controllers)
│       ├── service/
│       │   ├── authService.js       ← bcrypt + JWT logic
│       │   ├── venueService.js      ← Venue CRUD + capacity calc
│       │   ├── eventService.js      ← Event CRUD + conflict check
│       │   ├── seatService.js       ← Seat generation + pricing
│       │   └── ... (Phase B services)
│       └── models/
│           ├── customerModel.js     ← Schema docs
│           ├── organizerModel.js
│           ├── venueModel.js
│           ├── eventModel.js
│           ├── seatModel.js
│           └── ... (Phase B models)
│
├── frontend/
│   ├── app/
│   │   ├── layout.js               ← Root layout
│   │   ├── globals.css             ← Design system
│   │   ├── page.js                 ← Landing page
│   │   ├── lib/api.js              ← HTTP client
│   │   ├── context/AuthContext.js   ← Auth state
│   │   ├── components/             ← Navbar, EventCard
│   │   ├── auth/                   ← Login, Signup pages
│   │   ├── organizer/              ← Dashboard, Create, Manage
│   │   └── events/                 ← Browse, Detail pages
│   └── next.config.mjs
│
└── Explanation/
    ├── All_Services_Overview.md     ← Backend service documentation
    ├── Phase_A_Auth_Venue_Event_CRUD.md ← Phase A implementation details
    ├── Frontend_Build_Walkthrough.md    ← Frontend page-by-page guide
    └── Complete_Workflow.md         ← THIS FILE — full project overview
```

---

## 10. What's Built vs What's Coming

### ✅ Phase A — COMPLETED

| Feature | Status |
|---------|--------|
| Customer signup/login | ✅ Done |
| Organizer signup/login | ✅ Done |
| JWT authentication | ✅ Done |
| Venue creation with seat layout | ✅ Done |
| Shared venue visibility | ✅ Done |
| Event creation (draft) | ✅ Done |
| Venue time conflict detection | ✅ Done |
| Configurable buffer hours | ✅ Done |
| Event publishing + seat generation | ✅ Done |
| Sale window validation | ✅ Done |
| Per-section pricing (publish) | ✅ Done |
| Inline price editing (post-publish) | ✅ Done |
| Edit event details anytime | ✅ Done |
| Organizer privacy (my events only) | ✅ Done |
| Full frontend (16 pages) | ✅ Done |
| Light theme CSS redesign | ✅ Done |

### 🔜 Phase B — COMING NEXT

| Feature | What It Does |
|---------|-------------|
| Redis seat locking | Hold a seat for 5 min while customer checks out |
| Real-time seat map | WebSocket (Socket.io) — see seats lock/unlock live |
| Waiting room | Queue system when sales open (fairness) |
| Stripe payments | Secure checkout with webhooks |
| Order management | Order creation, status tracking |
| Ticket + QR code | Generate downloadable tickets with QR codes |
| My Tickets page | Customer can view/download their tickets |
| Super Admin dashboard | Manage organizers and venues centrally |

---

## 11. How to Run the Project

```bash
# 1. Start PostgreSQL (must be running)

# 2. Backend
cd backend
npm install
npm run dev          # starts on port 5000

# 3. Frontend
cd frontend
npm install
npm run dev          # starts on port 3000

# 4. Open browser
# http://localhost:3000
```

### Environment Variables (backend/.env)

```env
DATABASE_URL=postgresql://user:password@localhost:5432/event_ticketing
JWT_SECRET=your-secret-key
PORT=5000
```
