// services/leadService.js
//
// The orchestration layer. This is where the integrations are choreographed
// into the actual business flows.
//
// Key responsibilities:
//  - Place outbound calls (consent check → Exotel)
//  - Send WhatsApp (consent + 24h window check → Interakt)
//  - Process completed calls (download recording → Whisper → save → CRM sync)
//  - Stage advancement based on AI signals
//  - Activity log + CRM sync

import { pool } from '../db/pool.js';
import * as exotel from '../integrations/exotel.js';
import * as whisper from '../integrations/whisper.js';
import * as interakt from '../integrations/interakt.js';
import { crm, crmProvider } from '../integrations/crm.js';
import { archiveRecording } from '../integrations/storage.js';

// ════════════════════════════════════════════════════════════════════
//  PLACE A CALL
// ════════════════════════════════════════════════════════════════════

export async function placeCallToLead({ leadId, agentId }) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error('Lead not found');
  if (!lead.consent?.calls) throw new Error('Lead has not consented to calls');

  const agent = await getAgent(agentId);
  if (!agent?.phone) throw new Error('Agent has no calling number on file');

  const statusCallback = `${process.env.PUBLIC_BASE_URL}/webhooks/exotel/status`;

  const call = await exotel.placeCall({
    agentNumber: agent.phone,
    leadNumber: lead.phone,
    callerId: agent.exotel_caller_id,
    statusCallback,
  });

  // Persist
  const insert = await pool.query(
    `INSERT INTO calls
       (lead_id, agent_id, exotel_call_sid, direction, from_number, to_number, status, started_at)
     VALUES ($1, $2, $3, 'outbound-api', $4, $5, $6::call_status, NOW())
     RETURNING *`,
    [leadId, agentId, call.Sid, agent.phone, lead.phone, call.Status || 'queued']
  );

  await pool.query(
    `INSERT INTO activity (lead_id, agent_id, type, title, meta)
     VALUES ($1, $2, 'call', 'Outbound call initiated', $3)`,
    [leadId, agentId, { callSid: call.Sid }]
  );

  await pool.query('UPDATE leads SET last_contact_at = NOW() WHERE id = $1', [leadId]);

  return insert.rows[0];
}

// ════════════════════════════════════════════════════════════════════
//  PROCESS COMPLETED CALL  (called from webhook)
// ════════════════════════════════════════════════════════════════════

