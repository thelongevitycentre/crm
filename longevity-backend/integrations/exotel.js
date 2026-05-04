// integrations/exotel.js
//
// Exotel telephony integration:
//  - Click-to-call (agent → lead two-leg call via Exotel Connect API)
//  - Recording fetch + archival to S3
//  - Outbound API documentation: https://developer.exotel.com/api/
//
// The flow:
//  1. Frontend calls POST /api/leads/:id/call
//  2. We hit Exotel /Calls/connect.json
//  3. Exotel rings the agent's phone first, then bridges to the lead
//  4. Exotel hits our StatusCallback when the call ends → see webhooks/exotel.js

import axios from 'axios';
import FormData from 'form-data';

const SID    = process.env.EXOTEL_SID;
const KEY    = process.env.EXOTEL_API_KEY;
const TOKEN  = process.env.EXOTEL_API_TOKEN;
const SUB    = process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com';
const VNUM   = process.env.EXOTEL_VIRTUAL_NUMBER;

if (!SID || !KEY || !TOKEN) {
  console.warn('[exotel] missing credentials — running in mock mode');
}

const baseURL = `https://${KEY}:${TOKEN}@${SUB}/v1/Accounts/${SID}`;

const client = axios.create({
  baseURL,
  timeout: 15_000,
});

/**
 * Initiate a two-leg call: rings the agent first, then connects to the lead.
 *
 * @param {object} args
 * @param {string} args.agentNumber  Agent's phone (E.164) — Exotel rings this first
 * @param {string} args.leadNumber   Lead's phone (E.164)  — bridged after agent picks up
 * @param {string} args.callerId     ExoPhone shown on lead's caller ID (your VNUM)
 * @param {string} args.statusCallback URL Exotel hits when call completes
 * @param {string} [args.recordingChannel='dual']  'dual' for stereo (agent/lead separated)
 * @returns {Promise<{ Sid, Status, ... }>}
 */
export async function placeCall({ agentNumber, leadNumber, callerId, statusCallback, recordingChannel = 'dual' }) {
  if (process.env.NODE_ENV !== 'production' && !KEY) {
    return mockPlaceCall({ agentNumber, leadNumber });
  }

  const form = new FormData();
  form.append('From', agentNumber);
  form.append('To', leadNumber);
  form.append('CallerId', callerId || VNUM);
  form.append('Record', 'true');
  form.append('RecordingChannels', recordingChannel);
  form.append('StatusCallback', statusCallback);
  form.append('StatusCallbackEvents[0]', 'terminal');
  form.append('StatusCallbackContentType', 'application/json');
  form.append('TimeLimit', '3600');
  form.append('TimeOut', '30');

  const res = await client.post('/Calls/connect.json', form, {
    headers: form.getHeaders(),
  });

  return res.data?.Call;
}

/**
 * Fetch call details (used after webhook to enrich our record).
 */
export async function getCall(callSid) {
  const res = await client.get(`/Calls/${callSid}.json`);
  return res.data?.Call;
}

/**
 * Download the recording for a completed call.
 * Exotel-hosted URLs expire — archive promptly.
 */
export async function downloadRecording(recordingUrl) {
  const res = await axios.get(recordingUrl, {
    responseType: 'arraybuffer',
    auth: { username: KEY, password: TOKEN },
    timeout: 60_000,
  });
  return Buffer.from(res.data);
}

// Stub for local dev without credentials
function mockPlaceCall({ agentNumber, leadNumber }) {
  const sid = 'CA-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  console.log(`[exotel:mock] would place call ${agentNumber} → ${leadNumber} (sid ${sid})`);
  return { Sid: sid, Status: 'queued', From: agentNumber, To: leadNumber };
}
