# Doubt Solver — Full API Design

## 1. Authentication

Mobile app already has JWE token-based auth (same as other routes).

**Every doubt-solver API call must:**
- Include `X-Poripurok-Client-Key` header
- Include `Authorization: Bearer {accessToken}` header
- `accessToken` decrypts to `{ sid, phone, exp }` — `sid` is the user ID used everywhere

Covered by the existing `authenticateRequest()` middleware.

## 2. DynamoDB Schema (single table: `poripurok`)

All items use `PK`/`SK` composite keys. Access patterns listed next to each.

### 2.1 Users & preferences (already exists)
```
PK: USER#{sid}, SK: PROFILE
PK: USER#{sid}, SK: PREF#{key}
PK: USER#{sid}, SK: SESSION#{refreshToken}   (auth)
```

### 2.2 Package subscriptions
```
PK: USER#{sid}, SK: PKG_SUBSCRIPTION#active
  { packageId, packageName, quotaTotal, quotaRemaining, validityStart, validityEnd, lastUpdated }

PK: USER#{sid}, SK: PKG_ORDER#{yyyyMMddHHmmss}#{orderId}
  { packageId, packageName, price, purchasedAt, paymentRef, status }
```

### 2.3 Conversations
```
PK: USER#{sid}, SK: CONV_META#{ulid}
  { convId, title, firstMessagePreview, lastMessagePreview,
    messageCount, createdAt, updatedAt, preferredApiKeyIndex }

PK: CONV#{convId}, SK: MSG#{ulid}
  { msgId, role: 'user'|'assistant', content, imageUrls,
    activeVersionId, ts, ... }

PK: CONV#{convId}, SK: MSG_VER#{msgId}#{ulid}  (versions of assistant messages)
  { versionId, content, reference_sets, iterations, toolCalls,
    tokensInput, tokensOutput, tokensCached, costUsd, latencyMs, modelUsed,
    apiKeyIndex, createdAt, isActive }

PK: CONV#{convId}, SK: REFSET#{n}           (ref sets — already built)
PK: CONV#{convId}, SK: REFSET_COUNTER        (already built)
PK: CONV#{convId}, SK: LOCAL_ID_MAP          (already built)
```

ULID = time-sorted UUID (so SK is naturally sorted). Use `ulid` npm pkg or roll our own.

### 2.4 Reactions & feedback
```
PK: CONV#{convId}, SK: REACT#{msgId}
  { emoji, createdAt, updatedAt }       (one per message, overwrites)

PK: CONV#{convId}, SK: FEEDBACK#{msgId}#{ulid}
  { feedbackId, tags, text, voiceS3Key, attachmentS3Keys, createdAt }

PK: USER#{sid}, SK: BOOKMARK#{ulid}          (user-scoped for fast listing)
  { convId, msgId, createdAt, preview }
```

### 2.5 Conversation pagination (random-page support)
Adopting old system's pattern:
```
PK: PAGINATION#USER#{sid}, SK: CONV_META#PAGE#{n}
  { firstSK, lastSK, itemCount, totalPages, lastUpdated }
```
Rebuilt on every conversation create/delete/rename. Cheap because per-user count is small (<1000 for most).

**Query for page N**: first get this record, use `firstSK` as `ExclusiveStartKey` on a `USER#{sid}` query.

### 2.6 Cost tracking (per-turn, aggregated)
```
PK: USER#{sid}, SK: USAGE_DAY#{YYYY-MM-DD}
  { messagesUsed, retriesUsed, tokensInput, tokensOutput, tokensCached,
    embeddingTokens, costUsd, latencyMsSum, iterationsSum, lastUpdated }

PK: USER#{sid}, SK: USAGE_MONTH#{YYYY-MM}    (rollup)
PK: GLOBAL, SK: USAGE_DAY#{YYYY-MM-DD}        (admin aggregate)
```

Updated atomically via DynamoDB `UpdateItem` with `ADD` operations.

