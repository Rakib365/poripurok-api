/**
 * Phase D test — reactions, feedback, bookmarks, and context injection.
 * Run: node --env-file=.env.local scripts/test-phase-d.mjs
 */

import { runAgentTurn } from '../lib/doubt-solver/agent-loop.js';
import { setReaction, getReaction } from '../lib/doubt-solver/reaction-store.js';
import { createFeedback, listFeedback } from '../lib/doubt-solver/feedback-store.js';
import {
  createBookmark, deleteBookmark, listBookmarks, isBookmarked,
} from '../lib/doubt-solver/bookmark-store.js';
import { loadSessionContext } from '../lib/doubt-solver/context-loader.js';

const USER_ID = `test-d-${Date.now()}`;

function log(t) { console.log(`\n${'═'.repeat(60)}\n ${t}\n${'═'.repeat(60)}`); }

async function main() {
  console.log(`User: ${USER_ID}`);

  // --- Setup: run one real chat turn so we have a real conv + msg ---
  log('Setup: chat turn to get a real assistant message');
  const t1 = await runAgentTurn({
    userId: USER_ID, conversationId: null,
    message: { text: 'রূপান্তর কী?' },
  });
  console.log(`  conv=${t1.conversationId} msg=${t1.message_id} quota=${t1.quotaRemaining}`);

  const convId = t1.conversationId;
  const msgId = t1.message_id;

  // --- Reactions ---
  log('Test 1 — setReaction + getReaction');
  const r1 = await setReaction({ conversationId: convId, messageId: msgId, emoji: 'love' });
  console.log('  set love →', r1);
  const r2 = await getReaction({ conversationId: convId, messageId: msgId });
  console.log('  read →', { emoji: r2?.emoji });
  await setReaction({ conversationId: convId, messageId: msgId, emoji: null });
  const r3 = await getReaction({ conversationId: convId, messageId: msgId });
  console.log('  cleared →', r3);
  await setReaction({ conversationId: convId, messageId: msgId, emoji: 'dislike' });

  // --- Feedback ---
  log('Test 2 — createFeedback (tags + text)');
  const fb = await createFeedback({
    conversationId: convId, messageId: msgId,
    tags: ['wrong', 'unclear'],
    text: 'উত্তরটা একটু বেশি সংক্ষিপ্ত হয়ে গেছে, আরও ডিটেইল চাই',
  });
  console.log('  feedbackId=', fb.feedbackId);
  const list = await listFeedback({ conversationId: convId, messageId: msgId });
  console.log('  listed count=', list.length, 'first.tags=', list[0]?.tags);

  // --- Bookmarks (doubt_message + question) ---
  log('Test 3 — bookmark doubt_message');
  const b1 = await createBookmark({
    userId: USER_ID,
    type: 'doubt_message',
    target: { convId, msgId },
    metadata: {
      title: 'রূপান্তর ও মেটামরফোসিস',
      preview: 'রূপান্তর বা মেটামরফোসিস হলো...',
      subject: 'biology',
      sourceLabel: 'AI Doubt Solver',
    },
  });
  console.log('  created →', b1);
  const isB = await isBookmarked({ userId: USER_ID, type: 'doubt_message', target: { convId, msgId } });
  console.log('  isBookmarked →', isB);

  log('Test 4 — bookmark a question (future type)');
  await createBookmark({
    userId: USER_ID,
    type: 'question',
    target: { questionId: 'q-abc-123', projectId: 'proj-xyz' },
    metadata: {
      title: 'রক্তের উপাদান সংক্রান্ত MCQ',
      subject: 'biology',
      sourceLabel: 'Question Bank',
    },
  });
  const all = await listBookmarks({ userId: USER_ID, limit: 10 });
  console.log('  total bookmarks:', all.items.length);
  for (const b of all.items) {
    console.log(`    ${b.bookmarkId} type=${b.type} title=${b.metadata?.title}`);
  }

  log('Test 5 — deleteBookmark by type+target (idempotent toggle)');
  const del = await deleteBookmark({
    userId: USER_ID, type: 'doubt_message', target: { convId, msgId },
  });
  console.log('  delete →', del);
  const isB2 = await isBookmarked({ userId: USER_ID, type: 'doubt_message', target: { convId, msgId } });
  console.log('  isBookmarked after delete →', isB2);

  // --- Context injection ---
  log('Test 6 — context loader picks up reaction/feedback on previous message');
  const ctx = await loadSessionContext({ userId: USER_ID, conversationId: convId });
  const hasFeedbackBlock = /latest_message_feedback/.test(ctx.xml);
  console.log('  <latest_message_feedback> injected:', hasFeedbackBlock);
  if (hasFeedbackBlock) {
    const block = ctx.xml.match(/<latest_message_feedback>[\s\S]*?<\/latest_message_feedback>/);
    console.log('  block:\n' + block[0].split('\n').map(l => '    ' + l).join('\n'));
  }

  // --- Agent reacts to feedback in next turn ---
  log('Test 7 — next turn: AI should adjust based on the feedback');
  const t2 = await runAgentTurn({
    userId: USER_ID, conversationId: convId,
    message: { text: 'আরও একবার বুঝিয়ে দাও।' },
  });
  console.log(`  response (first 150): ${t2.response?.slice(0, 150)}...`);
  console.log(`  latency=${t2.latencyMs}ms iterations=${t2.iterations}`);

  log('All Phase D tests complete');
}

main().catch(err => { console.error('Failure:', err); process.exit(1); });
