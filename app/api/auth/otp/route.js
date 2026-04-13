import { randomInt, createHash } from 'crypto';
import { docClient, TABLE } from '@/lib/aws/dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { validateClientKey } from '@/lib/auth/middleware';
import { isValidPhone } from '@/lib/utils/validation';
import { success, error } from '@/lib/utils/response';
import { logger } from '@/lib/aws/cloudwatch';

const OTP_EXPIRY_SECONDS = 5 * 60;

function generateOTP() {
  return randomInt(100000, 999999).toString();
}

function hashOTP(otp) {
  return createHash('sha256').update(otp).digest('hex');
}

async function sendSMS(phone, otp) {
  const params = new URLSearchParams({
    token: process.env.GREENWEB_SMS_TOKEN,
    to: `+88${phone}`,
    message: `(Poripurok) Your OTP is ${otp}`,
  });

  const res = await fetch('https://api.greenweb.com.bd/api.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  return res.ok;
}

export async function POST(request) {
  try {
    if (!validateClientKey(request)) {
      return error('Unauthorized', 401);
    }

    const { phone } = await request.json();
    if (!isValidPhone(phone)) {
      return error('Invalid phone number');
    }

    const otp = generateOTP();
    const now = Math.floor(Date.now() / 1000);

    // Store hashed OTP with TTL (auto-deletes after expiry)
    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `OTP#${phone}`,
        SK: 'OTP',
        otp_hash: hashOTP(otp),
        attempts: 0,
        created_at: new Date().toISOString(),
        ttl: now + OTP_EXPIRY_SECONDS,
      },
    }));

    await sendSMS(phone, otp);

    logger.info('OTP sent', { phone: phone.slice(-4) });
    return success({ message: 'OTP sent successfully' });
  } catch (e) {
    logger.error('send-otp failed', { error: e.message });
    return error('Internal server error', 500);
  }
}
