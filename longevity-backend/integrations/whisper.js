// integrations/whisper.js
//
// Two-stage AI pipeline triggered after a call ends:
//   1. Whisper transcribes the recording (speaker-aware via dual-channel audio)
//   2. GPT-4o-mini generates: overview, key points, action items, sentiment, intent
//
// In production, run this from a worker (BullMQ) — calls can take 10-30s.
// The scaffold runs it inline; swap to queue in services/leadService.js.

import OpenAI from 'openai';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ════════════════════════════════════════════════════════════════════
//  TRANSCRIPTION
// ════════════════════════════════════════════════════════════════════

/**
 * Transcribe a buffer (e.g. from Exotel recording) using Whisper.
 *
 * @param {Buffer} audioBuf
 * @param {object} [opts]
 * @param {string} [opts.language='en']
 * @returns {Promise<{ text: string, segments: Array<{start, end, text}> }>}
 */
export async function transcribe(audioBuf, opts = {}) {
  // OpenAI SDK requires a file/path; write to a tmp file
  const tmp = path.join(os.tmpdir(), `call-${Date.now()}.mp3`);
  fs.writeFileSync(tmp, audioBuf);

  try {
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmp),
      model: process.env.WHISPER_MODEL || 'whisper-1',
      language: opts.language || 'en',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
    return {
      text: result.text,
      segments: result.segments || [],
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Produce a speaker-attributed transcript array.
 * Exotel can record dual-channel (agent on L, lead on R) — split before sending
 * each channel to Whisper, then interleave by timestamp for best accuracy.
 *
 * For mono recordings, fall back to a heuristic speaker-diarization prompt.
 */
export async function transcribeDualChannel({ leftBuf, rightBuf, leftLabel = 'agent', rightLabel = 'lead' }) {
  const [left, right] = await Promise.all([
    transcribe(leftBuf),
    transcribe(rightBuf),
  ]);

  const segments = [
    ...left.segments.map(s => ({ ...s, who: leftLabel })),
    ...right.segments.map(s => ({ ...s, who: rightLabel })),
  ].sort((a, b) => a.start - b.start);

  return {
    text: segments.map(s => `[${formatTime(s.start)}] ${s.who}: ${s.text}`).join('\n'),
    transcript: segments.map(s => ({
      who: s.who,
      t: formatTime(s.start),
      text: s.text.trim(),
    })),
  };
}

const formatTime = (s) => `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;

// ════════════════════════════════════════════════════════════════════
//  SUMMARISATION
// ════════════════════════════════════════════════════════════════════

const SUMMARY_SCHEMA = z.object({
  overview: z.string().describe('2-4 sentence executive summary'),
  keyPoints: z.array(z.string()).describe('3-6 bullet points of the most important info from the call'),
  objections: z.array(z.string()).describe('Concerns or hesitations the lead raised — empty array if none'),
  actionItems: z.array(z.object({
    text: z.string(),
    owner: z.string().describe("'agent' | 'lead' | 'doctor' | a specific person if named"),
    due: z.string().describe("'today' | 'this week' | a specific date if mentioned"),
  })),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  sentimentScore: z.number().min(-1).max(1),
  intent: z.enum(['high', 'medium', 'low']),
  nextSteps: z.string().describe('What should happen next, in one sentence'),
  recommendedStage: z.enum(['new','contacted','qualified','consult','converted','lost']).optional(),
});

const SUMMARY_PROMPT = `You are an analyst at a premium longevity clinic. You will receive a transcript of a call between a Care Coordinator (agent) and a prospective patient (lead).

Extract a structured summary. Be precise and clinical — do not speculate beyond what the transcript supports. If the lead expressed clear next steps (e.g. "send me details", "book me in"), capture them as action items with owner=agent.

Sentiment is the lead's emotional tone toward our services (NOT toward life in general). Intent is how close they appear to be to booking — "high" = they verbally agreed to a next step, "medium" = engaged but uncommitted, "low" = pushed back or showed no interest.

If the lead made firm progress (booked a consult, paid, or said "yes go ahead"), recommend stage advancement.

Return JSON matching the provided schema exactly.`;

/**
 * Run an LLM over the transcript and return a structured summary.
 * @param {string} transcriptText
 * @param {object} [leadContext]   { name, age, source, interests, goals }
 */
export async function summarize(transcriptText, leadContext = {}) {
  const userMsg = [
    leadContext && `Lead context:\n${JSON.stringify(leadContext, null, 2)}`,
    `\nTranscript:\n${transcriptText}`,
  ].filter(Boolean).join('\n');

  const completion = await openai.chat.completions.create({
    model: process.env.SUMMARY_MODEL || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.2,
  });

  const raw = completion.choices[0].message.content;
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`Whisper summary returned invalid JSON: ${e.message}`); }

  // Validate against our schema (catches drift in LLM output shape)
  const result = SUMMARY_SCHEMA.safeParse(parsed);
  if (!result.success) {
    console.error('[whisper] summary schema validation failed:', result.error.issues);
    // Return best-effort instead of throwing — still useful even if partial
    return parsed;
  }
  return result.data;
}

// ════════════════════════════════════════════════════════════════════
//  END-TO-END PIPELINE
// ════════════════════════════════════════════════════════════════════

/**
 * Full pipeline: audio → transcript → summary.
 * Used by services/leadService.js after Exotel webhook delivers the recording.
 */
export async function processCallRecording({ audioBuf, leadContext }) {
  const { text, segments } = await transcribe(audioBuf);
  const transcript = segments.map(s => ({
    who: 'unknown',                  // single-channel — see transcribeDualChannel for split
    t: formatTime(s.start),
    text: s.text.trim(),
  }));
  const summary = await summarize(text, leadContext);
  return { transcriptText: text, transcript, summary };
}
