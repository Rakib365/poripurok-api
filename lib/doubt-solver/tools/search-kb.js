/**
 * search_kb tool
 *
 * Vector-searches the Biology/Chemistry KB. Only the LLM-facing response is
 * returned from the handler; the agent loop extracts `_images` and attaches
 * them as fileData parts alongside the text result (pattern borrowed from
 * ai-support-agent's browse_website/get_previous_conversations tools).
 *
 * Input (from LLM): { queries: string[] }
 *   — topK is NOT exposed to the LLM; it's a backend concern.
 *
 * Return shape (what the LLM sees after the agent loop processes `_images`):
 *   {
 *     total_unique_images: 4,
 *     images: [
 *       { local_id: "R1", subject: "biology-2nd", page: 115, matched_queries: ["রূপান্তর প্রক্রিয়া"] }
 *     ],
 *     query_hits: {
 *       "রূপান্তর প্রক্রিয়া": ["R1", "R3"]
 *     }
 *   }
 * Plus the image files themselves attached as subsequent fileData parts.
 */

import { batchEmbedTexts } from '../embeddings.js';
import { queryVector } from '../upstash-vector.js';
import { getRegistry, assignLocalId, saveRegistry } from '../local-id-registry.js';

const TOPK = 3;                            // backend-controlled
const DEFAULT_CDN_BASE = 'https://files.poripurok.com/kb';

function imageUrl(imageFile) {
  const base = process.env.DOUBT_KB_CDN_BASE || DEFAULT_CDN_BASE;
  return `${base}/${imageFile}`;
}

export const searchKb = {
  name: 'search_kb',
  description: 'Vector-search the Biology/Chemistry textbook KB. Pass an array of clean retrieval queries; receive matched page images with conversation-scoped local IDs (R1, R2, ...). The actual page images are attached alongside the result so you can read them directly.',
  schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Retrieval queries (one per distinct topic). Rewrite the student\'s raw question into focused topical phrases before passing them here.',
      },
    },
    required: ['queries'],
  },

  async handler({ queries }, ctx) {
    if (!Array.isArray(queries) || queries.length === 0) {
      return { error: 'queries must be a non-empty array' };
    }
    if (!ctx?.conversationId) {
      return { error: 'conversationId required in context' };
    }

    // 1. Batch embed all queries in a single API call
    const embeddings = await batchEmbedTexts(queries, { taskType: 'RETRIEVAL_QUERY' });

    // 2. Parallel vector searches
    const searchResults = await Promise.all(
      embeddings.map(emb => queryVector(emb, { topK: TOPK }))
    );

    // 3. Merge + dedupe, tracking which queries matched each image
    const imageMap = new Map(); // imageFile -> { metadata, matched_queries: string[] }

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const hits = searchResults[i] || [];
      for (const hit of hits) {
        const imageFile = hit.metadata?.imageFile;
        if (!imageFile) continue;
        const existing = imageMap.get(imageFile);
        if (!existing) {
          imageMap.set(imageFile, {
            metadata: hit.metadata,
            matched_queries: [query],
          });
        } else if (!existing.matched_queries.includes(query)) {
          existing.matched_queries.push(query);
        }
      }
    }

    // 4. Assign local IDs
    const registry = await getRegistry(ctx.conversationId);

    const images = [];
    const imageParts = [];
    for (const [imageFile, info] of imageMap.entries()) {
      const localId = assignLocalId(registry, imageFile);
      images.push({
        local_id: localId,
        subject: info.metadata.subject,
        page: info.metadata.page,
        matched_queries: info.matched_queries,
      });
      imageParts.push({
        url: imageUrl(imageFile),
        mimeType: 'image/png',
        local_id: localId,
      });
    }

    // 5. Per-query hits — just local IDs, no scores (keep it minimal for the LLM)
    const query_hits = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const hits = (searchResults[i] || []).map(h => registry.reverse[h.metadata?.imageFile]).filter(Boolean);
      query_hits[q] = hits;
    }

    await saveRegistry(ctx.conversationId);

    return {
      total_unique_images: images.length,
      images,
      query_hits,
      _images: imageParts, // consumed by agent-loop, stripped before sending to LLM
    };
  },
};
