# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important Instructions for AI Agents

**DO NOT RUN THE SERVER**: After making code modifications, DO NOT attempt to test or run the server (`node server.js`). The user will handle testing and execution manually. Your role is to make the requested changes and explain what was done, not to verify the code by running it.

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
- **sessions**: Badminton sessions with datetime, club, level, capacity, participants, reminderSent
- **clubs**: List of available badminton clubs
- **pushSubscriptions**: Web push notification subscriptions (linked to users)

The server implements an in-memory cache (`dataCache`) for `data.json` to optimize read performance. The cache is updated synchronously on every write operation.

#### Session Schema
Sessions contain the following fields:
- `id`: Unique UUID
- `datetime`: ISO 8601 datetime string
- `durationMinutes`: Session duration (0-300)
- `club`: Club name (must exist in clubs array)
- `level`: Skill level (débutant, débutant/moyen, moyen, confirmé)
- `capacity`: Maximum participants (1-12)
- `pricePerParticipant`: Price per person (rounded to 2 decimals)
- `organizer`: Username of session creator
- `participants`: Array of participant names (can include registered users or manually added names by the organizer)
- `followers`: Array of usernames "interested" in the session (cannot include the organizer). Followers receive join/leave notifications and are displayed as "Intéressés" in the UI.
- `createdAt`: ISO 8601 creation timestamp
- `reminderSent`: Boolean flag to track if 45-minute reminder was sent
- `messages`: Array of chat messages (see Chat System below)

#### App Version
The backend exposes an application version constant in `server.js` (`APP_VERSION`, default `1.2.0`) and a public endpoint:
- `GET /version` → `{ ok: true, version: "x.y.z" }`

The frontend fetches this endpoint and displays the version in the user dropdown (under the "Se déconnecter" button).

### Key Design Patterns
1. **Single File Architecture**: All backend logic in `server.js`, all frontend logic in `index.html`
2. **No Database**: JSON file storage with atomic writes
3. **Cookie Auth**: Authentication state stored in `badlyAuth` cookie containing `{name, passwordHash}`
4. **Auto-cleanup**: Expired sessions are purged automatically when listing sessions
5. **Capacity Management**: Sessions track participants + organizer vs capacity

## Branches and Deployment

### Branch Strategy
- **dev**: Development branch, deployed on https://dev.badly.ovh (port 3002)
- **main**: Production branch, deployed on https://badly.ovh (port 3001)

All development work is done on `dev`. When ready for production, use the "Sync main with dev" GitHub Action to merge `dev` into `main`.

### Automatic Deployment (dev only)
When code is pushed to the `dev` branch:
1. GitHub Actions triggers the `deploy-dev.yml` workflow
2. The workflow calls `POST https://dev.badly.ovh/webhook/deploy`
3. The server executes `deploy-dev.sh` which:
   - Pulls latest code from `origin/dev`
   - Runs `npm install`
   - Restarts the server

### Manual Sync to Production
To deploy to production, manually trigger the "Sync main with dev" workflow from GitHub Actions. This merges `dev` into `main`. Production deployment is handled separately.

## Development Commands

### Running the Server
```bash
node server.js
```
Server runs on port 3000 by default (prod uses 3001, dev uses 3002 via `PORT` environment variable).

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
- **Organizers**: Can edit session, delete session, manage participants via popup
- **Participants**: Can leave session (but not after it starts)
- **Other users**: Can join session if not full

### Participant Management
- Organizers can manage participants via a dedicated popup (accessible via "Participants" button)
- Organizers can add any name (registered user or external participant)
- Organizers can remove any participant from the session
- Capacity is calculated as: `participantCount = participants.length + 1 (organizer)`
- The frontend distinguishes registered users (✓ icon) from external participants (👤 icon)

