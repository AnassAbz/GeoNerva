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

/**
 * The fixed clock of docs/TESTING.md §5, parsed into the instant it names.
 *
 * Strict on purpose. An unparseable value **fails the process**; it must never fall back to the
 * wall clock, because the whole point of the variable is that the reader can trust what "now"
 * means. A silent fallback would turn a typo in a Playwright config into an E2E suite that passes
 * against a clock nobody chose, and the failures it would then produce — a relative time drifting
 * between two assertions in one spec — are the most expensive kind to diagnose.
 *
 * `Date.parse` is not enough on its own: it accepts `2026-09-22` (midnight UTC, which is probably
 * not what the author meant) and, worse, is implementation-defined for anything non-ISO. So the
 * shape is required to be a full ISO 8601 instant with an explicit offset.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

const fakeNow = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()
  .refine((value) => value === undefined || ISO_INSTANT.test(value), {
    message:
      'must be a full ISO 8601 instant with an offset, e.g. 2026-09-22T13:06:00.000Z (a date alone is not accepted)',
    abort: true,
  })
  .refine((value) => value === undefined || Number.isFinite(Date.parse(value)), {
    message: 'is not a real instant',
  })
  .transform((value) => (value === undefined ? undefined : new Date(Date.parse(value))));

const common = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  RETENTION_PROFILE: z.enum(RETENTION_PROFILES).default('lean'),
  /**
   * Freezes the clock every process reads through `nowFrom` (docs/TESTING.md §5).
   *
   * Declared on both processes so that neither can be started with a fake clock in production —
   * a deployed worker stamping `ingested_at` from a frozen clock would corrupt the bitemporal
   * record, and a deployed web process would publish stale data as current. The refusal is in
   * each schema's `superRefine` below, not here, because a cross-field rule needs both fields.
   */
  GEONERVA_FAKE_NOW: fakeNow,
};

/**
 * Refuses a fixed clock in a deployed environment.
 *
 * `NODE_ENV=production` is the only signal the config layer has, and it is the right one: it is
 * what `createPool` already uses to require TLS. The refusal is a `ConfigError`, so the process
 * does not start — not a warning and not a silent ignore. A deployment that has this variable set
 * has something badly wrong with it, and the loudest possible failure is the cheapest one.
 */
function refuseFakeClockInProduction(
  env: { readonly NODE_ENV: string; readonly GEONERVA_FAKE_NOW?: Date | undefined },
  ctx: z.RefinementCtx,
): void {
  if (env.NODE_ENV !== 'production' || env.GEONERVA_FAKE_NOW === undefined) return;
  ctx.addIssue({
    code: 'custom',
    path: ['GEONERVA_FAKE_NOW'],
    message:
      'must not be set when NODE_ENV=production: a fixed clock in a deployed environment would publish stale data as current',
  });
}

/**
 * Variables that must never reach a browser, used by `pnpm build:canary`
 * (scripts/check-bundle-secrets.ts). `env.test.ts` fails if a new secret-looking variable is
 * added to a schema without being listed here (docs/reviews/security-p1.md R-3).
 */
export const SECRET_ENV_VARS = [
  'DATABASE_URL',
  'DATABASE_URL_WORKER',
  'RATE_LIMIT_SECRET',
  'FIRMS_MAP_KEY',
  'WORKER_TRIGGER_SECRET',
  'ANTHROPIC_API_KEY',
] as const;

/** Variables whose names look sensitive but are deliberately public. */
export const PUBLIC_ENV_VARS = ['MAP_STYLE_URL'] as const;

const webObject = z.object({
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

const webSchema = webObject.superRefine(refuseFakeClockInProduction);

const workerObject = z
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
    refuseFakeClockInProduction(env, ctx);
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

const workerSchema = workerObject;

/** Every declared variable name, so tests can check the secret inventory (R-3). */
export const ENV_VAR_NAMES: readonly string[] = [
  ...new Set([...Object.keys(webObject.shape), ...Object.keys(workerObject.shape)]),
];

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

/**
 * "Now", from a validated configuration. **The single source of the clock.**
 *
 * Every process should reach its wall clock through this function rather than calling `new Date()`
 * itself, so that a fixed clock is a configuration change and not a code change. It is a plain
 * function of the config rather than a memoized singleton: the caller decides the lifetime, and a
 * request handler that captures one instant and passes it down (which is what `apiRoute` does)
 * already has the property that matters — one clock per request.
 *
 * With `GEONERVA_FAKE_NOW` set, every call returns that instant; a **new** `Date` each time, so a
 * caller that mutates its result cannot move the frozen clock for everyone else.
 */
export function nowFrom(config: { readonly GEONERVA_FAKE_NOW?: Date | undefined }): Date {
  const fixed = config.GEONERVA_FAKE_NOW;
  return fixed === undefined ? new Date() : new Date(fixed.getTime());
}

/** True when this configuration freezes the clock. For a banner, a log line or a test. */
export function hasFixedClock(config: { readonly GEONERVA_FAKE_NOW?: Date | undefined }): boolean {
  return config.GEONERVA_FAKE_NOW !== undefined;
}
