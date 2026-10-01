import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required'),
  DEV_GUILD_ID: z.string().optional().transform((v) => (v ? v : undefined)),
  DB_PATH: z.string().default('./data/bilal.db'),
  AUDIO_DIR: z.string().default('./assets/audio'),
  HEALTH_FILE: z.string().default('./data/heartbeat'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env file; rely on the real environment (e.g. Docker).
    }
  }
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}
