# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Badly is a badminton session planning application for Lyon, France. It's a Progressive Web App (PWA) that allows users to create, join, and manage badminton sessions at various clubs.

## Architecture

### Tech Stack
- **Backend**: Pure Node.js HTTP server (no framework) with file-based JSON storage
- **Frontend**: Vanilla JavaScript SPA with no frameworks or build tools
- **PWA**: Service worker with push notifications, installable on mobile devices
- **Authentication**: Cookie-based auth with SHA-256 password hashing

### Data Architecture
The application uses a simple file-based JSON database (`data.json`) with four main entities:
- **users**: User accounts with normalized names and hashed passwords
- **sessions**: Badminton sessions with datetime, club, level, capacity, participants
- **clubs**: List of available badminton clubs
- **pushSubscriptions**: Web push notification subscriptions

The server implements an in-memory cache (`dataCache`) for `data.json` to optimize read performance. The cache is updated synchronously on every write operation.

### Key Design Patterns
1. **Single File Architecture**: All backend logic in `server.js`, all frontend logic in `index.html`
2. **No Database**: JSON file storage with atomic writes
3. **Cookie Auth**: Authentication state stored in `badlyAuth` cookie containing `{name, passwordHash}`
4. **Auto-cleanup**: Expired sessions are purged automatically when listing sessions
5. **Capacity Management**: Sessions track participants + organizer + guests vs capacity

## Development Commands

### Running the Server
```bash
node server.js
```
Server runs on port 3001 by default.

### Environment Variables
Required for push notifications (generate with `npx web-push generate-vapid-keys`):
```bash
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_EMAIL=mailto:your@email.com
```

### Testing Push Notifications
1. Set up VAPID keys in `.env` file
2. Run the server
3. Open browser, sign in, allow notifications
4. Create a new session to trigger push notification

## Important Implementation Details

### Session Lifecycle
- Sessions have states: future (editable) → started (read-only) → expired (auto-deleted)
- Organizers can modify sessions until they start
- Participants can join/leave until session starts
- Sessions are sorted by datetime and expire after `datetime + durationMinutes`

### User Permissions
- **Organizers**: Can edit session, delete session, add/remove guests
- **Participants**: Can leave session (but not after it starts)
- **Other users**: Can join session if not full

### Guest System
- Only organizers can add/remove anonymous guests
- Guests count toward session capacity: `participantCount = participants.length + 1 (organizer) + guests`
- Used for tracking non-registered players

### Push Notifications
When to send notifications:
1. **New session created**: Notify all subscribed users
2. **Spot becomes available**: When participant leaves or guest removed from a full session

The service worker handles:
- Displaying notifications with vibration
- Setting app badge count
- Opening/focusing the app when notification clicked

### Date Formatting
- Server stores dates in ISO 8601 format
- Frontend formats dates with French locale (weekday, day, month, time)
- Datetime input must be in 15-minute increments

### Data Constraints
- Max 64 users (`MAX_USERS`)
- Max 8 sessions (`MAX_SESSIONS`)
- Username: 3-20 chars, alphanumeric + underscore/hyphen
- Password: 6-64 chars
- Session capacity: 1-12 players
- Session duration: 0-300 minutes

### Authentication Flow
1. User signs up → password hashed with static salt → stored in `data.json`
2. Cookie set with `{name, passwordHash}` → 30 day expiry
3. On page load: cookie validated against stored user
4. All protected endpoints use `requireAuth()` middleware

### API Endpoints
**Public:**
- `GET /` - Serve index.html
- `POST /signup` - Create new user account
- `POST /signin` - Authenticate user

**Authenticated:**
- `GET /listSessions` - Get all sessions + clubs
- `POST /createSession` - Create new session (triggers push notification)
- `POST /editSession` - Modify session (organizer only)
- `POST /deleteSession` - Delete session (organizer only)
- `POST /joinSession` - Join as participant
- `POST /leaveSession` - Leave session (triggers notification if was full)
- `POST /addGuest` - Add anonymous guest (organizer only)
- `POST /removeGuest` - Remove guest (organizer only, triggers notification if was full)
- `GET /vapidPublicKey` - Get VAPID public key for push
- `POST /subscribePush` - Register push subscription
- `POST /unsubscribePush` - Unregister push subscription

## Common Pitfalls

### Modifying data.json Structure
Always update both:
1. The `ensureDataFile()` seed structure
2. The `readData()` validation logic

### Password Hashing
The salt is static (`badly-static-salt-v1`). This is intentional for this simple app but not production-grade security.

### Cache Invalidation
The `dataCache` is synchronous with file writes. Don't read the file directly after a write - use `readData()` to get cached data.

### Session Time Validation
The server allows sessions scheduled up to 5 minutes in the past to handle clock skew. Ensure this tolerance is maintained when modifying validation.

### PWA Install Prompt
- Only shown on mobile (iOS/Android detection)
- Cookie `badlyInstallPromptSeen` prevents re-showing
- Different instructions for iOS (Share button) vs Android (Menu)
- Auto-dismissed if app already in standalone mode

## Code Modification Guidelines

### Adding New Session Fields
1. Update session creation in `handleCreateSession()`
2. Update session editing in `handleEditSession()`
3. Update `formatSessionForClient()` to include new field
4. Update frontend form in `index.html`
5. Ensure validation in both frontend and backend

### Adding New Clubs
Manually edit `data.json` and add club names to the `clubs` array. The frontend dynamically populates the dropdown from this list.

### Modifying Notification Logic
Edit both:
1. `sendNewSessionNotification()` or `sendSpotAvailableNotification()` in server.js
2. Service worker notification display in `service-worker.js`

### Debugging
Set `DEBUG = true` in server.js to enable console logging for all requests and push notification operations.
