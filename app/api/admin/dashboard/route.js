import { authenticateRequest } from '@/lib/auth/middleware';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isAdmin } from '@/lib/admin/auth';

/**
 * GET /api/admin/dashboard?days=7
 *
 * Aggregates pre-computed daily buckets:
 *   AGG#REVENUE / DAY#{YYYY-MM-DD}  — total, count
 *   GLOBAL      / USAGE_DAY#{date}  — messages, tokens*, costUsd, latencyMsSum
 *
 * Returns a compact summary for the admin UI.
 */

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function lastNDays(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

export async function GET(request) {
  try {
    const auth = authenticateRequest(request);
    if (!auth.authenticated) return error(auth.error, 401);
    if (!(await isAdmin(auth.user.sid))) return error('forbidden', 403);

    const url = new URL(request.url);
    const days = Math.min(parseInt(url.searchParams.get('days') || '7', 10), 90);
    const dates = lastNDays(days);

    // Batch-get revenue + usage rows for the last N days.
    const revKeys = dates.map(d => ({ PK: 'AGG#REVENUE', SK: `DAY#${d}` }));
    const useKeys = dates.map(d => ({ PK: 'GLOBAL',       SK: `USAGE_DAY#${d}` }));

    const [revRes, useRes] = await Promise.all([
      docClient.send(new BatchGetCommand({
        RequestItems: { [TABLE]: { Keys: revKeys } },
      })),
      docClient.send(new BatchGetCommand({
        RequestItems: { [TABLE]: { Keys: useKeys } },
      })),
    ]);

    const revMap = new Map();
    (revRes.Responses?.[TABLE] || []).forEach(item => {
      revMap.set(item.SK.replace('DAY#', ''), item);
    });
    const useMap = new Map();
    (useRes.Responses?.[TABLE] || []).forEach(item => {
      useMap.set(item.SK.replace('USAGE_DAY#', ''), item);
    });

    const daily = dates.map(d => {
      const rev = revMap.get(d) || {};
      const use = useMap.get(d) || {};
      const tokensTotal = (use.tokensInput || 0) + (use.tokensOutput || 0);
      const cachedTotal = use.tokensCached || 0;
      return {
        date: d,
        revenueBdt: Number(rev.total || 0),
        paidCount: Number(rev.count || 0),
        messages: Number(use.messages || 0),
        retries: Number(use.retries || 0),
        tokensInput: Number(use.tokensInput || 0),
        tokensOutput: Number(use.tokensOutput || 0),
        tokensCached: cachedTotal,
        cacheHitRate: tokensTotal > 0
          ? Number((cachedTotal / (tokensTotal + cachedTotal)).toFixed(4))
          : 0,
        avgLatencyMs: use.messages > 0
          ? Math.round((use.latencyMsSum || 0) / use.messages)
          : 0,
        costUsd: Number((use.costUsd || 0).toFixed(6)),
      };
    });

    const totals = daily.reduce((acc, d) => ({
      revenueBdt: acc.revenueBdt + d.revenueBdt,
      paidCount: acc.paidCount + d.paidCount,
      messages: acc.messages + d.messages,
      retries: acc.retries + d.retries,
      tokensInput: acc.tokensInput + d.tokensInput,
      tokensOutput: acc.tokensOutput + d.tokensOutput,
      tokensCached: acc.tokensCached + d.tokensCached,
      latencyMsSum: acc.latencyMsSum + (d.avgLatencyMs * d.messages),
      costUsd: acc.costUsd + d.costUsd,
    }), {
      revenueBdt: 0, paidCount: 0, messages: 0, retries: 0,
      tokensInput: 0, tokensOutput: 0, tokensCached: 0,
      latencyMsSum: 0, costUsd: 0,
    });

    const tokensTotalSum = totals.tokensInput + totals.tokensOutput;
    const summary = {
      revenueBdt: totals.revenueBdt,
      paidCount: totals.paidCount,
      messages: totals.messages,
      retries: totals.retries,
      avgLatencyMs: totals.messages > 0 ? Math.round(totals.latencyMsSum / totals.messages) : 0,
      cacheHitRate: tokensTotalSum > 0
        ? Number((totals.tokensCached / (tokensTotalSum + totals.tokensCached)).toFixed(4))
        : 0,
      costUsd: Number(totals.costUsd.toFixed(4)),
    };

    return success({ days, summary, daily });
  } catch (e) {
    logger.error('admin dashboard error', { error: e.message, stack: e.stack });
    return error('Internal server error', 500);
  }
}
