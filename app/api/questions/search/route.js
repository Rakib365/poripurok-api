import { validateClientKey } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

const UPSTASH_URL = process.env.UPSTASH_SEARCH_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_SEARCH_REST_TOKEN;
const NAMESPACE = 'questions';

/**
 * POST /api/questions/search
 * Search questions using Upstash hybrid search (semantic + keyword).
 *
 * Body: { query, filters?, limit?, offset? }
 * filters: { subject?, difficulty?, institution?, unit?, session?, chapter?, questionType?, hasImage?, hasSolution? }
 */
export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const { query, filters = {}, limit = 20, offset = 0 } = await request.json();

    if (!query || typeof query !== 'string') {
      return error('query is required');
    }

    // Build Upstash filter on content fields (supports single value or array for OR)
    const filterParts = [];
    const textFields = ['subject', 'difficulty', 'institution', 'unit', 'session', 'chapter', 'questionType'];
    for (const field of textFields) {
      const val = filters[field];
      if (!val) continue;
      if (Array.isArray(val)) {
        if (val.length === 1) filterParts.push(`${field} = '${val[0]}'`);
        else if (val.length > 1) filterParts.push(`(${val.map(v => `${field} = '${v}'`).join(' OR ')})`);
      } else {
        filterParts.push(`${field} = '${val}'`);
      }
    }
    if (typeof filters.hasImage === 'boolean') filterParts.push(`hasImage = ${filters.hasImage}`);
    if (typeof filters.hasSolution === 'boolean') filterParts.push(`hasSolution = ${filters.hasSolution}`);

    const searchBody = {
      query,
      topK: limit + offset,
      includeMetadata: true,
      includeData: true,
      includeContent: true,
    };

    if (filterParts.length > 0) {
      searchBody.filter = filterParts.join(' AND ');
    }

    const res = await fetch(`${UPSTASH_URL}/search/${NAMESPACE}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(searchBody),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('Upstash search failed', { status: res.status, body: text });
      return error('Search service error', 502);
    }

    const data = await res.json();
    const allResults = data.result || [];
    const results = allResults.slice(offset, offset + limit);

    return success({
      results: results.map(r => ({
        id: r.id,
        score: r.score,
        searchText: r.data,
        content: r.content,
        metadata: r.metadata,
      })),
      total: allResults.length,
      limit,
      offset,
      query,
      filters,
    });
  } catch (e) {
    logger.error('search error', { error: e.message });
    return error('Internal server error', 500);
  }
}
