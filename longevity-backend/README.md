# Meridian Longevity — Lead Management Backend

Production-grade scaffolding for the lead management system.
Wires together **Exotel** (telephony), **Whisper AI** (transcription + summarisation),
**Interakt** (WhatsApp), and a **CRM** (HubSpot/Zoho/Salesforce) on top of a
PostgreSQL data layer.

> This is **scaffolding** — opinionated, working integration code with the
> right boundaries and webhook plumbing. You still need to (1) put your API keys
> in `.env`, (2) provision a Postgres DB and run `db/schema.sql`, (3) host this
> on a server reachable from Exotel and Interakt webhooks (e.g. Railway, Fly,
> Render, EC2), and (4) point your React frontend at the API.

---

## Architecture

```
            ┌─────────────────────────────────────┐
            │     React Frontend (the artifact)   │
            │   /api/*  REST                       │
            └────────────────┬────────────────────┘
                             │
                ┌────────────▼────────────┐
                │   Express server.js      │
                │   - REST routes          │
                │   - Webhook ingest       │
                │   - HMAC verification    │
                └─────┬───────┬───────┬────┘
                      │       │       │
        ┌─────────────┼───────┼───────┼─────────────┐
        ▼             ▼       ▼       ▼             ▼
   integrations/   webhooks/  services/         db/ (Postgres)
     exotel.js      exotel.js  leadService.js    leads, calls,
     whisper.js     interakt.js                    messages, syncs
     interakt.js
     crm.js

   ▲                                        ▲
   │   outbound API calls                   │   inbound webhooks
   │                                        │
   Exotel · OpenAI · Interakt · HubSpot    Exotel · Interakt
```

### End-to-end call flow (the headline use case)

1. **Agent clicks "Call" in UI** → frontend hits `POST /api/leads/:id/call`
2. `integrations/exotel.js` calls **Exotel Connect API** → both legs ring (agent first, then lead)
3. **Exotel calls the StatusCallback** webhook on call end (`POST /webhooks/exotel/status`)
4. Webhook handler stores `recording_url`, enqueues a transcription job
5. `integrations/whisper.js` downloads the recording, sends to OpenAI Whisper, gets transcript
6. Transcript is sent to GPT-4o-mini for **summary + sentiment + action items + intent score**
7. All artefacts saved to `calls` table; lead stage may auto-advance based on intent
8. `integrations/crm.js` syncs lead + engagement to HubSpot/Zoho/Salesforce
9. Frontend polls or receives a server-sent event → AI summary appears in the lead drawer

### End-to-end WhatsApp flow

1. **Agent sends template from UI** → `POST /api/leads/:id/whatsapp` with template ID + variables
2. `integrations/interakt.js` calls **Interakt public API** with the HSM template
3. Lead replies → Interakt fires webhook to `POST /webhooks/interakt/incoming`
4. We verify HMAC signature, persist message, push real-time update to UI
5. Lead activity timeline updates; CRM syncs the conversation

---

## Setup

```bash
# 1. Install deps
npm install

# 2. Configure
cp .env.example .env
# fill in real credentials

# 3. Provision DB
psql $DATABASE_URL -f db/schema.sql

# 4. Run
npm run dev    # nodemon
npm start      # production
```

### Webhooks: register these URLs in vendor dashboards

| Vendor   | Event                  | URL                                      |
|----------|------------------------|------------------------------------------|
| Exotel   | StatusCallback         | `https://your-host/webhooks/exotel/status` |
| Exotel   | RecordingCallback      | `https://your-host/webhooks/exotel/recording` |
| Interakt | Inbound message        | `https://your-host/webhooks/interakt/incoming` |
| Interakt | Message status         | `https://your-host/webhooks/interakt/status` |

**Local development**: use `ngrok http 3000` and point webhook URLs at the
ngrok HTTPS address.

---

## Important production notes

- **HMAC verification is mandatory.** The webhook handlers reject any payload
  without a valid signature. Don't disable this in production.
- **Rate limits**: Exotel allows ~5 req/sec. The Whisper API has tier-based
  limits. Use a queue (`bull` / `bullmq`) for transcription jobs at scale —
  the scaffold runs them inline for simplicity but flags where to swap in.
- **PII / DPDP compliance**: every outbound action checks the `consent` JSONB
  on the lead. WhatsApp 24-hour window is enforced in `interakt.js`.
- **Recording storage**: Exotel recordings expire. The scaffold downloads to
  S3-compatible storage (configurable). Keep recordings encrypted at rest.
- **Idempotency**: webhook handlers use the vendor's event ID as an idempotency
  key — Exotel can retry, don't double-process.

---

## File map

| Path | Purpose |
|------|---------|
| `server.js` | Express app, route mounting, middleware |
| `db/schema.sql` | Postgres schema (leads, calls, messages, sync_state) |
| `middleware/verifySignature.js` | HMAC verification for webhooks |
| `integrations/exotel.js` | Click-to-call, IVR, recording fetch |
| `integrations/whisper.js` | OpenAI Whisper + LLM summarisation pipeline |
| `integrations/interakt.js` | WhatsApp send, template management, opt-in/out |
| `integrations/crm.js` | Generic CRM interface + HubSpot adapter |
| `webhooks/exotel.js` | Inbound Exotel webhooks (status, recording) |
| `webhooks/interakt.js` | Inbound Interakt webhooks (messages, statuses) |
| `services/leadService.js` | Lead lifecycle, stage advancement, orchestration |

---

## Choosing a CRM

The `integrations/crm.js` file exports a generic `CRM` interface and a
HubSpot adapter is included. Add Zoho / Salesforce by implementing the same
interface (`upsertContact`, `logEngagement`, `getContact`).

Set `CRM_PROVIDER=hubspot|zoho|salesforce` in `.env`.

---

## Why these vendors?

- **Exotel**: India-first, supports DLT-compliant numbers, IVR + recording
  out of the box, generous webhooks. Alternatives: MyOperator, Knowlarity.
- **Whisper**: best-in-class accent-robust ASR. Self-host `whisper.cpp` if
  you need data residency in India — the integration is identical, swap base URL.
- **Interakt**: cleanest WhatsApp Business API in India, good template
  approval flow, has a simple webhook model. Alternatives: WATI, Gupshup.
- **HubSpot**: most common CRM for B2C wellness; free tier covers contacts +
  engagements which is enough for the lead model.
