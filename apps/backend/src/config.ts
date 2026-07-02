import { z } from 'zod';

const booleanEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/**
 * Startup environment schema. Every variable here is required for the
 * backend to boot; `loadEnv` validates `process.env` against it and exits
 * the process if anything is missing or malformed.
 */
export const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  PORT: z.coerce.number().int('PORT must be an integer').positive('PORT must be positive'),
  TOKEN_TRANSFER_CONTRACT_ID: z.string().min(1, 'TOKEN_TRANSFER_CONTRACT_ID is required'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .preprocess((val) => {
      if (val === 'true' || val === true) return true;
      if (val === 'false' || val === false) return false;
      return undefined;
    }, z.boolean())
    .optional(),
  OBJECT_STORE_ENDPOINT: z.string().min(1, 'OBJECT_STORE_ENDPOINT is required'),
  OBJECT_STORE_BUCKET: z.string().min(1, 'OBJECT_STORE_BUCKET is required'),
  OBJECT_STORE_ACCESS_KEY: z.string().min(1, 'OBJECT_STORE_ACCESS_KEY is required'),
  OBJECT_STORE_SECRET_KEY: z.string().min(1, 'OBJECT_STORE_SECRET_KEY is required'),
  OBJECT_STORE_REGION: z.string().min(1, 'OBJECT_STORE_REGION is required'),
  OBJECT_STORE_FORCE_PATH_STYLE: booleanEnv,
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validate the given environment (defaults to `process.env`) against
 * `EnvSchema`. On success returns the parsed, typed env and emits no
 * output. On failure it logs the offending variables and exits with code 1.
 *
 * The `source` parameter exists so tests can stub the environment without
 * mutating the real `process.env`.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    const vars = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    console.error(`Missing or invalid environment variables: ${vars.join(', ')}`);
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}
