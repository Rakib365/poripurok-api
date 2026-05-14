/**
 * Doubt Solver Agent Loop
 *
 * Production flow per user turn:
 *   1. Ensure free-tier subscription seeded (idempotent)
 *   2. Deduct 1 quota (atomic) — if 0, return quota_exhausted
 *   3. Persist the user MSG row
 *   4. Load system instruction + session context + history
 *   5. Multi-iteration loop with generateText:
 *        - status: continue → execute tools → inject results → loop
 *        - status: done → persist assistant MSG + MSG_VER, track usage, maybe update title
 *   6. On hard failure, refund the quota we deducted
 */

import { loadSystemInstruction } from './system-instruction.js';
import { loadSessionContext } from './context-loader.js';
import { generateText } from '../llm/index.js';
import { executeTool } from './tools/tool-registry.js';
import { matchAndStoreRefSets } from './reference-matcher.js';
import {
  ensureConversation, appendMessage, loadMessages,
  newConversationId, updateConversationTitle, setPreferredApiKey,
  addNewActiveVersion, deactivateActiveVersion, editMessageContent,
} from './message-store.js';
import { ensureFreeTier, deductQuota, refundQuota } from './package-store.js';
import { recordTurnUsage, updateStreak } from './usage-tracker.js';
import { calculateGenerationCost, calculateEmbeddingCost } from './pricing.js';
import { logger } from '../aws/cloudwatch.js';

const MAX_ITERATIONS = 10;
const MAX_DISCARDS = 3;
const MODEL = process.env.GEMINI_LLM_MODEL || 'gemini-3.1-flash-lite';
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2-preview';

// Schema for Gemini's structured-output mode. With this, the SDK builds the
// object natively and handles escaping (so LaTeX backslashes like \delta
// inside `response` don't break JSON.parse).
// ─── JSON parsing — raw, or unwrap ```json fence, nothing else ───────
function parseAgentJson(text) {
  if (!text) return null;
  // 1. Raw JSON
  try { return JSON.parse(text); } catch {}
  // 2. JSON wrapped in ```json ... ``` (or bare ``` ... ```)
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  return null;
}

function validateAgentOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not-object' };
  const { status } = parsed;
  if (status !== 'done' && status !== 'continue') return { ok: false, reason: `invalid status: ${status}` };
  const toolCalls = parsed.tool_calls || [];
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;
  const hasResponse = typeof parsed.response === 'string' && parsed.response.trim().length > 0;
  if (status === 'continue' && !hasTools) return { ok: false, reason: 'continue requires tool_calls' };
  if (status === 'done' && !hasResponse) return { ok: false, reason: 'done requires response' };
  return { ok: true };
}

// ─── Message construction helpers ───────────────────────────────────
function buildMessages({ systemInstruction, contextXml, history, userMessage }) {
  const messages = [
    { role: 'system', parts: [{ type: 'text', text: systemInstruction }] },
    { role: 'user',   parts: [{ type: 'text', text: contextXml }] },
    { role: 'assistant', parts: [{ type: 'text', text: JSON.stringify({ status: 'done', thinking: 'Context loaded.', response: '' }) }] },
  ];
  for (const msg of history) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const parts = [];
    const text = typeof msg.content === 'string' ? msg.content.trim() : '';
    const hasImages = Array.isArray(msg.imageUrls) && msg.imageUrls.length > 0;
    // Gemini rejects text parts with empty strings. For image-only user
    // messages we substitute a marker so the part is never empty.
    if (text) {
      parts.push({ type: 'text', text });
    } else if (hasImages) {
      parts.push({ type: 'text', text: '<user_message type="image"></user_message>' });
    } else {
      // Truly empty — skip this history entry rather than send an invalid part
      continue;
    }
    if (hasImages) {
      for (const url of msg.imageUrls) parts.push({ type: 'image', url });
    }
    messages.push({ role, parts });
  }
  const parts = [];
  if (userMessage.text) parts.push({ type: 'text', text: `<user_message>${userMessage.text}</user_message>` });
  else parts.push({ type: 'text', text: '<user_message type="image"></user_message>' });
  if (Array.isArray(userMessage.imageUrls)) {
    for (const url of userMessage.imageUrls) parts.push({ type: 'image', url });
  }
  messages.push({ role: 'user', parts });
  return messages;
}