### 2.7 Admin observability (GSI)
We need to list all users sorted by spend for admin dashboards.
Add GSI: `AdminUsageIndex` with keys:
- GSI1PK: `USAGE_MONTH#{YYYY-MM}`
- GSI1SK: `{costUsd_padded}#{sid}`

Sparse — only `USAGE_MONTH` items populate it. Query by month, sorted by cost descending.

## 3. Agent Loop — New Behaviors

### 3.1 Credit deduction (before loop)
- Read `PKG_SUBSCRIPTION#active`. If `quotaRemaining <= 0` → return `{ error: 'quota_exhausted' }` with suggested packages
- Deduct `quotaRemaining -= 1` atomically BEFORE starting the loop (so partial failures don't double-charge)
- Retries also deduct 1

### 3.2 API key selection for cache affinity
- Conversation meta has `preferredApiKeyIndex`
- First turn: pick round-robin, save to conversation meta
- Subsequent turns: reuse same key for cache hits
- On 429/503 from preferred key: fall through to next via `api-key-rotator` retry logic, but mark that key as temporary-failed (our rotator already does this)

### 3.3 Title generation
Approach: piggyback on every agent turn.

Extend agent output schema:
```json
{
  "status": "done",
  "response": "...",
  "reference_sets": [...],
  "suggested_title": "রূপান্তর ও মেটামরফোসিস"  // optional
}
```

System instruction tells Gemini:
- On first turn, set `suggested_title` (short, 3-6 words, matching chat topic)
- On later turns, ONLY set `suggested_title` if the topic has shifted meaningfully
- If omitted, keep existing title

Saves a separate Gemini call.

### 3.4 Retry (regenerate)
- Separate endpoint: `POST /api/doubt-solver/retry`
- Input: `{ conversationId, messageId }` — the assistant message to regenerate
- Logic:
  - Mark current MSG_VER#{msgId} record as `isActive: false`
  - Load conversation history UP TO (and excluding) the assistant message being retried
  - Include the user's original message that preceded it
  - Run agent loop
  - Save new MSG_VER record with `isActive: true`
  - Update MSG's `activeVersionId` to new version
- Deducts 1 credit
- UI only shows the active version for now (the spec is already in place for showing version history later)

### 3.5 Cost calculation per turn
Track from every `generateText` call:
- `usage.promptTokenCount` (input)
- `usage.candidatesTokenCount` (output)
- `usage.cachedContentTokenCount` (cached input — 90% off)
- From `batchEmbedTexts`: character count → token estimate (or use the response's tokenUsage if Gemini returns it)

Gemini 2.5 Flash-Lite pricing (adjust per model env):
- Input: $0.10 / 1M tokens
- Cached input: $0.01 / 1M (90% discount)
- Output: $0.40 / 1M
- Embedding: $0.20 / 1M input

Computed per turn, persisted with the MSG_VER record, aggregated into USAGE_DAY/MONTH.

### 3.6 Feedback & reaction tagging into agent context
When the context loader runs, it also checks the **last assistant message** for any reaction/feedback and injects it into the current user turn as:
```
[Previous message reaction: 👎, feedback: "too short"]
তোমার মূল প্রশ্ন...
```
(Already designed in system instruction — now we wire the data path.)

## 4. API Surface

### 4.1 `POST /api/doubt-solver/chat`  (already scaffolded)
```json
Request: { message?, imageUrls?, conversationId? }
Response: { conversationId, messageId, response, reference_sets, iterations, latencyMs, newQuota }
```

### 4.2 `POST /api/doubt-solver/retry`
```json
Request: { conversationId, messageId }
Response: { messageId, response, reference_sets, newQuota }
```

### 4.3 `POST /api/doubt-solver/react`
```json
Request: { conversationId, messageId, emoji: 'like'|'love'|'haha'|'wow'|'sad'|'dislike'|null }
Response: { ok: true }
```
`null` removes reaction.

### 4.4 `POST /api/doubt-solver/feedback`
```json
Request: {
  conversationId, messageId,
  tags: ['wrong','incomplete','unclear','other'],
  text?,
  voiceS3Key?,          // from presigned upload
  attachmentS3Keys?: [] // images/PDFs
}
Response: { feedbackId }
```

### 4.5 `POST /api/doubt-solver/bookmark`
```json
Request: { conversationId, messageId, bookmark: true|false }
Response: { ok: true }
```

### 4.6 `GET /api/doubt-solver/conversations?page=1&limit=20`
Uses pagination pointer table.
```json
Response: {
  conversations: [{ id, title, lastPreview, updatedAt, messageCount }],
  page, totalPages, totalCount
}
```

### 4.7 `GET /api/doubt-solver/conversations/{id}`
Full conversation with active message versions.

### 4.8 `DELETE /api/doubt-solver/conversations/{id}`
Soft delete (sets `deletedAt`). Rebuild pagination.

### 4.9 `POST /api/doubt-solver/upload-url`
Issue presigned S3 URL for feedback/user-uploaded content.
```json
Request: { contentType: 'image/png'|'audio/m4a'|'application/pdf', purpose: 'feedback'|'doubt_image' }
Response: { uploadUrl, fileUrl, expiresIn, s3Key }
```
Already exists at `/api/upload/presign` — we'll extend it with the `purpose` field or create a specialized one.

### 4.10 `GET /api/doubt-solver/usage` (student-side)
```json
Response: {
  package: { name, quotaRemaining, quotaTotal, validityDaysLeft },
  stats: { totalConversations, totalMessages, thisWeekMessages, thisMonthMessages }
}
```

### 4.11 `GET /api/doubt-solver/admin/usage` (admin only)
Query by month, sorted by cost descending. Requires admin role check.

## 5. Frontend Image Upload Flow

1. User picks image/records voice in mobile app
2. App calls `POST /api/doubt-solver/upload-url` with contentType
3. Gets back `{ uploadUrl, fileUrl, s3Key }`
4. App PUTs the binary directly to `uploadUrl` (S3)
5. App calls `POST /api/doubt-solver/chat` with `imageUrls: [fileUrl]`

S3 path: `s3://poripurok-static-assets/user-uploads/{userId}/{yyyy-mm}/{ulid}.{ext}`

CDN-accessible so Gemini can fetch via `fileData.fileUri`.

## 6. Caching Strategy

Gemini offers implicit caching (first 1k+ tokens of prompt become cacheable across calls within 5 min). Max wins:
- Keep system instruction + preloaded context stable (same order, same wording) across turns
- Route same conversation to same API key — our `preferredApiKeyIndex` stored on conversation meta
- Don't insert non-deterministic strings at the top of the prompt

## 7. Public Conversation Sharing (future)
Don't build yet but leave the door open:
- Add `shareToken` field to `CONV_META` (nullable). When set, anyone with the link can read.
- Add `sharedAt`, `shareVisibility: 'public'|'unlisted'`
- GSI on `shareToken` for O(1) lookup from shared URL

## 8. Phased Implementation Plan

**Phase A — Core chat persistence (make the existing agent loop production-ready)**
1. Add ULIDs for messages and conversation IDs (via `ulid` npm pkg)
2. Refactor `appendMessage` to also create a MSG_VER record (with tokens, cost, latency)
3. Add `PKG_SUBSCRIPTION#active` loader + quota deduction before agent loop
4. Add cost calculator + USAGE_DAY/MONTH updater after every turn
5. Wire `preferredApiKeyIndex` into the agent loop

**Phase B — Chat API wire-up**
6. Finish `POST /chat` with quota check + error codes
7. Build `POST /upload-url` (or extend existing `/api/upload/presign`)
8. Mobile-app: update `ChatScreen` to use new endpoints + S3 upload flow

**Phase C — Conversation history**
9. Build pagination pointer writer (triggered on create/delete/rename)
10. `GET /conversations` with random-page
11. `GET /conversations/{id}` with active versions only

**Phase D — Reactions, feedback, bookmarks**
12. `POST /react`, `POST /feedback`, `POST /bookmark`
13. Wire reactions/feedback into context loader (so AI sees them next turn)

**Phase E — Retry**
14. `POST /retry` endpoint
15. MSG_VER versioning logic

**Phase F — Admin**
16. `GET /admin/usage` with GSI
17. Per-user drilldown endpoint

**Phase G — Title auto-update**
18. Add `suggested_title` to agent output schema
19. Update system instruction with title guidance
20. Update conversation meta on each turn if suggested

**Phase H — Share links (later)**

## 9. Profile UI Update (mobile app)
Remove `favorite_subject` from doubt stats card. Keep:
- মোট ডাউট (totalMessages)
- এই সপ্তাহে (thisWeekMessages)
- এই মাসে (thisMonthMessages)
- ক্রেডিট বাকি (from package card)

(Fourth stat slot needs replacement — could be "দ্রুততম উত্তর" / "গড় রেসপন্স সময়" / "মোট সংরক্ষণ" — we'll decide when we get to Phase B.)

## 10. Resolved Decisions

- **Admin**: `isAdmin: boolean` on `USER#{sid}/PROFILE`. Admin-only endpoints check this flag after auth.
- **Free tier**: 10 one-time credits on signup. On registration, create `PKG_SUBSCRIPTION#active` with `{ packageName: 'ফ্রি ট্রায়াল', quotaTotal: 10, quotaRemaining: 10, validityEnd: null }`. No reset, no renewal — user must buy a package to get more.
- **Deletion**: **Soft delete everywhere.** `deletedAt` timestamp on conversation meta + MSG/MSG_VER rows. Student's list hides deleted items. Admin can see them. Retention: indefinite for now (data is small + useful for analytics). Optional 90-day purge cron later.
- **User message editing**: supported. Flow:
  1. Edit overwrites `MSG#{msgId}.content` (original content snapshot saved in a `contentHistory` field for audit)
  2. Mark the assistant reply below it as `isActive: false` on its MSG_VER row
  3. Re-run the agent loop from that user message onwards
  4. Credit is deducted like any other message
- **4th profile stat**: **Streak** — consecutive days with at least 1 message. Computed from `USAGE_DAY` records.

## 11. Bookmark Schema (extended for multi-type support)

Future-proof for bookmarking messages, questions, exams, etc.

```
PK: USER#{sid}, SK: BOOKMARK#{ulid}
  bookmarkId, type, target, metadata, createdAt, updatedAt

types:
  "doubt_message"   — target: { convId, msgId }
  "question"        — target: { questionId, projectId }
  "exam"            — target: { examId }
  "study_book"      — target: { bookId, pageId? }

metadata (common, all optional unless noted):
  title          (required) — for list display
  preview        — short text snippet
  subject        — biology, chemistry, etc.
  thumbnailUrl   — for UI
  sourceLabel    — 'AI Doubt Solver', 'Question Bank', 'Exam'
  extra          — free-form JSON for type-specific fields
```

GSI: `UserBookmarkTypeIndex`
- GSI2PK: `USER#{sid}#TYPE#{type}`
- GSI2SK: `{createdAt}` (reverse-sorted)

Lets us answer both "list all bookmarks for user" (main PK query) and "list only doubt bookmarks" (GSI query) without scans.

**Redirect routing**: each bookmark type maps to a deep-link route in the mobile app:
- `doubt_message` → `/chat/{convId}?focus={msgId}`
- `question` → `/question-bank/projects/{projectId}/questions/{questionId}`
- `exam` → `/exam/{examId}`
- `study_book` → `/study-book/{bookId}?page={pageId}`

## 12. Next Step

Starting Phase A: ULIDs, MSG_VER versioning, quota deduction, cost tracking, cache-affinity keys. Will produce a working chat that persists properly and deducts credits. Then Phase B wires it into the mobile app with presigned uploads.
