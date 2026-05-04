// webhooks/interakt.js
//
// Inbound webhooks from Interakt:
//  - POST /webhooks/interakt/incoming → lead replied or sent a new message
//  - POST /webhooks/interakt/status   → message status update (sent/delivered/read/failed)
//
// HMAC SHA-256 verification mandatory.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { verifyInterakt } from '../middleware/verifySignature.js';
import { handleIncomingWhatsApp } from '../services/leadService.js';

const router = Router();

// ════════════════════════════════════════════════════════════════════
//  POST /webhooks/interakt/incoming
//  Lead sent a WhatsApp message to our number.
// ════════════════════════════════════════════════════════════════════
router.post('/incoming', verifyInterakt, async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const evt = req.body;
    // Interakt event shape: { type:'message_received', data: { id, from, body, ... } }
    const msg = evt.data || evt;
    const eventId = `interakt:msg:${msg.id}`;

    const dup = await pool.query(
      'INSERT INTO webhook_events (id, vendor, type, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id',
      [eventId, 'interakt', 'incoming', evt]
    );
    if (dup.rowCount === 0) return;

    // Find or create lead by phone
    const phone = normalizePhone(msg.from || msg.phone);
    let lead = await findLeadByPhone(phone);

    if (!lead) {
      // Inbound message from unknown number — create lead with minimal info
      const created = await pool.query(
        `INSERT INTO leads (display_id, name, phone, source, stage)
         VALUES ($1, $2, $3, 'whatsapp_inbound', 'new') RETURNING *`,
        [`L-${Date.now().toString().slice(-5)}`, msg.profile?.name || 'WhatsApp Lead', phone]
      );
      lead = created.rows[0];
    }

    // Persist the inbound message
    await pool.query(
      `INSERT INTO whatsapp_messages
         (lead_id, interakt_msg_id, direction, status, body, attachment_url, attachment_type)
       VALUES ($1, $2, 'inbound', 'delivered', $3, $4, $5)
       ON CONFLICT (interakt_msg_id) DO NOTHING`,
      [lead.id, msg.id, msg.body || msg.text, msg.mediaUrl, msg.mediaType]
    );

    await pool.query(
      `INSERT INTO activity (lead_id, type, title, meta)
       VALUES ($1, 'whatsapp', 'Inbound WhatsApp message', $2)`,
      [lead.id, { messageId: msg.id, preview: (msg.body || '').slice(0, 80) }]
    );

    // Hand off to lead service for any orchestration
    // (e.g. mark consent if lead replied with "YES", advance stage on certain triggers)
    handleIncomingWhatsApp({ leadId: lead.id, message: msg }).catch(err => {
      console.error('[interakt] handleIncomingWhatsApp error:', err);
    });
  } catch (err) {
    console.error('[interakt] incoming webhook error:', err);
  }
});

// ════════════════════════════════════════════════════════════════════
//  POST /webhooks/interakt/status
//  Message status updates — sent → delivered → read.
// ════════════════════════════════════════════════════════════════════
router.post('/status', verifyInterakt, async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const evt = req.body;
    const data = evt.data || evt;
    const eventId = `interakt:status:${data.id}:${data.status}`;

    const dup = await pool.query(
      'INSERT INTO webhook_events (id, vendor, type, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING id',
      [eventId, 'interakt', 'status', evt]
    );
    if (dup.rowCount === 0) return;

    const stamps = {
      sent:      'sent_at',
      delivered: 'delivered_at',
      read:      'read_at',
    };
    const stampCol = stamps[data.status];

    if (stampCol) {
      await pool.query(
        `UPDATE whatsapp_messages
           SET status = $1::msg_status, ${stampCol} = NOW()
           WHERE interakt_msg_id = $2`,
        [data.status, data.id]
      );
    } else if (data.status === 'failed') {
      await pool.query(
        `UPDATE whatsapp_messages
           SET status = 'failed', failure_reason = $1
           WHERE interakt_msg_id = $2`,
        [data.error || 'unknown', data.id]
      );
    }
  } catch (err) {
    console.error('[interakt] status webhook error:', err);
  }
});

// ────────────────────────────────────────────────────
//  helpers
// ────────────────────────────────────────────────────
const normalizePhone = (p) => {
  if (!p) return null;
  if (p.startsWith('+')) return p;
  // Interakt sometimes sends without +
  return '+' + p;
};

const findLeadByPhone = async (phone) => {
  const res = await pool.query('SELECT * FROM leads WHERE phone = $1 LIMIT 1', [phone]);
  return res.rows[0];
};

export default router;