function buildToolResultParts(results) {
  const parts = [];
  const textSections = [];
  for (const r of results) {
    let cleanResult = r.result;
    const attachedImages = [];
    if (cleanResult && typeof cleanResult === 'object' && Array.isArray(cleanResult._images)) {
      const { _images, ...rest } = cleanResult;
      cleanResult = rest;
      for (const img of _images) if (img.url) attachedImages.push(img);
    }
    const inner = typeof cleanResult === 'string' ? cleanResult : JSON.stringify(cleanResult);
    textSections.push(`<tool_result name="${r.name}">\n${inner}\n</tool_result>`);
    if (attachedImages.length > 0) {
      parts.push({ type: 'text', text: textSections.join('\n') });
      textSections.length = 0;
      for (const img of attachedImages) {
        parts.push({ type: 'image', url: img.url, mimeType: img.mimeType || 'image/png' });
      }
    }
  }
  if (textSections.length > 0) parts.push({ type: 'text', text: textSections.join('\n') });
  return parts;
}

// ─── Core loop ───────────────────────────────────────────────────────

async function runLoopCore({ userId, conversationId, messages }) {
  let iterations = 0;
  let consecutiveDiscards = 0;
  let finalParsed = null;
  let error = null;
  const toolTrace = [];

  // Aggregate usage across iterations in this turn
  const usageAcc = {
    tokensInput: 0, tokensOutput: 0, tokensCached: 0, thinkingTokens: 0,
    embeddingTokens: 0, costUsd: 0, apiKeyIndexUsed: null,
  };

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const llmResponse = await generateText({
      model: MODEL,
      messages,
      config: { temperature: 1, responseMimeType: 'application/json' },
      thinking: { enabled: false },
    });

    if (!llmResponse.success) {
      error = llmResponse.error?.message || 'LLM failure';
      break;
    }

    // Track tokens + cost
    const usage = llmResponse.metadata?.usage || {};
    const apiKeyIndex = llmResponse.metadata?.apiKeyIndex;
    if (apiKeyIndex != null) usageAcc.apiKeyIndexUsed = apiKeyIndex;

    usageAcc.tokensInput += usage.inputTokens || 0;
    usageAcc.tokensOutput += usage.outputTokens || 0;
    usageAcc.tokensCached += usage.cachedTokens || 0;
    usageAcc.thinkingTokens += usage.thinkingTokens || 0;
    usageAcc.costUsd += calculateGenerationCost({
      model: MODEL,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cachedTokens: usage.cachedTokens || 0,
      thinkingTokens: usage.thinkingTokens || 0,
    });

    const rawText = llmResponse.content || '';
    const parsed = llmResponse.object || parseAgentJson(rawText);
    const validation = parsed ? validateAgentOutput(parsed) : { ok: false, reason: 'parse-failed' };

    if (!validation.ok) {
      consecutiveDiscards++;
      // Show exactly what Gemini returned so we can debug.
      const textLen = (rawText || '').length;
      const hasObject = !!llmResponse.object;
      const snippet = (rawText || '').slice(0, 600);
      logger.warn('agent-loop parse-fail', {
        iter: iterations, reason: validation.reason,
        discard: `${consecutiveDiscards}/${MAX_DISCARDS}`,
        hasStructuredObject: hasObject, textLen,
        ...(hasObject && { structuredObject: JSON.stringify(llmResponse.object).slice(0, 600) }),
        rawTextSnippet: snippet,
      });
      if (consecutiveDiscards >= MAX_DISCARDS) { error = `invalid_output: ${validation.reason}`; break; }
      continue;
    }
    consecutiveDiscards = 0;

    const toolCalls = parsed.tool_calls || [];
    const toolNames = toolCalls.map(c => c.name).join(',') || 'none';
    logger.info('agent-loop iteration', { iter: iterations, status: parsed.status, tools: toolNames, respLen: (parsed.response || '').length });

    messages.push({ role: 'assistant', parts: [{ type: 'text', text: JSON.stringify(parsed) }] });

    if (parsed.status === 'done') { finalParsed = parsed; break; }

    // execute tools
    const results = await Promise.all(toolCalls.map(async call => {
      const result = await executeTool(call.name, call.arguments || {}, { userId, conversationId });
      toolTrace.push({ name: call.name, arguments: call.arguments });
      if (result?._embeddingTokens) usageAcc.embeddingTokens += result._embeddingTokens;
      return { name: call.name, result };
    }));

    messages.push({ role: 'user', parts: buildToolResultParts(results) });
  }

  if (iterations >= MAX_ITERATIONS && !finalParsed) {
    logger.warn('agent-loop max iterations reached', { maxIterations: MAX_ITERATIONS, toolTrace: toolTrace.slice(-10) });
  }

  // Embedding cost estimate from accumulated tokens
  if (usageAcc.embeddingTokens > 0) {
    usageAcc.costUsd += calculateEmbeddingCost({ model: EMBEDDING_MODEL, inputTokens: usageAcc.embeddingTokens });
  }

  return { finalParsed, error, iterations, usageAcc, toolTrace };
}

