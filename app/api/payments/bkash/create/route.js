import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { getPackage } from '@/lib/doubt-solver/package-catalog';
import { createBkashPayment } from '@/lib/payments/bkash';
import { recordInitiatedTransaction, buildInvoiceNumber } from '@/lib/payments/transaction-store';

/**
 * POST /api/payments/bkash/create
 * Body: { packageId }
 *
 * 1. Looks up the package and the student phone
 * 2. Asks bKash to open a checkout session
 * 3. Persists an "initiated" TXN row (for idempotency on callback)
 * 4. Returns { paymentID, bkashURL, merInvoiceNumber }
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { packageId } = await request.json();
    if (!packageId) return error('packageId required');

    const pkg = await getPackage(packageId);
    if (!pkg || pkg.active === false) return error('package_not_found', 404);
    if (!pkg.price || Number(pkg.price) <= 0) return error('cannot purchase free tier', 400);

    // Need the student phone for bKash's payerReference
    const profRes = await docClient.send(new GetCommand({
      TableName: TABLE,
      Key: { PK: `USER#${auth.user.sid}`, SK: 'PROFILE' },
      ProjectionExpression: 'phone',
    }));
    const phone = profRes.Item?.phone || '';

    const merInvoiceNumber = buildInvoiceNumber(auth.user.sid, pkg.packageId);
    // bKash only accepts callback URLs that have been whitelisted at their
    // side. The old web checkout registered https://payment.poripurok.com.
    // The mobile WebView intercepts navigation to that URL (via
    // onShouldStartLoadWithRequest) before it actually loads, so the page
    // doesn't need to serve anything useful — the domain just needs to match.
    const callbackURL = process.env.BKASH_CALLBACK_URL || 'https://payment.poripurok.com/v2/callback';

    const created = await createBkashPayment({
      amount: pkg.price,
      phone,
      merchantInvoiceNumber: merInvoiceNumber,
      callbackURL,
    });

    await recordInitiatedTransaction({
      merInvoiceNumber,
      userId: auth.user.sid,
      packageId: pkg.packageId,
      packageName: pkg.name,
      amount: pkg.price,
      paymentID: created.paymentID,
    });

    logger.info('bkash payment created', {
      userId: auth.user.sid, packageId, merInvoiceNumber, paymentID: created.paymentID,
    });

    return success({
      paymentID: created.paymentID,
      bkashURL: created.bkashURL,
      merInvoiceNumber,
      amount: pkg.price,
      packageName: pkg.name,
    });
  } catch (e) {
    logger.error('bkash create failed', { error: e.message, stack: e.stack });
    return error('Internal server error', 500);
  }
}
