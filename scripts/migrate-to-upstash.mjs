/**
 * Migration Script: DynamoDB questionbank-projects → Upstash Search
 *
 * Scans all completed projects, extracts questions with status "complete",
 * transforms them into Upstash Search documents, and batch upserts.
 *
 * Usage: node scripts/migrate-to-upstash.js [--dry-run] [--project PROJECT_ID]
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env.local') });

// ===== Config =====
const QB_TABLE = 'questionbank-projects';
const UPSTASH_URL = process.env.UPSTASH_SEARCH_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_SEARCH_REST_TOKEN;
const BATCH_SIZE = 100;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINGLE_PROJECT = args.find((a, i) => args[i - 1] === '--project');

// ===== DynamoDB Client =====
const ddbClient = new DynamoDBClient({ region: 'ap-south-1' });
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// ===== Helpers =====

/** Strip LaTeX commands for cleaner search text */
function stripLatex(text) {
  if (!text) return '';
  return text
    .replace(/\$\$(.*?)\$\$/gs, '$1')     // $$...$$ blocks
    .replace(/\$(.*?)\$/g, '$1')           // $...$ inline
    .replace(/\\(?:frac|sqrt|text|mathrm|mathbf|overline|underline|hat|vec|bar)\{([^}]*)\}/g, '$1')
    .replace(/\\(?:left|right|Big|big|bigg)[()[\]{}|.]/g, '')
    .replace(/\\(?:times|cdot|div|pm|mp|leq|geq|neq|approx|equiv|sim)/g, ' ')
    .replace(/\\(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|nu|pi|sigma|omega|phi|psi|rho|tau|eta|zeta|xi|kappa|chi|Delta|Gamma|Theta|Lambda|Sigma|Omega|Phi|Psi|Pi)/g, '')
    .replace(/\\[a-zA-Z]+/g, '')           // remaining commands
    .replace(/[{}\\^_]/g, '')              // braces and special chars
    .replace(/\s+/g, ' ')                  // collapse whitespace
    .trim();
}

/** Build searchable content string from question */
function buildSearchContent(question) {
  const c = question.content || {};
  const parts = [];

  // Stem text
  if (c.stem_text) parts.push(stripLatex(c.stem_text));
  if (c.question) parts.push(stripLatex(c.question));

  // Options (for MCQ)
  if (Array.isArray(c.options)) {
    c.options.forEach((opt, i) => {
      const label = String.fromCharCode(0x0995 + i); // ক, খ, গ, ঘ
      parts.push(`${label}. ${stripLatex(opt)}`);
    });
  }

  // Sub-questions (for StemBased MCQ)
  if (Array.isArray(c.mcqQuestions)) {
    c.mcqQuestions.forEach((sq) => {
      if (sq.question_text) parts.push(stripLatex(sq.question_text));
      if (Array.isArray(sq.options)) {
        sq.options.forEach(opt => parts.push(stripLatex(opt)));
      }
    });
  }

  return parts.filter(Boolean).join('\n');
}

/**
 * Build content object for Upstash Search filtering.
 * These fields can be used in filter expressions.
 */
function buildContent(question, projectMeta) {
  const c = question.content || {};
  const taxonomy = c.taxonomy || {};
  // Primary: question-level source details; fallback: project-level meta
  const sourceDetails = c.source?.details || {};
  const topics = taxonomy.topics || [];
  const firstTopic = topics[0] || {};

  return {
    questionType: question.questionType || 'MCQ',
    mcqType: c.mcqType || 'SingleCorrect',
    subject: taxonomy.subject || question.classifiedSubject?.subject || '',
    paper: taxonomy.paper || 0,
    difficulty: c.difficulty || 'Medium',
    cognitiveLevel: c.cognitiveLevel || '',
    institution: sourceDetails.abbreviation || projectMeta.institution || 'DU',
    unit: sourceDetails.unitOrGroup || projectMeta.unit || '',
    session: sourceDetails.year || projectMeta.session || '',
    chapter: firstTopic.chapter || '',
    topic: firstTopic.topic || '',
    hasImage: !!(c.hasImage || question.croppedImageS3Keys?.length > 0),
    hasSolution: !!(c.solution?.brief || c.solution?.detailed),
  };
}

/**
 * Build metadata object — extra data returned with search results.
 */
function buildMetadata(question, projectMeta) {
  const c = question.content || {};
  const taxonomy = c.taxonomy || {};
  const topics = taxonomy.topics || [];

  return {
    projectId: question.projectId || '',
    pageNumber: question.pageNumber || 0,
    tags: c.tags || [],
    topics: topics.map(t => ({ chapter: t.chapter, topic: t.topic, subTopics: t.subTopics })),
  };
}

// ===== Upstash Search API =====

async function upstashRequest(endpoint, body) {
  const res = await fetch(`${UPSTASH_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash ${endpoint} failed (${res.status}): ${text}`);
  }

  return res.json();
}

