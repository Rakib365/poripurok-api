import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  CreateLogStreamCommand,
  DescribeLogStreamsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const client = new CloudWatchLogsClient({
  region: process.env.AWS_REGION || 'ap-south-1',
});

const LOG_GROUP = process.env.CLOUDWATCH_LOG_GROUP || '/poripurok/api';

// Generate stream name: date-based for easy navigation
function getStreamName() {
  const now = new Date();
  return `${now.toISOString().slice(0, 10)}/auth`;
}

let streamEnsured = {};

async function ensureStream(streamName) {
  if (streamEnsured[streamName]) return;
  try {
    await client.send(new CreateLogStreamCommand({
      logGroupName: LOG_GROUP,
      logStreamName: streamName,
    }));
  } catch (e) {
    if (e.name !== 'ResourceAlreadyExistsException') throw e;
  }
  streamEnsured[streamName] = true;
}

export async function log(level, message, data = {}) {
  const streamName = getStreamName();
  const logEntry = {
    level,
    message,
    ...data,
    timestamp: new Date().toISOString(),
  };

  // Always console.log for local dev / Vercel logs
  console[level === 'error' ? 'error' : 'log'](`[${level.toUpperCase()}] ${message}`, data);

  try {
    await ensureStream(streamName);
    await client.send(new PutLogEventsCommand({
      logGroupName: LOG_GROUP,
      logStreamName: streamName,
      logEvents: [{
        timestamp: Date.now(),
        message: JSON.stringify(logEntry),
      }],
    }));
  } catch (e) {
    // Don't let logging failures break the API
    console.error('CloudWatch log failed:', e.message);
  }
}

export const logger = {
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
};
