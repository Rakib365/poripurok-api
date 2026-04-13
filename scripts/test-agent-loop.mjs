/**
 * End-to-end test of the Doubt Solver agent loop.
 * Run: node --env-file=.env.local scripts/test-agent-loop.mjs
 */

import { runAgentTurn } from '../lib/doubt-solver/agent-loop.js';

const USER_ID = `test-user-${Date.now()}`;

function log(title) {
  console.log(`\n${'═'.repeat(70)}\n ${title}\n${'═'.repeat(70)}`);
}

async function runTurn(label, input) {
  log(label);
  const start = Date.now();
  const result = await runAgentTurn(input);
  const elapsed = Date.now() - start;

  console.log(`\n⏱  ${elapsed}ms | iterations=${result.iterations} | tools=${result.tool_calls_made} | new_conv=${result.isNewConversation}`);
  if (result.error) {
    console.log(`❌ ERROR: ${result.error}`);
    return result;
  }
  console.log(`💬 conv=${result.conversationId} msg=${result.message_id}`);
  console.log(`\n--- Response ---\n${result.response}`);

  if (result.reference_sets?.length > 0) {
    console.log(`\n--- Reference Sets ---`);
    for (const rs of result.reference_sets) {
      console.log(`  ${rs.ref_set_id}: "${rs.summary}" imgs=[${rs.image_ids.join(', ')}] reused=${rs.reused}`);
    }
  }
  return result;
}

async function main() {
  console.log(`User: ${USER_ID}`);

  // Turn 1: New conversation, Biology question
  const t1 = await runTurn('Turn 1: Biology question (new conversation)', {
    userId: USER_ID,
    conversationId: null,
    message: { text: 'রূপান্তর বা মেটামরফোসিস কী? সম্পূর্ণ আর অসম্পূর্ণ রূপান্তরের পার্থক্য বুঝিয়ে দাও।' },
  });

  const convId = t1.conversationId;

  // Turn 2: Follow-up on same topic — should reuse ref sets
  await runTurn('Turn 2: Follow-up (should use prior ref sets)', {
    userId: USER_ID,
    conversationId: convId,
    message: { text: 'আচ্ছা, ঘাসফড়িংয়ে কোন হরমোনগুলো এই প্রক্রিয়া নিয়ন্ত্রণ করে?' },
  });

  // Turn 3: Casual non-KB question
  await runTurn('Turn 3: Casual greeting (no KB needed)', {
    userId: USER_ID,
    conversationId: convId,
    message: { text: 'Thanks! একটু break নিই।' },
  });

  // Turn 4: Preference change
  await runTurn('Turn 4: Set preference (manage_preferences)', {
    userId: USER_ID,
    conversationId: convId,
    message: { text: 'আমাকে Rakib বলে ডাকো। আর ইমোজি একটু কম use করবে।' },
  });

  log('All turns complete');
}

main().catch(err => {
  console.error('\n💥 Test failure:', err);
  process.exit(1);
});
