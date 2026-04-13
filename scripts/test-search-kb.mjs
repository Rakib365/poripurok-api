/**
 * Manual test for the search_kb tool.
 * Run: node --env-file=.env.local scripts/test-search-kb.mjs
 */

import { searchKb } from '../lib/doubt-solver/tools/search-kb.js';
import { getRegistry } from '../lib/doubt-solver/local-id-registry.js';

const TEST_CONVERSATION_ID = `test-conv-${Date.now()}`;

const tests = [
  {
    name: 'Single query — metamorphosis',
    queries: ['রূপান্তর প্রক্রিয়া ও হরমোনের ভূমিকা'],
  },
  {
    name: 'Multiple queries — 3 topics',
    queries: [
      'মানুষের শুক্রাণুর গঠন ও দৈর্ঘ্য',
      'নিউরনের প্রকারভেদ',
      'AIDS ও গনোরিয়া রোগ',
    ],
  },
  {
    name: 'Same queries again (local ID reuse check)',
    queries: ['রূপান্তর প্রক্রিয়া ও হরমোনের ভূমিকা'],
  },
];

async function main() {
  console.log(`Conversation ID: ${TEST_CONVERSATION_ID}\n`);

  for (const test of tests) {
    console.log(`=== ${test.name} ===`);
    const start = Date.now();

    const result = await searchKb.handler(
      { queries: test.queries, topK: 3 },
      { conversationId: TEST_CONVERSATION_ID },
    );

    const elapsed = Date.now() - start;
    console.log(`Time: ${elapsed}ms`);

    if (result.error) {
      console.log('ERROR:', result.error);
    } else {
      console.log(`Total unique images: ${result.total_unique_images}`);
      console.log('Images:');
      for (const img of result.images) {
        console.log(`  ${img.local_id}: subject=${img.subject}, page=${img.page}, score=${img.best_score}, matched=${img.matched_queries.length}`);
      }
      console.log('Query hits:');
      for (const [q, hits] of Object.entries(result.query_hits)) {
        const hitStr = hits.map(h => `${h.local_id}(${h.score})`).join(', ');
        console.log(`  "${q.slice(0, 40)}..." → ${hitStr}`);
      }
    }
    console.log();
  }

  // Dump registry state
  const registry = await getRegistry(TEST_CONVERSATION_ID);
  console.log(`=== Registry final state ===`);
  console.log(`Counter: ${registry.counter}`);
  console.log(`Mappings:`);
  for (const [localId, uuid] of Object.entries(registry.forward)) {
    console.log(`  ${localId} → ${uuid}`);
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