// ─── Public entry: new turn ─────────────────────────────────────────
export async function runAgentTurn({ userId, conversationId: inputConvId, message }) {
  if (!userId) throw new Error('userId required');
  if (!message) throw new Error('message required');

  const conversationId = inputConvId || newConversationId();
  const isNewConversation = !inputConvId;
  const turnStart = Date.now();

  // 1. Ensure free-tier subscription
  await ensureFreeTier(userId);

  // 2. Deduct quota
  const deduct = await deductQuota(userId, 1);
  if (!deduct.ok) {
    return { error: deduct.reason, conversationId, quotaRemaining: 0 };
  }

  try {
    // 3. Ensure conversation meta
    await ensureConversation({
      userId, conversationId,
      firstMessagePreview: message.text || '',
      firstMessageImageUrl: Array.isArray(message.imageUrls) ? message.imageUrls[0] : null,
    });

    // 4. Persist user message
    await appendMessage({
      conversationId, userId, role: 'user',
      content: message.text || '',
      imageUrls: message.imageUrls || null,
    });

    // 5. Load context + history
    const systemInstruction = loadSystemInstruction();
    const { xml: contextXml } = await loadSessionContext({ userId, conversationId });
    const allMessages = await loadMessages(conversationId);
    const history = allMessages.slice(0, -1);
    const messages = buildMessages({ systemInstruction, contextXml, history, userMessage: message });

    // 6. Run loop
    const { finalParsed, error, iterations, usageAcc, toolTrace } = await runLoopCore({
      userId, conversationId, messages,
    });

    const latencyMs = Date.now() - turnStart;

    if (!finalParsed) {
      // Refund quota on hard failure
      await refundQuota(userId, 1);
      await recordTurnUsage({
        userId, messages: 0, retries: 0, latencyMs, iterations,
        tokensInput: usageAcc.tokensInput, tokensOutput: usageAcc.tokensOutput,
        tokensCached: usageAcc.tokensCached, costUsd: usageAcc.costUsd,
      });
      return {
        error: error || 'agent_failed',
        conversationId, iterations, latencyMs,
      };
    }

    // 7. Process refs + persist assistant message
    const finalResponse = finalParsed.response;
    const finalRefSets = Array.isArray(finalParsed.reference_sets) ? finalParsed.reference_sets : [];
    let assignedRefSets = [];
    if (finalRefSets.length > 0) {
      assignedRefSets = await matchAndStoreRefSets(conversationId, finalRefSets);
    }

    const aiSaved = await appendMessage({
      conversationId, userId, role: 'assistant',
      content: finalResponse,
      versionData: {
        reference_sets: assignedRefSets,
        iterations,
        toolCalls: toolTrace.length,
        tokensInput: usageAcc.tokensInput,
        tokensOutput: usageAcc.tokensOutput,
        tokensCached: usageAcc.tokensCached,
        embeddingTokens: usageAcc.embeddingTokens,
        costUsd: usageAcc.costUsd,
        latencyMs,
        modelUsed: MODEL,
        apiKeyIndex: usageAcc.apiKeyIndexUsed,
      },
    });

    // 8. Pin preferred API key for cache affinity
    if (usageAcc.apiKeyIndexUsed != null) {
      await setPreferredApiKey({ userId, conversationId, apiKeyIndex: usageAcc.apiKeyIndexUsed });
    }

    // 9. Update title if suggested
    if (finalParsed.suggested_title) {
      await updateConversationTitle({ userId, conversationId, newTitle: finalParsed.suggested_title });
    }

    // 10. Record usage + streak
    await recordTurnUsage({
      userId, messages: 1, retries: 0, latencyMs, iterations,
      tokensInput: usageAcc.tokensInput, tokensOutput: usageAcc.tokensOutput,
      tokensCached: usageAcc.tokensCached, embeddingTokens: usageAcc.embeddingTokens,
      costUsd: usageAcc.costUsd,
    });
    await updateStreak(userId);

    return {
      conversationId,
      isNewConversation,
      response: finalResponse,
      reference_sets: assignedRefSets,
      iterations,
      tool_calls_made: toolTrace.length,
      message_id: aiSaved.messageId,
      latencyMs,
      quotaRemaining: deduct.remaining,
      suggestedTitle: finalParsed.suggested_title || null,
      costUsd: Number(usageAcc.costUsd.toFixed(6)),
    };
  } catch (err) {
    // Refund on any unexpected error before we saved the assistant message
    await refundQuota(userId, 1);
    throw err;
  }
}

