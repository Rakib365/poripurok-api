import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { getActiveSubscription, ensureFreeTier } from '@/lib/doubt-solver/package-store';
import { getUserUsageSummary } from '@/lib/doubt-solver/usage-tracker';

/**
 * GET /api/doubt-solver/usage
 *
 * Student-facing summary for Profile page:
 *   { package, stats: { today, month, streak } }
 */
export async function GET(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const userId = auth.user.sid;

    await ensureFreeTier(userId);
    const [sub, summary] = await Promise.all([
      getActiveSubscription(userId),
      getUserUsageSummary(userId),
    ]);

    const validityDaysLeft = sub?.validityEnd
      ? Math.max(0, Math.ceil((new Date(sub.validityEnd) - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

    return success({
      package: {
        id: sub?.packageId,
        name: sub?.packageName,
        quotaRemaining: sub?.quotaRemaining ?? 0,
        quotaTotal: sub?.quotaTotal ?? 0,
        validityDaysLeft,
        isFree: !!sub?.isFree,
      },
      stats: {
        today: {
          messages: summary.today.messages || 0,
          retries: summary.today.retries || 0,
        },
        month: {
          messages: summary.month.messages || 0,
          retries: summary.month.retries || 0,
        },
        streak: {
          current: summary.streak.current || 0,
          best: summary.streak.best || 0,
        },
      },
    });
  } catch (e) {
    logger.error('doubt-solver usage error', { error: e.message });
    return error('Internal server error', 500);
  }
}
