import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { executeBkashPayment, queryBkashPayment } from '@/lib/payments/bkash';
import {
  getTransaction, markTransactionSuccessful, markTransactionFailed,
} from '@/lib/payments/transaction-store';
import { getPackage } from '@/lib/doubt-solver/package-catalog';
import { purchasePackage } from '@/lib/doubt-solver/package-store';
import { sendPurchaseSms } from '@/lib/notifications/sms';

/**
 * POST /api/payments/bkash/execute
 * Body: { paymentID, merInvoiceNumber }
 *
 * Called by the mobile app after bKash redirects back. We:
 *  1. Query bKash for current status
 *  2. If Completed (or we need to execute): capture via /execute
 *  3. Mark TXN successful (idempotent) and call purchasePackage()
 *  4. Send SMS receipt
 */
export async function POST(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);

    const { paymentID, merInvoiceNumber } = await request.json();
    if (!paymentID || !merInvoiceNumber) {
      return error('paymentID and merInvoiceNumber required');
    }

    const txn = await getTransaction(merInvoiceNumber);
    if (!txn) return error('transaction_not_found', 404);
    if (txn.userId !== auth.user.sid) return error('forbidden', 403);
    if (txn.status === 'successful') {
      return success({ alreadyProcessed: true, txn });
    }

    // Query bKash; only execute if not already captured.
    const status = await queryBkashPayment(paymentID);
    let finalResult = status;
    if (status?.transactionStatus !== 'Completed') {
      finalResult = await executeBkashPayment(paymentID);
    }

    const ok = finalResult?.statusCode === '0000' &&
               finalResult?.transactionStatus === 'Completed';

    if (!ok) {
      await markTransactionFailed({
        merInvoiceNumber,
        reason: finalResult?.statusMessage || 'bkash_execute_failed',
      });
      logger.warn('bkash execute failed', {
        merInvoiceNumber, paymentID, result: finalResult,
      });
      return error('payment_failed', 402);
    }

    // Mark TXN successful (atomic / idempotent).
    const marked = await markTransactionSuccessful({
      merInvoiceNumber,
      trxID: finalResult.trxID,
      executedAmount: Number(finalResult.amount || txn.amount),
    });

    if (marked.alreadyProcessed) {
      return success({ alreadyProcessed: true, txn: marked.txn });
    }

    // Fulfill: stack credits + extend validity.
    const pkg = await getPackage(txn.packageId);
    if (!pkg) {
      logger.error('bkash: package vanished after payment', { packageId: txn.packageId });
      return error('package_not_found_post_payment', 500);
    }

    const purchase = await purchasePackage({
      userId: auth.user.sid,
      pkg: {
        packageId: pkg.packageId,
        name: pkg.name,
        credits: Number(pkg.credits || 0),
        durationDays: Number(pkg.durationDays || 0),
        price: Number(pkg.price || 0),
      },
      paidAmount: Number(finalResult.amount || txn.amount),
    });

    // SMS — fire and forget, don't block the response.
    sendPurchaseSms({
      userId: auth.user.sid,
      packageName: pkg.name,
      amount: finalResult.amount || txn.amount,
      trxID: finalResult.trxID,
      validityEnd: purchase.subscription?.validityEnd,
    }).catch(e => logger.warn('sms send failed', { error: e.message }));

    return success({
      txn: marked.txn,
      purchase: purchase.subscription,
      trxID: finalResult.trxID,
    });
  } catch (e) {
    logger.error('bkash execute error', { error: e.message, stack: e.stack });
    return error('Internal server error', 500);
  }
}
