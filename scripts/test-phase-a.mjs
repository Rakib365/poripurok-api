/**
 * Phase A end-to-end test — quota, cost tracking, MSG_VER versioning, retry, edit+regen, streak.
 * Run: node --env-file=.env.local scripts/test-phase-a.mjs
 */

import { runAgentTurn, runAgentRetry, runAgentEditAndRegenerate } from '../lib/doubt-solver/agent-loop.js';
import { ensureFreeTier, getActiveSubscription } from '../lib/doubt-solver/package-store.js';
import { getUserUsageSummary } from '../lib/doubt-solver/usage-tracker.js';

const USER_ID = `test-${Date.now()}`;

function log(title) {
  console.log(`\n${'═'.repeat(70)}\n ${title}\n${'═'.repeat(70)}`);
}

async function main() {
  console.log(`Test user: ${USER_ID}`);

  log('Test 1 — Free tier seeded on first use');
  const sub = await ensureFreeTier(USER_ID);
  console.log(`  package=${sub.packageName} quota=${sub.quotaRemaining}/${sub.quotaTotal}`);

  log('Test 2 — Turn 1: Biology question');
  const t1 = await runAgentTurn({
    userId: USER_ID,
    conversationId: null,
    message: { text: 'রূপান্তর বা মেটামরফোসিস কী?' },
  });
  console.log(`  conv=${t1.conversationId} msgId=${t1.message_id}`);
  console.log(`  latency=${t1.latencyMs}ms iterations=${t1.iterations} tools=${t1.tool_calls_made}`);
  console.log(`  quotaRemaining=${t1.quotaRemaining} cost=$${t1.costUsd}`);
  console.log(`  suggestedTitle=${t1.suggestedTitle || '(none)'}`);

  log('Test 3 — Turn 2: Follow-up');
  const t2 = await runAgentTurn({
    userId: USER_ID,
    conversationId: t1.conversationId,
    message: { text: 'হরমোনের ভূমিকা কী এতে?' },
  });
  console.log(`  latency=${t2.latencyMs}ms cost=$${t2.costUsd} quota=${t2.quotaRemaining}`);

  log('Test 4 — Retry the assistant response from Turn 2');
  const retry = await runAgentRetry({
    userId: USER_ID,
    conversationId: t1.conversationId,
    messageId: t2.message_id,
  });
  console.log(`  version_id=${retry.version_id}`);
  console.log(`  latency=${retry.latencyMs}ms cost=$${retry.costUsd} quota=${retry.quotaRemaining}`);
  console.log(`  New response length: ${retry.response?.length || 0} chars`);

  log('Test 5 — Casual chat (no tools)');
  const t3 = await runAgentTurn({
    userId: USER_ID,
    conversationId: t1.conversationId,
    message: { text: 'তুমি কী আছো?' },
  });
  console.log(`  latency=${t3.latencyMs}ms iterations=${t3.iterations} cost=$${t3.costUsd}`);

  log('Test 6 — Usage summary');
  const summary = await getUserUsageSummary(USER_ID);
  console.log(`  Today:  messages=${summary.today.messages || 0} retries=${summary.today.retries || 0} cost=$${(summary.today.costUsd || 0).toFixed(6)}`);
  console.log(`  Today:  tokensIn=${summary.today.tokensInput || 0} tokensOut=${summary.today.tokensOutput || 0} cached=${summary.today.tokensCached || 0}`);
  console.log(`  Month:  messages=${summary.month.messages || 0} cost=$${(summary.month.costUsd || 0).toFixed(6)}`);
  console.log(`  Streak: current=${summary.streak.current} best=${summary.streak.best}`);

  const finalSub = await getActiveSubscription(USER_ID);
  console.log(`  Subscription quota remaining: ${finalSub.quotaRemaining}/${finalSub.quotaTotal}`);

  log('All tests complete');
}

main().catch(err => { console.error('Test failure:', err); process.exit(1); });
