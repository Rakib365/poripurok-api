import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import {
  createBookmark, deleteBookmark, listBookmarks, isBookmarked,
} from '@/lib/doubt-solver/bookmark-store';

/**
 * POST   /api/doubt-solver/bookmark        — create bookmark
 * DELETE /api/doubt-solver/bookmark        — remove bookmark (body: { bookmarkId } or { type, target })
 * GET    /api/doubt-solver/bookmark?type=... — list user's bookmarks
 *
 * Body for POST:
 *   {
 *     type: 'doubt_message' | 'question' | 'exam' | 'study_book',
 *     target: { ... },   // type-specific identifiers
 *     metadata: { title, preview?, subject?, thumbnailUrl?, sourceLabel?, extra? }
 *   }
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { type, target, metadata = {} } = await request.json();
    if (!type || !target) return error('type and target are required');

    // Idempotency: if already bookmarked, return the existing id
    const existingId = await isBookmarked({ userId: auth.user.sid, type, target });
    if (existingId) return success({ bookmarkId: existingId, alreadyExists: true });

    const res = await createBookmark({
      userId: auth.user.sid, type, target, metadata,
    });
    if (!res.ok) return error(res.reason || 'create_failed');

    return success({ bookmarkId: res.bookmarkId, createdAt: res.createdAt });
  } catch (e) {
    logger.error('doubt-solver bookmark create error', { error: e.message });
    return error('Internal server error', 500);
  }
}

export async function DELETE(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const body = await request.json().catch(() => ({}));
    const { bookmarkId = null, type = null, target = null } = body;

    const res = await deleteBookmark({
      userId: auth.user.sid, bookmarkId, type, target,
    });
    if (!res.ok) return error(res.reason || 'delete_failed', 404);

    return success({ ok: true });
  } catch (e) {
    logger.error('doubt-solver bookmark delete error', { error: e.message });
    return error('Internal server error', 500);
  }
}

export async function GET(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const url = new URL(request.url);
    const type = url.searchParams.get('type');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);

    const res = await listBookmarks({
      userId: auth.user.sid,
      type: type || null,
      limit,
    });

    return success({
      bookmarks: res.items.map(b => ({
        id: b.bookmarkId,
        type: b.type,
        target: b.target,
        metadata: b.metadata,
        createdAt: b.createdAt,
      })),
      nextCursor: res.cursor ? encodeURIComponent(JSON.stringify(res.cursor)) : null,
    });
  } catch (e) {
    logger.error('doubt-solver bookmark list error', { error: e.message });
    return error('Internal server error', 500);
  }
}
