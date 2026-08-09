[README.md](https://github.com/user-attachments/files/30867304/README.md)
# Scheduler backend (multi-client, shared instance)

One server, one Claude integration, one config file per client. This is
built so onboarding a new client is "add a JSON file," not "deploy a
new server."

## Run it locally

```
npm install
cp .env.example .env        # then paste in your real Anthropic API key
npm start
```

Server runs at http://localhost:3000

## Try it without a frontend yet

```
curl -X POST http://localhost:3000/session/coldline-ice
# -> { "sessionId": "..." }

curl -X POST http://localhost:3000/chat/<sessionId-from-above> \
  -H "Content-Type: application/json" \
  -d '{"message": "I need 200 lbs of bagged ice every Friday"}'
```

## How it fits with the front-end page (index.html)

Update the front-end's `handleUserMessage()` function to:
1. On page load, POST to `/session/coldline-ice` and store the returned `sessionId`
2. On each message, POST to `/chat/<sessionId>` with `{ message: text }` and display `reply`

That replaces the scripted demo conversation with real Claude + tool-calling.

## Adding a new client (e.g. the next business you sign)

1. Copy `clients/coldline-ice.json` to `clients/<new-client-id>.json`
2. Edit the business details, products, hours, capacity
3. Restart the server - no code changes needed
4. Give that client a front-end page pointed at `/session/<new-client-id>`

## What's still a prototype vs. production-ready

- **Data store** (`lib/db.js`) is in-memory - orders vanish on restart. Swap for
  real Postgres (Supabase/Neon have good free tiers) when ready; the function
  signatures are already shaped to match a real `deliveries` table.
- **Sessions** are in-memory too - fine for testing, move to Redis or the
  database once this needs to survive restarts or run on multiple instances.
- **CORS** is wide open (`cors()` with no options) - restrict to your actual
  client domains before this goes live.
- **No SMS/email notifications yet** - add a call to Twilio/SendGrid inside
  the tool handlers in `lib/tools.js` once an order is actually created.