export async function handleCallCompleted({ callSid }) {
  const callRow = await pool.query(
    'SELECT c.*, l.name as lead_name, l.age, l.source, l.interests, l.goals, l.crm_id FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.exotel_call_sid = $1',
    [callSid]
  );
  const call = callRow.rows[0];
  if (!call) { console.warn(`[leadService] no call row for ${callSid}`); return; }
  if (call.transcript_status === 'done') return;
  if (!call.recording_url) { console.warn(`[leadService] ${callSid} has no recording yet`); return; }

  await pool.query(
    "UPDATE calls SET transcript_status = 'processing' WHERE id = $1",
    [call.id]
  );

  try {
    // 1. Download recording from Exotel + archive to S3
    const audioBuf = await exotel.downloadRecording(call.recording_url);
    const s3Key = await archiveRecording({ buf: audioBuf, callId: call.id });

    // 2. Transcribe + summarise
    const { transcriptText, transcript, summary } = await whisper.processCallRecording({
      audioBuf,
      leadContext: {
        name: call.lead_name,
        age: call.age,
        source: call.source,
        interests: call.interests,
        goals: call.goals,
      },
    });

    // 3. Persist
    await pool.query(
      `UPDATE calls SET
         transcript_status = 'done',
         transcript = $1,
         transcript_text = $2,
         ai_summary = $3,
         recording_s3_key = $4
       WHERE id = $5`,
      [JSON.stringify(transcript), transcriptText, JSON.stringify(summary), s3Key, call.id]
    );

    // 4. Auto-advance lead stage if recommended
    if (summary.recommendedStage && summary.intent === 'high') {
      await advanceStage(call.lead_id, summary.recommendedStage);
    }

    // 5. Auto-create tasks from action items
    for (const a of (summary.actionItems || [])) {
      await pool.query(
        `INSERT INTO tasks (lead_id, call_id, title, source) VALUES ($1, $2, $3, 'whisper')`,
        [call.lead_id, call.id, a.text]
      );
    }

    // 6. Activity timeline
    await pool.query(
      `INSERT INTO activity (lead_id, type, title, meta)
       VALUES ($1, 'call', 'Call completed · AI summary ready', $2)`,
      [call.lead_id, { callSid, sentiment: summary.sentiment, intent: summary.intent }]
    );

    // 7. Sync to CRM
    if (call.crm_id) {
      const body = `${summary.overview}\n\nNext steps: ${summary.nextSteps}\n\nSentiment: ${summary.sentiment} (${summary.sentimentScore})`;
      try {
        await crm.logEngagement({
          crmId: call.crm_id, type: 'call', body,
          meta: {
            title: `Call · ${summary.intent} intent`,
            duration: call.duration_secs,
            recordingUrl: call.recording_url,
            direction: 'outbound',
          },
        });
        await pool.query(
          'INSERT INTO crm_syncs (lead_id, provider, operation, success) VALUES ($1, $2, $3, $4)',
          [call.lead_id, crmProvider, 'log_engagement', true]
        );
      } catch (err) {
        await pool.query(
          'INSERT INTO crm_syncs (lead_id, provider, operation, success, error) VALUES ($1, $2, $3, $4, $5)',
          [call.lead_id, crmProvider, 'log_engagement', false, err.message]
        );
      }
    }
  } catch (err) {
    await pool.query(
      "UPDATE calls SET transcript_status = 'failed' WHERE id = $1",
      [call.id]
    );
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════
//  SEND WHATSAPP TO LEAD
// ════════════════════════════════════════════════════════════════════

export async function sendWhatsAppToLead({ leadId, agentId, templateName, bodyValues, freeFormText }) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error('Lead not found');
  if (!lead.consent?.whatsapp) throw new Error('Lead has not consented to WhatsApp');

  let result, body;

  if (freeFormText) {
    // Free-form requires open 24h session
    const last = await pool.query(
      `SELECT created_at FROM whatsapp_messages
       WHERE lead_id = $1 AND direction = 'inbound'
       ORDER BY created_at DESC LIMIT 1`,
      [leadId]
    );
    const lastInbound = last.rows[0]?.created_at;
    const hoursOpen = lastInbound ? (Date.now() - new Date(lastInbound).getTime()) / 3.6e6 : Infinity;
    if (hoursOpen > 24) throw new Error('24-hour session window closed — send a template instead');

    result = await interakt.sendSessionMessage({ phone: lead.phone, body: freeFormText });
    body = freeFormText;
  } else {
    result = await interakt.sendTemplate({
      phone: lead.phone,
      templateName,
      bodyValues,
    });
    body = `[Template: ${templateName}] ${(bodyValues || []).join(' | ')}`;
  }

  await pool.query(
    `INSERT INTO whatsapp_messages
       (lead_id, agent_id, interakt_msg_id, direction, status, body, template_id, template_variables)
     VALUES ($1, $2, $3, 'outbound', 'sent', $4, $5, $6)`,
    [leadId, agentId, result.id, body, templateName || null, JSON.stringify(bodyValues || [])]
  );

  await pool.query('UPDATE leads SET last_contact_at = NOW() WHERE id = $1', [leadId]);

  return result;
}

// ════════════════════════════════════════════════════════════════════
//  HANDLE INCOMING WHATSAPP (called from webhook)
// ════════════════════════════════════════════════════════════════════

export async function handleIncomingWhatsApp({ leadId, message }) {
  const lead = await getLead(leadId);
  if (!lead) return;

  // Auto-update stage on first reply
  if (lead.stage === 'new') {
    await advanceStage(leadId, 'contacted');
  }

  // Honour DPDP "STOP" / opt-out keywords
  const text = (message.body || '').toUpperCase().trim();
  if (['STOP', 'UNSUBSCRIBE', 'OPT OUT'].includes(text)) {
    await pool.query(
      `UPDATE leads SET consent = jsonb_set(consent, '{whatsapp}', 'false') WHERE id = $1`,
      [leadId]
    );
    await pool.query(
      `INSERT INTO activity (lead_id, type, title, meta) VALUES ($1, 'note', 'Lead opted out of WhatsApp', $2)`,
      [leadId, { keyword: text }]
    );
  }

  // Sync to CRM
  if (lead.crm_id) {
    try {
      await crm.logEngagement({
        crmId: lead.crm_id, type: 'note',
        body: `Inbound WhatsApp: "${(message.body || '').slice(0, 200)}"`,
      });
    } catch (err) {
      console.error('[leadService] CRM sync failed:', err.message);
    }
  }
}

// ════════════════════════════════════════════════════════════════════
//  STAGE ADVANCEMENT
// ════════════════════════════════════════════════════════════════════

export async function advanceStage(leadId, newStage) {
  const before = await pool.query('SELECT stage FROM leads WHERE id = $1', [leadId]);
  const oldStage = before.rows[0]?.stage;
  if (oldStage === newStage) return;

  await pool.query('UPDATE leads SET stage = $1::lead_stage WHERE id = $2', [newStage, leadId]);
  await pool.query(
    `INSERT INTO activity (lead_id, type, title, meta) VALUES ($1, 'stage_change', $2, $3)`,
    [leadId, `Stage: ${oldStage} → ${newStage}`, { from: oldStage, to: newStage }]
  );
}

// ────────────────────────────────────────────────────
//  helpers
// ────────────────────────────────────────────────────
const getLead = async (id) => {
  const r = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
  return r.rows[0];
};
const getAgent = async (id) => {
  const r = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
  return r.rows[0];
};
