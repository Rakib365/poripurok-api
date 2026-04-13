import { success } from '@/lib/utils/response';

export async function GET() {
  return success({ status: 'ok', timestamp: new Date().toISOString() });
}