// ─── Public entry: retry ────────────────────────────────────────────
export async function runAgentRetry({ userId, conversationId, messageId }) {
  if (!userId || !conversationId || !messageId) {
    throw new Error('userId, conversationId, messageId required');
  }
  const turnStart = Date.now();

  await ensureFreeTier(userId);
  const deduct = await deductQuota(userId, 1);
  if (!deduct.ok) {
    return { error: deduct.reason, conversationId, quotaRemaining: 0 };
  }

  try {
    // Deactivate current active version
    await deactivateActiveVersion({ conversationId, messageId });

    // Load history UP TO (not including) this assistant message
    const all = await loadMessages(conversationId);
    const idx = all.findIndex(m => m.messageId === messageId);
    if (idx === -1) {
      await refundQuota(userId, 1);
      return { error: 'message_not_found', conversationId };
    }
    const history = all.slice(0, idx - 1); // exclude the user msg just before the asst we're retrying
    const userMsg = all[idx - 1];
    if (!userMsg || userMsg.role !== 'user') {
      await refundQuota(userId, 1);
      return { error: 'previous_user_message_not_found', conversationId };
    }

    const systemInstruction = loadSystemInstruction();
    const { xml: contextXml } = await loadSessionContext({ userId, conversationId });
    const messages = buildMessages({
      systemInstruction, contextXml, history,
      userMessage: { text: userMsg.content, imageUrls: userMsg.imageUrls },
    });

    const { finalParsed, error, iterations, usageAcc, toolTrace } = await runLoopCore({
      userId, conversationId, messages,
    });
    const latencyMs = Date.now() - turnStart;

    if (!finalParsed) {
      await refundQuota(userId, 1);
      await recordTurnUsage({ userId, messages: 0, retries: 0, latencyMs, iterations, costUsd: usageAcc.costUsd });
      return { error: error || 'agent_failed', conversationId, iterations, latencyMs };
    }

    const finalResponse = finalParsed.response;
    const finalRefSets = Array.isArray(finalParsed.reference_sets) ? finalParsed.reference_sets : [];
    let assignedRefSets = [];
    if (finalRefSets.length > 0) assignedRefSets = await matchAndStoreRefSets(conversationId, finalRefSets);

    const verInfo = await addNewActiveVersion({
      conversationId, messageId, content: finalResponse,
      versionData: {
        reference_sets: assignedRefSets,
        iterations,
        toolCalls: toolTrace.length,
        tokensInput: usageAcc.tokensInput,
        tokensOutput: usageAcc.tokensOutput,
        tokensCached: usageAcc.tokensCached,
        embeddingTokens: usageAcc.embeddingTokens,
        costUsd: usageAcc.costUsd,
        latencyMs,
        modelUsed: MODEL,
        apiKeyIndex: usageAcc.apiKeyIndexUsed,
      },
    });

    await recordTurnUsage({
      userId, messages: 0, retries: 1, latencyMs, iterations,
      tokensInput: usageAcc.tokensInput, tokensOutput: usageAcc.tokensOutput,
      tokensCached: usageAcc.tokensCached, embeddingTokens: usageAcc.embeddingTokens,
      costUsd: usageAcc.costUsd,
    });
    await updateStreak(userId);

    if (finalParsed.suggested_title) {
      await updateConversationTitle({ userId, conversationId, newTitle: finalParsed.suggested_title });
    }

    return {
      conversationId,
      message_id: messageId,
      version_id: verInfo.versionId,
      response: finalResponse,
      reference_sets: assignedRefSets,
      iterations,
      tool_calls_made: toolTrace.length,
      latencyMs,
      quotaRemaining: deduct.remaining,
      costUsd: Number(usageAcc.costUsd.toFixed(6)),
    };
  } catch (err) {
    await refundQuota(userId, 1);
    throw err;
  }
}

// ─── Public entry: edit user message then regenerate ────────────────
export async function runAgentEditAndRegenerate({ userId, conversationId, messageId, newContent }) {
  await editMessageContent({ conversationId, messageId, newContent });

  // Find the assistant message just after this user message (if any) and retry it
  const all = await loadMessages(conversationId);
  const idx = all.findIndex(m => m.messageId === messageId);
  if (idx === -1) return { error: 'message_not_found', conversationId };

  const nextAssistant = all.slice(idx + 1).find(m => m.role === 'assistant');
  if (!nextAssistant) {
    // No prior assistant response yet — treat as a fresh turn
    return runAgentTurn({
      userId, conversationId,
      message: { text: newContent, imageUrls: all[idx].imageUrls },
    });
  }
  return runAgentRetry({ userId, conversationId, messageId: nextAssistant.messageId });
}
