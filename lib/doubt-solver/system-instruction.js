/**
 * System Instruction Loader
 * Reads the markdown file once and caches it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// system-instruction.md lives at: app/api/doubt-solver/system-instruction.md
const INSTRUCTION_PATH = path.resolve(__dirname, '../../app/api/doubt-solver/system-instruction.md');

let cachedInstruction = null;

export function loadSystemInstruction() {
  if (cachedInstruction) return cachedInstruction;
  cachedInstruction = fs.readFileSync(INSTRUCTION_PATH, 'utf-8');
  return cachedInstruction;
}

export function resetInstructionCache() {
  cachedInstruction = null;
}
