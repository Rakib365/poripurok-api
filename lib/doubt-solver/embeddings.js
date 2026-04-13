/**
 * Gemini Embedding client for the Doubt Solver.
 *
 * The ai-support-agent's lib/llm handles chat/text generation only —
 * embeddings live in a separate module. We follow the same split.
 *
 * Model: gemini-embedding-2-preview (multimodal, 1536D)
 */

import { getNextKey } from '../llm/utils/api-key-rotator.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-embedding-2-preview';
const DEFAULT_DIMS = 1536;
const DEFAULT_TIMEOUT_MS = 60_000;

function model() {
  return process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_MODEL;
}

function apiKey() {
  const fromRotator = getNextKey();
  if (fromRotator) return fromRotator.key;
  const direct = process.env.GEMINI_API_KEY;
  if (!direct) throw new Error('No Gemini API key configured');
  return direct;
}

/**
 * Batch-embed an array of texts in a single request.
 * Uses `:batchEmbedContents`.
 *
 * @param {string[]} texts
 * @param {object} [options]
 * @param {'RETRIEVAL_QUERY'|'RETRIEVAL_DOCUMENT'} [options.taskType='RETRIEVAL_QUERY']
 * @param {number} [options.outputDimensionality=1536]
 * @returns {Promise<number[][]>}
 */
export async function batchEmbedTexts(texts, {
  taskType = 'RETRIEVAL_QUERY',
  outputDimensionality = DEFAULT_DIMS,
} = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const m = model();
  const url = `${BASE_URL}/models/${m}:batchEmbedContents?key=${apiKey()}`;
  const body = {
    requests: texts.map(text => ({
      model: `models/${m}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality,
    })),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini batchEmbed ${res.status}: ${err.slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.embeddings || []).map(e => e.values);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Embed a single text.
 */
export async function embedText(text, options = {}) {
  const [v] = await batchEmbedTexts([text], options);
  return v;
}
