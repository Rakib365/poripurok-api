/**
 * Upstash Vector client for the Doubt Solver KB.
 * Simple REST calls — no SDK.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

function config() {
  const url = process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN must be set');
  return { url, token };
}

async function request(path, body, { method = 'POST' } = {}) {
  const { url, token } = config();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Upstash Vector ${res.status}: ${errText.slice(0, 300)}`);
    }

    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Query the vector index.
 *
 * @param {number[]} vector - query embedding
 * @param {object} [options]
 * @param {number} [options.topK=3]
 * @param {boolean} [options.includeMetadata=true]
 * @returns {Promise<Array<{ id, score, metadata }>>}
 */
export async function queryVector(vector, { topK = 3, includeMetadata = true, filter } = {}) {
  const body = { vector, topK, includeMetadata, includeVectors: false };
  if (filter) body.filter = filter;

  const data = await request('/query', body);
  return Array.isArray(data) ? data : (data.result || data);
}

/**
 * Index info (vector count, dimension, similarity function).
 */
export async function getInfo() {
  const data = await request('/info', null, { method: 'GET' });
  return data.result || data;
}
