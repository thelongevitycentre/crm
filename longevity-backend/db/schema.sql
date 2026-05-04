-- ════════════════════════════════════════════════════════════════════
--   Meridian Longevity — Database Schema
--   PostgreSQL 14+
-- ════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ────────────────────────────────────────────────────────────────────
--   AGENTS / USERS
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  phone           TEXT,                    -- agent's calling number
  role            TEXT NOT NULL DEFAULT 'coordinator', -- coordinator | doctor | admin
  exotel_caller_id TEXT,                   -- which ExoPhone they call from
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  active          BOOLEAN DEFAULT TRUE
);

-- ────────────────────────────────────────────────────────────────────
--   LEADS
-- ────────────────────────────────────────────────────────────────────
CREATE TYPE lead_stage AS ENUM (
  'new', 'contacted', 'qualified', 'consult', 'converted', 'lost'
);

CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  display_id      TEXT UNIQUE NOT NULL,    -- L-1042 etc.
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,           -- E.164 format
  email           TEXT,
  age             INT,
  gender          TEXT,
  location        TEXT,
  occupation      TEXT,

  source          TEXT,                    -- 'Instagram Ad', 'Referral', etc.
  source_meta     JSONB DEFAULT '{}',      -- utm, campaign id, referrer

  stage           lead_stage DEFAULT 'new',
  score           INT DEFAULT 50,          -- 0-100 lead score
  budget          TEXT,
  interests       TEXT[],
  goals           TEXT[],

  consent         JSONB DEFAULT '{"calls":false,"whatsapp":false,"email":false}',
  consent_meta    JSONB DEFAULT '{}',      -- timestamp, IP, source of each consent

  assigned_to     UUID REFERENCES agents(id),
  next_followup_at TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,

  -- CRM linkage
  crm_provider    TEXT,
  crm_id          TEXT,
  crm_synced_at   TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_phone ON leads(phone);
CREATE INDEX idx_leads_assigned ON leads(assigned_to);
CREATE INDEX idx_leads_followup ON leads(next_followup_at) WHERE next_followup_at IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────
--   CALLS (Exotel + Whisper artefacts)
-- ────────────────────────────────────────────────────────────────────
CREATE TYPE call_status AS ENUM (
  'queued', 'ringing', 'in-progress', 'completed', 'failed', 'busy', 'no-answer'
);

CREATE TYPE transcription_status AS ENUM (
  'pending', 'processing', 'done', 'failed'
);

CREATE TABLE calls (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id          UUID REFERENCES agents(id),

  -- Exotel
  exotel_call_sid   TEXT UNIQUE,           -- vendor idempotency key
  direction         TEXT,                  -- 'inbound' | 'outbound-api'
  from_number       TEXT,
  to_number         TEXT,
  status            call_status DEFAULT 'queued',
  duration_secs     INT,
  recording_url     TEXT,                  -- Exotel-hosted URL (expires)
  recording_s3_key  TEXT,                  -- our archived copy

  -- Whisper
  transcript_status transcription_status DEFAULT 'pending',
  transcript        JSONB,                 -- [{who, t, text}, ...]
  transcript_text   TEXT,                  -- flattened for search

  -- LLM summary
  ai_summary        JSONB,                 -- {overview, keyPoints[], actionItems[], sentiment, sentimentScore, intent, objections[], nextSteps}

  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_calls_lead ON calls(lead_id);
CREATE INDEX idx_calls_status ON calls(status);
CREATE INDEX idx_calls_transcript_status ON calls(transcript_status) WHERE transcript_status != 'done';

-- ────────────────────────────────────────────────────────────────────
--   WHATSAPP MESSAGES (Interakt)
-- ────────────────────────────────────────────────────────────────────
CREATE TYPE msg_direction AS ENUM ('outbound', 'inbound');
CREATE TYPE msg_status AS ENUM ('queued','sent','delivered','read','failed');

CREATE TABLE whatsapp_messages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id          UUID REFERENCES agents(id),

  -- Interakt
  interakt_msg_id   TEXT UNIQUE,           -- vendor idempotency key
  direction         msg_direction NOT NULL,
  status            msg_status DEFAULT 'queued',

  body              TEXT,
  template_id       TEXT,                  -- HSM template name
  template_variables JSONB,
  attachment_url    TEXT,
  attachment_type   TEXT,                  -- 'image'|'document'|'video'

  failure_reason    TEXT,
  sent_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wa_lead_created ON whatsapp_messages(lead_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────
--   ACTIVITY TIMELINE (denormalised event log)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE activity (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id      UUID REFERENCES agents(id),
  type          TEXT NOT NULL,            -- 'call'|'whatsapp'|'note'|'lead'|'consult'|'stage_change'|'sync'
  title         TEXT NOT NULL,
  meta          JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_activity_lead ON activity(lead_id, created_at DESC);

-- ────────────────────────────────────────────────────────────────────
--   NOTES
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE notes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id      UUID REFERENCES agents(id),
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────
--   TASKS (auto-extracted from AI summaries + manual)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE tasks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_id       UUID REFERENCES calls(id) ON DELETE SET NULL,
  agent_id      UUID REFERENCES agents(id),
  title         TEXT NOT NULL,
  due_at        TIMESTAMPTZ,
  done          BOOLEAN DEFAULT FALSE,
  done_at       TIMESTAMPTZ,
  source        TEXT DEFAULT 'manual',    -- 'manual' | 'whisper'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────
--   WEBHOOK IDEMPOTENCY (prevent duplicate processing on retries)
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE webhook_events (
  id            TEXT PRIMARY KEY,         -- vendor's event id, e.g. "exotel:CallSid:CA-9001"
  vendor        TEXT NOT NULL,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────
--   CRM SYNC LOG
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE crm_syncs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  operation     TEXT NOT NULL,            -- 'upsert_contact' | 'log_engagement'
  request       JSONB,
  response      JSONB,
  success       BOOLEAN,
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────
--   updated_at trigger
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_touch BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