### Chat System
Each session has an in-session chat allowing participants, organizers, and followers to communicate:
- **Who can send messages**: Organizer, participants, and followers of the session
- **Message structure**: `{ id, sender, text, timestamp }`
- **Constraints**: Max 500 characters per message, max 50 messages per session (`MAX_MESSAGES_PER_SESSION`)
- **Storage**: Messages are stored in the `messages` array within each session
- **Notifications**: When a message is sent, push notifications are sent to all other participants (organizer + participants + followers, excluding the sender)
- **UI**: Chat is accessible via a chat icon on each session card, showing unread indicator

### Push Notifications
When to send notifications:
1. **New session created**: Notify all subscribed users
2. **Spot becomes available**: When participant leaves or is removed from a full session
3. **Participant joins**: Notify organizer + followers when someone joins their session
4. **Participant leaves**: Notify organizer + followers when someone leaves their session
5. **Session reminder**: Notify all participants (organizer + participants) 45 minutes before session start
6. **Chat message**: Notify organizer + participants + followers (excluding message sender)

The service worker handles:
- Displaying notifications with vibration
- Setting app badge count
- Opening/focusing the app when notification clicked

### Session Reminders
- Automatic reminders sent 45 minutes before session start (`REMINDER_MINUTES_BEFORE_START`)
- Background process checks every 60 seconds for upcoming sessions (`REMINDER_CHECK_INTERVAL_MS`)
- Sessions have a `reminderSent` field to prevent duplicate notifications
- If session datetime is edited, `reminderSent` is reset to `false` to trigger a new reminder
- Reminders are sent to all session participants (organizer + participants list)

### Date Formatting
- Server stores dates in ISO 8601 format
- Frontend formats dates with French locale (weekday, day, month, time)
- Datetime input must be in 15-minute increments

### Data Constraints
- Max 128 users (`MAX_USERS`)
- Max 16 sessions (`MAX_SESSIONS`)
- Max 50 messages per session (`MAX_MESSAGES_PER_SESSION`)
- Username: 3-20 chars, alphanumeric + underscore/hyphen
- Password: 6-64 chars
- Session capacity: 1-12 players
- Session duration: 0-300 minutes
- Chat message: 1-500 characters

### Authentication Flow
1. User signs up → password hashed with static salt → stored in `data.json`
2. Cookie set with `{name, passwordHash}` → 30 day expiry
3. On page load: cookie validated against stored user
4. All protected endpoints use `requireAuth()` middleware

### API Endpoints
**Public:**
- `GET /` - Serve index.html
- `GET /version` - Get current app version
- `POST /signup` - Create new user account
- `POST /signin` - Authenticate user
- `POST /signout` - Clear auth cookie

**Authenticated:**
- `GET /listSessions` - Get all sessions + clubs + validUsernames (list of registered usernames)
- `POST /createSession` - Create new session (triggers push notification to all users)
- `POST /editSession` - Modify session (organizer only, resets reminderSent if datetime changes)
- `POST /deleteSession` - Delete session (organizer only)
- `POST /joinSession` - Join as participant (triggers notification to organizer + followers)
- `POST /leaveSession` - Leave session (triggers notification to organizer + followers, and spot-available notification if was full)
- `POST /updateParticipants` - Update session participants list (organizer only, triggers spot-available notification if places freed)
- `POST /followSession` - Follow a session (adds current user to `session.followers`)
- `POST /unfollowSession` - Unfollow a session (removes current user from `session.followers`)
- `POST /sendMessage` - Send a chat message in a session (organizer, participants, or followers only)
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
Notification functions in server.js:
1. `sendNewSessionNotification()` - when a session is created
2. `sendSpotAvailableNotification()` - when a spot becomes available in a full session
3. `sendParticipantJoinedNotification()` - when someone joins a session (organizer + followers)
4. `sendParticipantLeftNotification()` - when someone leaves a session (organizer + followers)
5. `sendSessionReminderNotification()` - 45-minute reminder (organizer + participants)
6. `sendChatMessageNotification()` - when a chat message is sent (organizer + participants + followers, excluding sender)

All use the low-level `sendPushNotifications()` function. Also update service worker notification display in `service-worker.js`.

### Debugging
Set `DEBUG = true` in server.js to enable console logging for all requests and push notification operations.
