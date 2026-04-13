import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { getPackage } from '@/lib/doubt-solver/package-catalog';
import { purchasePackage } from '@/lib/doubt-solver/package-store';

/**
 * POST /api/doubt-solver/purchase
 * Body: { packageId }
 *
 * Simulates a successful purchase — adds credits + extends validity using
 * telecom-style stacking (Option A):
 *   quotaRemaining += package.credits
 *   validityEnd     = max(current, now + package.durationDays)
 *
 * Payment integration is separate — once a payment provider is wired, the
 * success callback should call into this same endpoint (or the underlying
 * purchasePackage() function directly) with the verified packageId.
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { packageId } = await request.json();
    if (!packageId) return error('packageId required');

    const pkgRow = await getPackage(packageId);
    if (!pkgRow || pkgRow.active === false) {
      return error('package_not_found', 404);
    }

    if (!pkgRow.price || Number(pkgRow.price) <= 0) {
      return error('cannot purchase free tier', 400);
    }

    const result = await purchasePackage({
      userId: auth.user.sid,
      pkg: {
        packageId: pkgRow.packageId,
        name: pkgRow.name,
        credits: Number(pkgRow.credits || 0),
        durationDays: Number(pkgRow.durationDays || 0),
        price: Number(pkgRow.price || 0),
      },
    });

    logger.info('Package purchased', {
      userId: auth.user.sid,
      packageId,
      orderId: result.orderId,
    });

    const sub = result.subscription || {};
    return success({
      orderId: result.orderId,
      package: {
        id: sub.packageId,
        name: sub.packageName,
        quotaRemaining: sub.quotaRemaining ?? 0,
        quotaTotal: sub.quotaTotal ?? 0,
        validityEnd: sub.validityEnd,
      },
    });
  } catch (e) {
    logger.error('purchase failed', { error: e.message, stack: e.stack });
    return error('Internal server error', 500);
  }
}
