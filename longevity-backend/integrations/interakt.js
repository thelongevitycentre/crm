// integrations/interakt.js
//
// Interakt WhatsApp Business integration:
//  - Send template messages (HSM) — required for messages outside the 24h window
//  - Send free-form text — only allowed within 24h of the lead's last reply
//  - Manage opt-in / opt-out per DPDP requirements
//
// API docs: https://www.interakt.shop/resource-center/integrate-with-api/

import axios from 'axios';

const API_KEY  = process.env.INTERAKT_API_KEY;
const BASE_URL = 'https://api.interakt.ai/v1/public';

if (!API_KEY) {
  console.warn('[interakt] missing API key — running in mock mode');
}

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: {
    Authorization: `Basic ${API_KEY}`,
    'Content-Type': 'application/json',
  },
});

// ════════════════════════════════════════════════════════════════════
//  TEMPLATE SEND (HSM — Highly Structured Messages)
//  Required when the 24h customer window is closed.
// ════════════════════════════════════════════════════════════════════

/**
 * Send a pre-approved WhatsApp template.
 *
 * @param {object} args
 * @param {string} args.phone           E.164 with leading + (e.g. +919876543210)
 * @param {string} args.templateName    Approved template name in Interakt
 * @param {string} args.languageCode    e.g. 'en'
 * @param {object} [args.headerValues]  { type, value } for media headers
 * @param {string[]} [args.bodyValues]  Body variables in order ({{1}}, {{2}}, ...)
 * @param {string[]} [args.buttonValues] Button URL/payload variables
 * @returns {Promise<{ id, status }>}
 */
export async function sendTemplate({
  phone,
  templateName,
  languageCode = 'en',
  headerValues,
  bodyValues = [],
  buttonValues = [],
}) {
  if (!API_KEY) return mockSend({ phone, type: 'template', body: templateName });

  const payload = {
    countryCode: phone.startsWith('+91') ? '+91' : phone.slice(0, phone.length - 10),
    phoneNumber: phone.replace(/^\+\d{1,3}/, ''),
    type: 'Template',
    template: {
      name: templateName,
      languageCode,
      bodyValues,
      ...(headerValues && { headerValues: [headerValues] }),
      ...(buttonValues.length && { buttonValues: { 0: buttonValues } }),
    },
  };

  const res = await client.post('/message/', payload);
  return { id: res.data?.id, status: res.data?.result };
}

// ════════════════════════════════════════════════════════════════════
//  SESSION MESSAGE (free-form)
//  Only allowed within 24h of the lead's last inbound message.
//  We enforce this in services/leadService.js — but Interakt enforces too.
// ════════════════════════════════════════════════════════════════════

export async function sendSessionMessage({ phone, body, mediaUrl, mediaType }) {
  if (!API_KEY) return mockSend({ phone, type: 'session', body });

  const payload = {
    countryCode: phone.startsWith('+91') ? '+91' : phone.slice(0, phone.length - 10),
    phoneNumber: phone.replace(/^\+\d{1,3}/, ''),
    callbackData: 'session_msg',
    type: mediaUrl ? 'Media' : 'Text',
    ...(mediaUrl ? {
      data: { mediaUrl, mediaType, caption: body }
    } : {
      data: { message: body }
    })
  };

  const res = await client.post('/message/', payload);
  return { id: res.data?.id, status: res.data?.result };
}

// ════════════════════════════════════════════════════════════════════
//  USER MANAGEMENT (track opt-in / opt-out for DPDP compliance)
// ════════════════════════════════════════════════════════════════════

export async function trackUser({ phone, name, traits = {} }) {
  if (!API_KEY) return { ok: true, mock: true };

  const payload = {
    userId: phone,
    countryCode: phone.startsWith('+91') ? '+91' : phone.slice(0, phone.length - 10),
    phoneNumber: phone.replace(/^\+\d{1,3}/, ''),
    traits: { name, ...traits },
  };
  const res = await client.post('/track/users/', payload);
  return res.data;
}

// ════════════════════════════════════════════════════════════════════
//  MOCK SEND (dev mode)
// ════════════════════════════════════════════════════════════════════

function mockSend({ phone, type, body }) {
  const id = 'IK-' + Math.random().toString(36).slice(2, 12).toUpperCase();
  console.log(`[interakt:mock] ${type} → ${phone}: ${body?.slice(0, 60)} (id ${id})`);
  return { id, status: 'sent' };
}
