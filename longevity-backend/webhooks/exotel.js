// webhooks/exotel.js
//
// Inbound webhooks from Exotel:
//  - StatusCallback   POST /webhooks/exotel/status     (call lifecycle events)
//  - RecordingCallback POST /webhooks/exotel/recording (when recording is ready)
//
// Both use HMAC SHA-256 verification (see middleware/verifySignature.js).
// We store an idempotency record per event so retries are safe.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { verifyExotel } from '../middleware/verifySignature.js';
import { handleCallCompleted } from '../services/leadService.js';

const router = Router();

// Exotel sends form-urlencoded by default. We accept JSON OR form data.
// IMPORTANT: this route uses express.raw() in server.js for HMAC verification.

// ════════════════════════════════════════════════════════════════════
//  POST /webhooks/exotel/status
//  Fired on every call state transition; we care about terminal states.
// ════════════════════════════════════════════════════════════════════
router.post('/status', verifyExotel, async (req, res) => {
  // Ack immediately — Exotel retries aggressively if we hold the response
  res.status(200).json({ received: true });

  try {
    const evt = req.body;
    const callSid = evt.CallSid;
    if (!callSid) return;

    const eventId = `exotel:status:${callSid}:${evt.Status || 'unknown'}`;

    // Idempotency: skip if we've already processed this exact event
    const dup = await pool.query(
      'INSERT INTO webhook_events (id, vendor, type, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id',
      [eventId, 'exotel', 'status', evt]
    );
    if (dup.rowCount === 0) return;

    // Update our calls row
    await pool.query(
      `UPDATE calls SET
         status = $1::call_status,
         duration_secs = COALESCE($2::int, duration_secs),
         ended_at = CASE WHEN $1 IN ('completed','failed','busy','no-answer') THEN NOW() ELSE ended_at END
       WHERE exotel_call_sid = $3`,
      [normalizeStatus(evt.Status), evt.ConversationDuration || evt.DialCallDuration, callSid]
    );

    // If terminal + recording present → kick off transcription pipeline
    if (evt.Status === 'completed' && evt.RecordingUrl) {
      await pool.query(
        'UPDATE calls SET recording_url = $1 WHERE exotel_call_sid = $2',
        [evt.RecordingUrl, callSid]
      );
      // Enqueue transcription. In production, push to BullMQ:
      //   await transcriptionQueue.add('transcribe', { callSid });
      // For scaffolding, run inline:
      handleCallCompleted({ callSid }).catch(err => {
        console.error(`[exotel] handleCallCompleted failed for ${callSid}:`, err);
      });
    }
  } catch (err) {
    console.error('[exotel] status webhook handler error:', err);
    // We've already ack'd — don't re-throw
  }
});

// ════════════════════════════════════════════════════════════════════
//  POST /webhooks/exotel/recording
//  Fired separately when the recording becomes available.
// ════════════════════════════════════════════════════════════════════
router.post('/recording', verifyExotel, async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const evt = req.body;
    const eventId = `exotel:recording:${evt.CallSid}`;

    const dup = await pool.query(
      'INSERT INTO webhook_events (id, vendor, type, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id',
      [eventId, 'exotel', 'recording', evt]
    );
    if (dup.rowCount === 0) return;

    await pool.query(
      'UPDATE calls SET recording_url = $1 WHERE exotel_call_sid = $2',
      [evt.RecordingUrl, evt.CallSid]
    );

    handleCallCompleted({ callSid: evt.CallSid }).catch(err => {
      console.error('[exotel] recording handler error:', err);
    });
  } catch (err) {
    console.error('[exotel] recording webhook error:', err);
  }
});

const normalizeStatus = (s) => {
  const m = { 'completed':'completed','failed':'failed','busy':'busy','no-answer':'no-answer','in-progress':'in-progress','ringing':'ringing','queued':'queued' };
  return m[s] || 'queued';
};

export default router;
