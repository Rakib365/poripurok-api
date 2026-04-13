/**
 * End-to-end test for all Doubt Solver tools + context loader.
 * Run: node --env-file=.env.local scripts/test-doubt-solver.mjs
 */

import { executeTool, listTools } from '../lib/doubt-solver/tools/tool-registry.js';
import { matchAndStoreRefSets, fetchRefSets, listRefSets } from '../lib/doubt-solver/reference-matcher.js';
import { loadSessionContext } from '../lib/doubt-solver/context-loader.js';
import { getRegistry } from '../lib/doubt-solver/local-id-registry.js';

const TEST_USER_ID = `test-user-${Date.now()}`;
const TEST_CONV_ID = `test-conv-${Date.now()}`;
const CTX = { userId: TEST_USER_ID, conversationId: TEST_CONV_ID };

function log(title) {
  console.log(`\n${'═'.repeat(70)}\n ${title}\n${'═'.repeat(70)}`);
}

async function runTest(label, fn) {
  console.log(`\n--- ${label} ---`);
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`(${Date.now() - start}ms)`);
    return result;
  } catch (err) {
    console.error(`FAILED (${Date.now() - start}ms):`, err.message);
    throw err;
  }
}

// ================= Tests =================

async function testToolRegistry() {
  log('Test: Tool Registry');
  const tools = listTools();
  console.log('Registered tools:', tools);
}

async function testPreferences() {
  log('Test: manage_preferences (CRUD)');

  await runTest('add preferred_name', async () => {
    const r = await executeTool('manage_preferences', { action: 'add', key: 'preferred_name', value: 'Rakib' }, CTX);
    console.log(r);
    return r;
  });

  await runTest('add emoji_usage', async () => {
    const r = await executeTool('manage_preferences', { action: 'add', key: 'emoji_usage', value: 'minimal' }, CTX);
    console.log(r);
    return r;
  });

  await runTest('update preferred_name', async () => {
    const r = await executeTool('manage_preferences', { action: 'update', key: 'preferred_name', value: 'Rakib Vai' }, CTX);
    console.log(r);
    return r;
  });

  await runTest('delete emoji_usage', async () => {
    const r = await executeTool('manage_preferences', { action: 'delete', key: 'emoji_usage' }, CTX);
    console.log(r);
    return r;
  });
}

async function testSearchKb() {
  log('Test: search_kb');

  const r = await runTest('single-query search', async () => {
    const r = await executeTool('search_kb', {
      queries: ['রূপান্তর প্রক্রিয়া ও হরমোনের ভূমিকা'],
    }, CTX);
    console.log(`  unique images: ${r.total_unique_images}`);
    console.log(`  local IDs: ${r.images.map(i => i.local_id).join(', ')}`);
    return r;
  });

  return r;
}

async function testReferenceMatcher(searchResult) {
  log('Test: matchAndStoreRefSets (programmatic ref_set IDs)');

  const imgIds1 = searchResult.images.slice(0, 2).map(i => i.local_id);
  const imgIds2 = searchResult.images.slice(1, 3).map(i => i.local_id);

  await runTest('first turn: 2 new sets', async () => {
    const sets = await matchAndStoreRefSets(TEST_CONV_ID, [
      { summary: 'metamorphosis lifecycle stages', image_ids: imgIds1 },
      { summary: 'hormonal regulation of metamorphosis', image_ids: imgIds2 },
    ]);
    for (const s of sets) console.log(`  ${s.ref_set_id}: "${s.summary}" (reused=${s.reused})`);
    return sets;
  });

  await runTest('second turn: similar summary → should reuse', async () => {
    const sets = await matchAndStoreRefSets(TEST_CONV_ID, [
      { summary: 'metamorphosis lifecycle and stages in grasshopper', image_ids: imgIds1 },
    ]);
    for (const s of sets) console.log(`  ${s.ref_set_id}: "${s.summary}" (reused=${s.reused}, score=${s.match_score})`);
    return sets;
  });

  await runTest('third turn: totally new topic → new set', async () => {
    const sets = await matchAndStoreRefSets(TEST_CONV_ID, [
      { summary: 'AIDS and sexually transmitted diseases', image_ids: ['R99'] },
    ]);
    for (const s of sets) console.log(`  ${s.ref_set_id}: "${s.summary}" (reused=${s.reused})`);
    return sets;
  });

  await runTest('list all ref sets for this conversation', async () => {
    const sets = await listRefSets(TEST_CONV_ID);
    for (const s of sets) console.log(`  ${s.ref_set_id}: "${s.summary}" imgs=[${s.image_ids.join(',')}]`);
    return sets;
  });
}

async function testManageReferencedKb() {
  log('Test: manage_referenced_kb (refetch)');

  await runTest('fetch ref_set_1 and ref_set_3', async () => {
    const r = await executeTool('manage_referenced_kb', {
      ref_set_ids: ['ref_set_1', 'ref_set_3'],
    }, CTX);
    console.log(`  sets returned: ${r.ref_sets?.length}`);
    for (const s of r.ref_sets || []) {
      console.log(`  ${s.ref_set_id}: "${s.summary}", ${s.images.length} images`);
      for (const img of s.images.slice(0, 2)) {
        console.log(`    ${img.local_id} → ${img.url?.slice(0, 60)}...`);
      }
    }
    return r;
  });
}

async function testConversations() {
  log('Test: manage_conversations');

  await runTest('list (expects empty for new test user)', async () => {
    const r = await executeTool('manage_conversations', { action: 'list', limit: 5 }, CTX);
    console.log(`  count: ${r.count}`);
    return r;
  });
}

async function testContextLoader() {
  log('Test: Context Loader — session XML');

  await runTest('load session context', async () => {
    const result = await loadSessionContext({
      userId: TEST_USER_ID,
      conversationId: TEST_CONV_ID,
    });
    console.log('\n' + result.xml + '\n');
    return result;
  });
}

async function main() {
  console.log(`Test user: ${TEST_USER_ID}`);
  console.log(`Test conv: ${TEST_CONV_ID}`);

  await testToolRegistry();
  await testPreferences();
  const searchResult = await testSearchKb();
  await testReferenceMatcher(searchResult);
  await testManageReferencedKb();
  await testConversations();
  await testContextLoader();

  log('All tests completed');
}

main().catch(err => {
  console.error('\n💥 Test failure:', err);
  process.exit(1);
});
