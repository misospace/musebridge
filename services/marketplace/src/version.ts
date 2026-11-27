import { createRequire } from 'node:module';
import { z } from 'zod';

const metadata: unknown = createRequire(import.meta.url)('../package.json');
export const SERVICE_VERSION = z.object({ version: z.string().min(1) }).parse(metadata).version;
