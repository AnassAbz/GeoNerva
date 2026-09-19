import { z } from 'zod';

/** Deployment retention profiles (docs/ARCHITECTURE.md §12, ADR-018). */
export const RETENTION_PROFILES = ['lean', 'standard'] as const;
export type RetentionProfile = (typeof RETENTION_PROFILES)[number];

/** Runtime AI modes (ADR-012). `local` is reserved and deliberately rejected until implemented. */
export const AI_MODES = ['disabled', 'anthropic', 'local'] as const;
export type AiMode = (typeof AI_MODES)[number];

export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
export const DEFAULT_AI_MODEL = 'claude-opus-5';

/** A string variable whose absence is reported as "is required" rather than as a type error. */
function requiredString() {
  return z.string({
    error: (issue) => (issue.input === undefined ? 'is required' : 'must be a string'),
  });
}

/** True when the value parses as a URL with a Postgres scheme and a host. */
export function isPostgresUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== '';
}

const postgresUrl = requiredString().trim().refine(isPostgresUrl, {
  message: 'must be a valid postgres:// or postgresql:// connection URL with a host',
});

const MIN_SECRET_LENGTH = 32;
const MIN_SECRET_DISTINCT_CHARACTERS = 12;
const PLACEHOLDER_SECRET = /change[-_]?me|placeholder|example|(secret){2,}|password/i;

/**
 * Rejects weak or placeholder secrets (e.g. 32 spaces, "changeme" repeated). The limits are
 * deliberately simple: `openssl rand -hex 32` always passes.
 */
const secret = requiredString()
  .min(MIN_SECRET_LENGTH, {
    message: `must be at least ${MIN_SECRET_LENGTH} characters`,
    abort: true,
  })
  .refine((value) => !/\s/.test(value), { message: 'must not contain whitespace', abort: true })
  .refine((value) => new Set(value).size >= MIN_SECRET_DISTINCT_CHARACTERS, {
    message: `looks low-entropy (fewer than ${MIN_SECRET_DISTINCT_CHARACTERS} distinct characters)`,
    abort: true,
  })
  .refine((value) => !PLACEHOLDER_SECRET.test(value), {
    message: 'looks like a placeholder value',
  });

const optionalNonEmpty = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RETENTION_PROFILE: z.enum(RETENTION_PROFILES).default('lean'),
};

const webSchema = z.object({
  ...common,
  DATABASE_URL: postgresUrl,
  RATE_LIMIT_SECRET: secret,
  NOMINATIM_CONTACT: requiredString()
    .trim()
    .min(3, { message: 'is required by the OSMF usage policy' }),
  MAP_STYLE_URL: z
    .string()
    .trim()
    .refine((value) => URL.canParse(value) && new URL(value).protocol === 'https:', {
      message: 'must be an https:// URL',
    })
    .default(DEFAULT_MAP_STYLE_URL),
});

const workerSchema = z
  .object({
    ...common,
    DATABASE_URL_WORKER: postgresUrl,
    FIRMS_MAP_KEY: optionalNonEmpty,
    WORKER_TRIGGER_SECRET: secret.optional(),
    AI_MODE: z.enum(AI_MODES).default('disabled'),
    ANTHROPIC_API_KEY: optionalNonEmpty,
    AI_MODEL: z.string().trim().min(1).default(DEFAULT_AI_MODEL),
    AI_DAILY_BUDGET_USD: z.coerce.number().min(0).max(1000).default(1),
  })
  .superRefine((env, ctx) => {
    if (env.AI_MODE === 'anthropic' && env.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'is required when AI_MODE=anthropic',
      });
    }
    if (env.AI_MODE === 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_MODE'],
        message: '"local" is reserved and not implemented yet (see docs/DECISIONS.md ADR-012)',
      });
    }
  });

export type WebConfig = Readonly<z.infer<typeof webSchema>>;
export type WorkerConfig = Readonly<z.infer<typeof workerSchema>>;

/** Raised when the environment is invalid. Lists variable names and problems, never values. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(processName: string, issues: readonly string[]) {
    super(`Invalid ${processName} configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function parse<T>(processName: string, schema: z.ZodType<T>, env: Env): Readonly<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.map(String).join('.') || '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(processName, issues);
  }
  return Object.freeze(result.data);
}

/** Validates the environment of the read-only web process. */
export function loadWebConfig(env: Env = process.env): WebConfig {
  return parse('web', webSchema, env);
}

/** Validates the environment of the ingestion worker process. */
export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  return parse('worker', workerSchema, env);
}
