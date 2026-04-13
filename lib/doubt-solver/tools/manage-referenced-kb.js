/**
 * manage_referenced_kb tool
 *
 * Re-fetches reference sets from earlier turns of this conversation.
 * Returns a compact JSON the LLM can reason over, plus `_images` for the
 * agent loop to attach as fileData parts so the LLM can actually read
 * the page images again.
 */

import { fetchRefSets } from '../reference-matcher.js';
import { getRegistry } from '../local-id-registry.js';

const DEFAULT_CDN_BASE = 'https://files.poripurok.com/kb';

function imageUrl(imageFile) {
  const base = process.env.DOUBT_KB_CDN_BASE || DEFAULT_CDN_BASE;
  return `${base}/${imageFile}`;
}

export const manageReferencedKb = {
  name: 'manage_referenced_kb',
  description: 'Re-fetch reference sets from earlier in this conversation. The page images are attached alongside the result so you can reason over them again.',
  schema: {
    type: 'object',
    properties: {
      ref_set_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference set IDs from <available_reference_sets>, e.g. ["ref_set_1", "ref_set_3"]',
      },
    },
    required: ['ref_set_ids'],
  },

  async handler({ ref_set_ids }, ctx) {
    if (!Array.isArray(ref_set_ids) || ref_set_ids.length === 0) {
      return { error: 'ref_set_ids must be a non-empty array' };
    }
    if (!ctx?.conversationId) {
      return { error: 'conversationId required in context' };
    }

    const sets = await fetchRefSets(ctx.conversationId, ref_set_ids);
    const registry = await getRegistry(ctx.conversationId);

    const refSets = [];
    const imageParts = [];
    const seen = new Set();

    for (const set of sets) {
      const localIds = [];
      for (const localId of set.image_ids || []) {
        const uuid = registry.forward[localId];
        if (!uuid) continue;
        localIds.push(localId);
        if (!seen.has(localId)) {
          seen.add(localId);
          imageParts.push({
            url: imageUrl(uuid),
            mimeType: 'image/png',
            local_id: localId,
          });
        }
      }
      refSets.push({
        ref_set_id: set.ref_set_id,
        summary: set.summary,
        image_ids: localIds,
      });
    }

    return {
      ref_sets: refSets,
      _images: imageParts,
    };
  },
};
