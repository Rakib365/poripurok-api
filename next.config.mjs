import { dirname } from 'path';
import { fileURLToPath } from 'url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // The agent loop reads system-instruction.md at runtime via fs.readFileSync.
  // Next.js file tracing won't follow a dynamic readFileSync, so include it explicitly.
  outputFileTracingIncludes: {
    '/api/doubt-solver/chat':  ['./app/api/doubt-solver/system-instruction.md'],
    '/api/doubt-solver/retry': ['./app/api/doubt-solver/system-instruction.md'],
  },
};

export default nextConfig;
