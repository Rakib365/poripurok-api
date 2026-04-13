import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { listPackages } from '@/lib/doubt-solver/package-catalog';

/**
 * GET /api/doubt-solver/packages
 * Public — lists all active packages for the upgrade UI.
 */
export async function GET() {
  try {
    const packages = await listPackages();
    return success({ packages });
  } catch (e) {
    logger.error('list packages failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
