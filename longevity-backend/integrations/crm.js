// integrations/crm.js
//
// Generic CRM interface with HubSpot adapter (default).
// To add Zoho or Salesforce, implement the same three methods:
//   - upsertContact({ phone, email, name, ... })  → returns { crmId }
//   - logEngagement({ crmId, type, body, ... })   → returns { engagementId }
//   - getContact(crmId)                            → returns contact record
//
// Set CRM_PROVIDER in .env to switch.

import axios from 'axios';

const PROVIDER = process.env.CRM_PROVIDER || 'hubspot';
const API_KEY  = process.env.CRM_API_KEY;

// ════════════════════════════════════════════════════════════════════
//  HUBSPOT ADAPTER
//  https://developers.hubspot.com/docs/api/crm/contacts
// ════════════════════════════════════════════════════════════════════

const hubspot = axios.create({
  baseURL: 'https://api.hubapi.com',
  timeout: 15_000,
  headers: { Authorization: `Bearer ${API_KEY}` },
});

const hubspotAdapter = {
  /**
   * Upsert a contact by phone (preferred) or email.
   * Returns the HubSpot contact ID.
   */
  async upsertContact({ phone, email, name, age, location, source, stage, score, interests }) {
    const properties = {
      firstname: name?.split(' ')[0],
      lastname:  name?.split(' ').slice(1).join(' '),
      phone, email,
      city: location,
      hs_lead_source: source,
      lifecyclestage: mapStageToHubspot(stage),
      hs_lead_status: stage?.toUpperCase(),
      meridian_score: score,
      meridian_interests: interests?.join(';'),
      meridian_age: age,
    };

    // Try update by phone first, then create
    try {
      const search = await hubspot.post('/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
        limit: 1,
      });
      const existing = search.data?.results?.[0];

      if (existing) {
        await hubspot.patch(`/crm/v3/objects/contacts/${existing.id}`, { properties });
        return { crmId: existing.id, created: false };
      }

      const created = await hubspot.post('/crm/v3/objects/contacts', { properties });
      return { crmId: created.data.id, created: true };
    } catch (err) {
      throw new Error(`HubSpot upsert failed: ${err.response?.data?.message || err.message}`);
    }
  },

  /**
   * Log a call or note as a HubSpot engagement.
   * @param {object} args
   * @param {string} args.crmId
   * @param {'call'|'note'|'whatsapp'} args.type
   * @param {string} args.body
   * @param {object} [args.meta]  { duration, recordingUrl, sentiment, ... }
   */
  async logEngagement({ crmId, type, body, meta = {} }) {
    if (type === 'call') {
      const res = await hubspot.post('/crm/v3/objects/calls', {
        properties: {
          hs_call_body: body,
          hs_call_title: meta.title || 'Discovery call',
          hs_call_duration: meta.duration ? meta.duration * 1000 : undefined,
          hs_call_recording_url: meta.recordingUrl,
          hs_call_status: 'COMPLETED',
          hs_call_direction: meta.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
          hs_timestamp: new Date().toISOString(),
        },
        associations: [{
          to: { id: crmId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }],
        }],
      });
      return { engagementId: res.data.id };
    }

    // type === 'note' or 'whatsapp' (use note for WhatsApp logs)
    const res = await hubspot.post('/crm/v3/objects/notes', {
      properties: {
        hs_note_body: body,
        hs_timestamp: new Date().toISOString(),
      },
      associations: [{
        to: { id: crmId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
      }],
    });
    return { engagementId: res.data.id };
  },

  async getContact(crmId) {
    const res = await hubspot.get(`/crm/v3/objects/contacts/${crmId}`);
    return res.data;
  },
};

const mapStageToHubspot = (stage) => ({
  new:        'lead',
  contacted:  'lead',
  qualified:  'marketingqualifiedlead',
  consult:    'salesqualifiedlead',
  converted:  'customer',
  lost:       'other',
}[stage] || 'lead');

// ════════════════════════════════════════════════════════════════════
//  ZOHO / SALESFORCE — stubs for you to implement
// ════════════════════════════════════════════════════════════════════

const zohoAdapter = {
  async upsertContact() { throw new Error('Zoho adapter not implemented — see hubspotAdapter for pattern'); },
  async logEngagement()  { throw new Error('Zoho adapter not implemented'); },
  async getContact()     { throw new Error('Zoho adapter not implemented'); },
};

const salesforceAdapter = {
  async upsertContact() { throw new Error('Salesforce adapter not implemented'); },
  async logEngagement()  { throw new Error('Salesforce adapter not implemented'); },
  async getContact()     { throw new Error('Salesforce adapter not implemented'); },
};

// ════════════════════════════════════════════════════════════════════
//  MOCK ADAPTER (dev mode)
// ════════════════════════════════════════════════════════════════════

const mockAdapter = {
  async upsertContact(args) {
    const id = 'crm-' + Math.random().toString(36).slice(2, 10);
    console.log(`[crm:mock] upsert ${args.name} (${args.phone}) → ${id}`);
    return { crmId: id, created: true };
  },
  async logEngagement({ crmId, type, body }) {
    const id = 'eng-' + Math.random().toString(36).slice(2, 10);
    console.log(`[crm:mock] ${type} engagement on ${crmId}: ${body?.slice(0, 50)} → ${id}`);
    return { engagementId: id };
  },
  async getContact(crmId) {
    return { id: crmId, mock: true };
  },
};

// ════════════════════════════════════════════════════════════════════
//  EXPORT — single CRM facade
// ════════════════════════════════════════════════════════════════════

const adapters = {
  hubspot: hubspotAdapter,
  zoho: zohoAdapter,
  salesforce: salesforceAdapter,
};

export const crm = API_KEY ? (adapters[PROVIDER] || mockAdapter) : mockAdapter;
export const crmProvider = PROVIDER;
