import { createFeedback, listFeedback, FEEDBACK_TAGS, isPositiveTag } from '../lib/doubt-solver/feedback-store.js';

console.log('Valid tags:', FEEDBACK_TAGS);
console.log('helpful positive?', isPositiveTag('helpful'));
console.log('wrong positive?', isPositiveTag('wrong'));

const convId = 'test-conv-positive';
const msgId = 'test-msg-positive';

const fb1 = await createFeedback({
  conversationId: convId, messageId: msgId,
  tags: ['helpful', 'well_explained'],
  text: 'দারুণ ব্যাখ্যা, এত সহজে বুঝিয়ে দিলে!',
});
console.log('Positive feedback saved:', fb1.feedbackId);

const fb2 = await createFeedback({
  conversationId: convId, messageId: msgId,
  tags: ['incomplete', 'unclear'],
  text: 'আরও ডিটেইল চাই',
});
console.log('Negative feedback saved:', fb2.feedbackId);

// Invalid tag filter test
const fb3 = await createFeedback({
  conversationId: convId, messageId: msgId,
  tags: ['helpful', 'not_a_real_tag', 'accurate'],
  text: 'mixed tags',
});
const items = await listFeedback({ conversationId: convId, messageId: msgId });
console.log(`Total feedback rows: ${items.length}`);
for (const it of items) {
  console.log(`  ${it.feedbackId} tags=[${it.tags.join(',')}] text="${it.text.slice(0, 30)}..."`);
}