const NAMESPACE = 'questions';

async function batchUpsert(documents) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would upsert ${documents.length} documents`);
    return;
  }

  return upstashRequest(`upsert-data/${NAMESPACE}`, documents);
}

// ===== DynamoDB Queries =====

/** Scan all completed projects */
async function getAllCompletedProjects() {
  const projects = [];
  let lastKey = undefined;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName: QB_TABLE,
      FilterExpression: 'SK = :sk AND begins_with(PK, :projPrefix)',
      ExpressionAttributeNames: {
        '#u': 'unit',
        '#sess': 'session',
      },
      ExpressionAttributeValues: {
        ':sk': 'METADATA',
        ':projPrefix': 'PROJECT#',
      },
      ProjectionExpression: 'PK, projectId, title, institution, #u, #sess, questionCount',
      ExclusiveStartKey: lastKey,
    }));

    projects.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return projects;
}

/** Get all completed questions for a project */
async function getProjectQuestions(projectId) {
  const questions = [];
  let lastKey = undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: QB_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      FilterExpression: '#s = :complete',
      ExpressionAttributeNames: {
        '#s': 'status',
      },
      ExpressionAttributeValues: {
        ':pk': `PROJECT#${projectId}`,
        ':sk': 'QUESTION#',
        ':complete': 'complete',
      },
      ExclusiveStartKey: lastKey,
    }));

    questions.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return questions;
}

// ===== Main Migration =====

async function migrate() {
  console.log('=== Upstash Search Migration ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Table: ${QB_TABLE}`);
  console.log(`Upstash URL: ${UPSTASH_URL}`);
  console.log();

  // Verify Upstash connection
  if (!DRY_RUN) {
    try {
      const info = await fetch(`${UPSTASH_URL}/info`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` },
      });
      const infoData = await info.json();
      console.log('Upstash index info:', JSON.stringify(infoData, null, 2));
      console.log();
    } catch (e) {
      console.error('Failed to connect to Upstash:', e.message);
      process.exit(1);
    }
  }

  // Get projects
  let projects;
  if (SINGLE_PROJECT) {
    console.log(`Single project mode: ${SINGLE_PROJECT}`);
    projects = [{ projectId: SINGLE_PROJECT, PK: `PROJECT#${SINGLE_PROJECT}` }];
  } else {
    console.log('Scanning all completed projects...');
    projects = await getAllCompletedProjects();
    console.log(`Found ${projects.length} completed projects`);
  }
  console.log();

  let totalQuestions = 0;
  let totalUpserted = 0;
  let totalErrors = 0;
  let buffer = [];

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    const projectId = project.projectId || project.PK?.replace('PROJECT#', '');

    if (!projectId) {
      console.log(`  [SKIP] Project with no ID at index ${i}`);
      continue;
    }

    const projectMeta = {
      institution: project.institution || 'DU',
      unit: project.unit || '',
      session: project.session || '',
    };

    console.log(`[${i + 1}/${projects.length}] Project: ${project.title || projectId} (${projectId})`);

    try {
      const questions = await getProjectQuestions(projectId);
      console.log(`  Found ${questions.length} completed questions`);
      totalQuestions += questions.length;

      for (const q of questions) {
        const searchText = buildSearchContent(q);
        if (!searchText) {
          console.log(`  [SKIP] Empty content for question ${q.questionId}`);
          continue;
        }

        const contentFields = buildContent(q, projectMeta);
        const metadata = buildMetadata(q, projectMeta);
        const questionId = q.questionId || q.SK?.replace('QUESTION#', '');

        buffer.push({
          id: questionId,
          data: searchText,
          content: contentFields,
          metadata,
        });

        // Flush batch
        if (buffer.length >= BATCH_SIZE) {
          try {
            await batchUpsert(buffer);
            totalUpserted += buffer.length;
            console.log(`  Upserted batch of ${buffer.length} (total: ${totalUpserted})`);
          } catch (e) {
            console.error(`  [ERROR] Batch upsert failed: ${e.message}`);
            totalErrors += buffer.length;
          }
          buffer = [];
        }
      }
    } catch (e) {
      console.error(`  [ERROR] Failed to process project ${projectId}: ${e.message}`);
      totalErrors++;
    }
  }

  // Flush remaining
  if (buffer.length > 0) {
    try {
      await batchUpsert(buffer);
      totalUpserted += buffer.length;
      console.log(`  Upserted final batch of ${buffer.length}`);
    } catch (e) {
      console.error(`  [ERROR] Final batch upsert failed: ${e.message}`);
      totalErrors += buffer.length;
    }
  }

  console.log();
  console.log('=== Migration Complete ===');
  console.log(`Total projects: ${projects.length}`);
  console.log(`Total questions found: ${totalQuestions}`);
  console.log(`Total upserted: ${totalUpserted}`);
  console.log(`Total errors: ${totalErrors}`);
}

migrate().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
