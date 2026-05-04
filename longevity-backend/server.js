// server.js
//
// Express app entry. Wires up REST routes, webhook routes, and middleware.
//
// Webhook routes use express.raw() so we can compute HMAC over the raw body
// before parsing. REST routes use the standard JSON parser.

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';

import exotelWebhooks from './webhooks/exotel.js';
import interaktWebhooks from './webhooks/interakt.js';
import {
  placeCallToLead,
  sendWhatsAppToLead,
  advanceStage,
} from './services/leadService.js';
import { pool } from './db/pool.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(morgan('tiny'));

// ════════════════════════════════════════════════════════════════════
//  WEBHOOK ROUTES — must use raw body for HMAC verification
// ════════════════════════════════════════════════════════════════════
app.use('/webhooks/exotel',   express.raw({ type: '*/*', limit: '2mb' }), exotelWebhooks);
app.use('/webhooks/interakt', express.raw({ type: '*/*', limit: '2mb' }), interaktWebhooks);

// ════════════════════════════════════════════════════════════════════
//  REST API
// ════════════════════════════════════════════════════════════════════
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'down', error: err.message });
  }
});

// List leads (with simple filtering)
app.get('/api/leads', async (req, res, next) => {
  try {
    const { stage, q } = req.query;
    const params = [];
    let where = '1=1';
    if (stage)  { params.push(stage); where += ` AND stage = $${params.length}::lead_stage`; }
    if (q)      { params.push(`%${q}%`); where += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`; }
    const r = await pool.query(`SELECT * FROM leads WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ leads: r.rows });
  } catch (err) { next(err); }
});

// Lead detail with related data
app.get('/api/leads/:id', async (req, res, next) => {
  try {
    const lead = await pool.query('SELECT * FROM leads WHERE id = $1', [req.params.id]);
    if (!lead.rows[0]) return res.status(404).json({ error: 'not found' });

    const [calls, messages, activity, notes, tasks] = await Promise.all([
      pool.query('SELECT * FROM calls WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM whatsapp_messages WHERE lead_id = $1 ORDER BY created_at ASC', [req.params.id]),
      pool.query('SELECT * FROM activity WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM notes WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.id]),
      pool.query('SELECT * FROM tasks WHERE lead_id = $1 AND done = false ORDER BY created_at DESC', [req.params.id]),
    ]);

    res.json({
      lead: lead.rows[0],
      calls: calls.rows,
      whatsapp: messages.rows,
      activity: activity.rows,
      notes: notes.rows,
      tasks: tasks.rows,
    });
  } catch (err) { next(err); }
});

// Place call
app.post('/api/leads/:id/call', async (req, res, next) => {
  try {
    const { agentId } = req.body;
    const call = await placeCallToLead({ leadId: req.params.id, agentId });
    res.json({ call });
  } catch (err) { next(err); }
});

// Send WhatsApp
app.post('/api/leads/:id/whatsapp', async (req, res, next) => {
  try {
    const { agentId, templateName, bodyValues, freeFormText } = req.body;
    const result = await sendWhatsAppToLead({
      leadId: req.params.id, agentId, templateName, bodyValues, freeFormText,
    });
    res.json({ result });
  } catch (err) { next(err); }
});

// Update stage manually
app.patch('/api/leads/:id/stage', async (req, res, next) => {
  try {
    await advanceStage(req.params.id, req.body.stage);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Add note
app.post('/api/leads/:id/notes', async (req, res, next) => {
  try {
    const { agentId, body } = req.body;
    const r = await pool.query(
      'INSERT INTO notes (lead_id, agent_id, body) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, agentId, body]
    );
    await pool.query(
      `INSERT INTO activity (lead_id, agent_id, type, title) VALUES ($1, $2, 'note', 'Note added')`,
      [req.params.id, agentId]
    );
    res.json({ note: r.rows[0] });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════
//  ERROR HANDLER
// ════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('[api] error:', err);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

app.listen(PORT, () => {
  console.log(`▸ Meridian Longevity backend running on :${PORT}`);
  console.log(`▸ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`▸ Webhooks expected at ${process.env.PUBLIC_BASE_URL || 'http://localhost:' + PORT}/webhooks/{exotel,interakt}/*`);
});
