import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_MAP_STYLE_URL,
  ENV_VAR_NAMES,
  PUBLIC_ENV_VARS,
  SECRET_ENV_VARS,
  hasFixedClock,
  loadWebConfig,
  loadWorkerConfig,
  nowFrom,
} from './env.ts';

// Deterministic test value with the shape of `openssl rand -hex 32`.
const SECRET = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'; // gitleaks:allow

const validWeb = {
  DATABASE_URL: 'postgresql://web:pw@localhost:5432/geonerva',
  RATE_LIMIT_SECRET: SECRET,
  NOMINATIM_CONTACT: 'https://example.org/geonerva-contact',
};

const validWorker = {
  DATABASE_URL_WORKER: 'postgres://worker:pw@localhost:5432/geonerva',
};

function issuesOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected ConfigError');
}

describe('loadWebConfig', () => {
  it('applies documented defaults', () => {
    const config = loadWebConfig(validWeb);
    expect(config.RETENTION_PROFILE).toBe('lean');
    expect(config.MAP_STYLE_URL).toBe(DEFAULT_MAP_STYLE_URL);
    expect(config.NODE_ENV).toBe('development');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects a non-postgres database URL', () => {
    expect(issuesOf(() => loadWebConfig({ ...validWeb, DATABASE_URL: 'mysql://x' }))).toEqual([
      'DATABASE_URL: must be a valid postgres:// or postgresql:// connection URL with a host',
    ]);
  });

  it.each([
    ['whitespace-only', ' '.repeat(40), 'must not contain whitespace'],
    ['low-entropy', 'ab'.repeat(20), 'looks low-entropy (fewer than 12 distinct characters)'],
    ['placeholder', 'changeme-1234567890-abcdefghijklmn', 'looks like a placeholder value'],
  ])('rejects a %s rate-limit secret', (_label, value, message) => {
    expect(issuesOf(() => loadWebConfig({ ...validWeb, RATE_LIMIT_SECRET: value }))).toEqual([
      `RATE_LIMIT_SECRET: ${message}`,
    ]);
  });

  it.each([
    ['unparseable URL with a raw @ in the password', 'postgresql://user:p@ss@word@/geonerva'],
    ['missing host', 'postgresql:///geonerva'],
    ['scheme only', 'postgres://'],
  ])('rejects a %s', (_label, value) => {
    expect(issuesOf(() => loadWebConfig({ ...validWeb, DATABASE_URL: value }))).toEqual([
      'DATABASE_URL: must be a valid postgres:// or postgresql:// connection URL with a host',
    ]);
  });

  it('rejects a short rate-limit secret', () => {
    expect(issuesOf(() => loadWebConfig({ ...validWeb, RATE_LIMIT_SECRET: 'short' }))).toEqual([
      'RATE_LIMIT_SECRET: must be at least 32 characters',
    ]);
  });

  it('rejects a non-https map style URL', () => {
    expect(
      issuesOf(() =>
        loadWebConfig({ ...validWeb, MAP_STYLE_URL: 'http://tiles.example.org/style.json' }),
      ),
    ).toEqual(['MAP_STYLE_URL: must be an https:// URL']);
  });

  it('never echoes secret values in the error message', () => {
    const leakedUrl = 'mysql://admin:hunter2-very-secret@db.internal/prod';
    try {
      loadWebConfig({ ...validWeb, DATABASE_URL: leakedUrl, RATE_LIMIT_SECRET: 'tiny-secret' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('tiny-secret');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('RATE_LIMIT_SECRET');
    }
  });

  it('reports every missing variable at once', () => {
    expect(issuesOf(() => loadWebConfig({}))).toEqual([
      'DATABASE_URL: is required',
      'RATE_LIMIT_SECRET: is required',
      'NOMINATIM_CONTACT: is required',
    ]);
  });
});

describe('loadWorkerConfig', () => {
  it('defaults AI to disabled and treats an empty FIRMS key as absent', () => {
    const config = loadWorkerConfig({ ...validWorker, FIRMS_MAP_KEY: '' });
    expect(config.AI_MODE).toBe('disabled');
    expect(config.FIRMS_MAP_KEY).toBeUndefined();
    expect(config.AI_DAILY_BUDGET_USD).toBe(1);
  });

  /*
   * The build stamp is what `worker_heartbeat.version` and `ingestion_runs.worker_version` carry,
   * so a 24 h soak can say which build produced a failure (p10-plan §2.4). It is optional because
   * a checkout has no build to name, and an image sets it empty so a deployment can override it —
   * which is why empty must mean absent rather than invalid.
   */
  describe('GEONERVA_BUILD', () => {
    it('is absent when unset or empty, rather than a reason to refuse to start', () => {
      expect(loadWorkerConfig(validWorker).GEONERVA_BUILD).toBeUndefined();
      expect(
        loadWorkerConfig({ ...validWorker, GEONERVA_BUILD: '' }).GEONERVA_BUILD,
      ).toBeUndefined();
      expect(
        loadWorkerConfig({ ...validWorker, GEONERVA_BUILD: '  ' }).GEONERVA_BUILD,
      ).toBeUndefined();
    });

    it('accepts the shapes a deployment actually stamps', () => {
      for (const value of ['ef6e970', 'v1.0.0', '2026-09-23.3', 'main+ef6e970']) {
        expect(loadWorkerConfig({ ...validWorker, GEONERVA_BUILD: value }).GEONERVA_BUILD).toBe(
          value,
        );
      }
    });

    it('refuses free text, because it is written to a column a read model exposes', () => {
      expect(
        issuesOf(() => loadWorkerConfig({ ...validWorker, GEONERVA_BUILD: 'built by me' })),
      ).toEqual([
        'GEONERVA_BUILD: must be a plain identifier (letters, digits, dot, underscore, plus, hyphen)',
      ]);
      expect(
        issuesOf(() => loadWorkerConfig({ ...validWorker, GEONERVA_BUILD: 'a'.repeat(65) })),
      ).toEqual(['GEONERVA_BUILD: must be at most 64 characters']);
    });
  });

  it('requires an Anthropic key only when AI_MODE=anthropic', () => {
    expect(loadWorkerConfig({ ...validWorker, AI_MODE: 'disabled' }).ANTHROPIC_API_KEY).toBe(
      undefined,
    );
    expect(issuesOf(() => loadWorkerConfig({ ...validWorker, AI_MODE: 'anthropic' }))).toEqual([
      'ANTHROPIC_API_KEY: is required when AI_MODE=anthropic',
    ]);
    const enabled = loadWorkerConfig({
      ...validWorker,
      AI_MODE: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(enabled.AI_MODEL).toBe('claude-opus-5');
  });

  it('rejects the reserved local AI mode', () => {
    const issues = issuesOf(() => loadWorkerConfig({ ...validWorker, AI_MODE: 'local' }));
    expect(issues[0]).toMatch(/^AI_MODE: "local" is reserved/);
  });

  it('coerces and bounds the AI budget', () => {
    expect(
      loadWorkerConfig({ ...validWorker, AI_DAILY_BUDGET_USD: '2.5' }).AI_DAILY_BUDGET_USD,
    ).toBe(2.5);
    expect(
      issuesOf(() => loadWorkerConfig({ ...validWorker, AI_DAILY_BUDGET_USD: '-1' })),
    ).toHaveLength(1);
  });

  it('rejects an unknown retention profile', () => {
    expect(
      issuesOf(() => loadWorkerConfig({ ...validWorker, RETENTION_PROFILE: 'huge' }))[0],
    ).toMatch(/^RETENTION_PROFILE:/);
  });

  it('rejects a short worker trigger secret when provided', () => {
    expect(
      issuesOf(() => loadWorkerConfig({ ...validWorker, WORKER_TRIGGER_SECRET: 'short' })),
    ).toEqual(['WORKER_TRIGGER_SECRET: must be at least 32 characters']);
  });
});

/**
 * The fixed clock of docs/TESTING.md §5.
 *
 * Two properties are worth more than the rest: an unparseable value **fails** rather than falling
 * back to the wall clock, and a deployed environment refuses the variable outright. A silent
 * fallback would make an E2E suite pass against a clock nobody chose; a fake clock in production
 * would publish stale data as current.
 */
describe('GEONERVA_FAKE_NOW', () => {
  const ANCHOR = '2026-09-22T13:06:00.000Z';

  it('is absent by default, and then "now" is the wall clock', () => {
    const config = loadWebConfig(validWeb);
    expect(config.GEONERVA_FAKE_NOW).toBeUndefined();
    expect(hasFixedClock(config)).toBe(false);
    const before = Date.now();
    const now = nowFrom(config).getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('parses an ISO instant into the instant it names, for both processes', () => {
    for (const config of [
      loadWebConfig({ ...validWeb, NODE_ENV: 'test', GEONERVA_FAKE_NOW: ANCHOR }),
      loadWorkerConfig({ ...validWorker, NODE_ENV: 'test', GEONERVA_FAKE_NOW: ANCHOR }),
    ]) {
      expect(hasFixedClock(config)).toBe(true);
      expect(nowFrom(config).toISOString()).toBe(ANCHOR);
    }
  });

  /*
   * `Date.parse` rolls an impossible date over rather than refusing it, so these were accepted
   * and silently became a different instant: 30 February became 2 March, and 24:00 became the
   * next midnight. A typo in a Playwright config would have frozen the clock two days from the
   * one its author wrote, which is exactly the silence this variable exists to prevent.
   */
  it.each([
    ['a day the month does not have', '2026-02-30T00:00:00Z'],
    ['the 31st of a 30-day month', '2026-09-31T00:00:00Z'],
    ['an hour past the end of the day', '2026-09-22T24:00:00Z'],
    ['a minute past the end of the hour', '2026-09-22T13:60:00Z'],
    ['a leap second', '2026-09-22T23:59:60Z'],
  ])('refuses %s rather than rolling it over', (_case, value) => {
    expect(() =>
      loadWebConfig({ ...validWeb, NODE_ENV: 'test', GEONERVA_FAKE_NOW: value }),
    ).toThrow(/is not a real instant/u);
  });

  it('accepts 29 February in a leap year, which is a real day', () => {
    const config = loadWebConfig({
      ...validWeb,
      NODE_ENV: 'test',
      GEONERVA_FAKE_NOW: '2028-02-29T00:00:00.000Z',
    });
    expect(nowFrom(config).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  /*
   * `NODE_ENV` has a default, so an environment that says nothing parses as `development` — and
   * the clock would have been accepted on the strength of a value nobody chose. The variable is
   * only ever wanted in a test run, so it requires the operator to say so.
   */
  it('refuses a fixed clock when nothing says which environment this is', () => {
    // `validWeb` sets no NODE_ENV, which is exactly the environment under test.
    expect(() => loadWebConfig({ ...validWeb, GEONERVA_FAKE_NOW: ANCHOR })).toThrow(
      /must not be set unless NODE_ENV is explicitly development or test/u,
    );
    expect(() => loadWorkerConfig({ ...validWorker, GEONERVA_FAKE_NOW: ANCHOR })).toThrow(
      /must not be set unless NODE_ENV is explicitly development or test/u,
    );
    // The same environment without the clock still loads: the rule is about the pair.
    expect(loadWebConfig(validWeb).GEONERVA_FAKE_NOW).toBeUndefined();
  });

  it('freezes the clock: two reads a moment apart are the same instant', () => {
    const config = loadWebConfig({ ...validWeb, NODE_ENV: 'test', GEONERVA_FAKE_NOW: ANCHOR });
    expect(nowFrom(config).getTime()).toBe(nowFrom(config).getTime());
  });

  it('hands out a fresh Date, so a caller cannot move the clock for everyone else', () => {
    const config = loadWebConfig({ ...validWeb, NODE_ENV: 'test', GEONERVA_FAKE_NOW: ANCHOR });
    const first = nowFrom(config);
    first.setUTCFullYear(1999);
    expect(nowFrom(config).toISOString()).toBe(ANCHOR);
  });

  it('treats an empty value as absent, like every other optional variable', () => {
    expect(
      loadWebConfig({ ...validWeb, NODE_ENV: 'test', GEONERVA_FAKE_NOW: '' }).GEONERVA_FAKE_NOW,
    ).toBeUndefined();
    expect(
      loadWebConfig({ ...validWeb, NODE_ENV: 'test', GEONERVA_FAKE_NOW: '   ' }).GEONERVA_FAKE_NOW,
    ).toBeUndefined();
  });

  it.each([
    ['a bare date with no time', '2026-09-22'],
    ['an instant with no offset', '2026-09-22T13:06:00'],
    ['a human date', '22 September 2026 13:06 UTC'],
    ['nonsense', 'yesterday'],
    ['an empty-looking token', 'now'],
    ['a millisecond epoch', '1790161560000'],
  ])('refuses %s rather than falling back to the wall clock', (_label, value) => {
    expect(
      issuesOf(() => loadWebConfig({ ...validWeb, NODE_ENV: 'test', GEONERVA_FAKE_NOW: value })),
    ).toEqual([
      'GEONERVA_FAKE_NOW: must be a full ISO 8601 instant with an offset, e.g. 2026-09-22T13:06:00.000Z (a date alone is not accepted)',
    ]);
  });

  it('refuses a well-shaped instant that is not a real one', () => {
    expect(
      issuesOf(() =>
        loadWebConfig({ ...validWeb, NODE_ENV: 'test', GEONERVA_FAKE_NOW: '2026-13-45T99:99:99Z' }),
      ),
    ).toEqual([
      'GEONERVA_FAKE_NOW: is not a real instant: check the day of the month and the time of day',
    ]);
  });

  it('is refused in production, in both processes', () => {
    const message =
      'GEONERVA_FAKE_NOW: must not be set when NODE_ENV=production: a fixed clock in a deployed environment would publish stale data as current';
    expect(
      issuesOf(() =>
        loadWebConfig({ ...validWeb, NODE_ENV: 'production', GEONERVA_FAKE_NOW: ANCHOR }),
      ),
    ).toEqual([message]);
    expect(
      issuesOf(() =>
        loadWorkerConfig({ ...validWorker, NODE_ENV: 'production', GEONERVA_FAKE_NOW: ANCHOR }),
      ),
    ).toEqual([message]);
  });

  it('is allowed in development and in test', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      const config = loadWebConfig({ ...validWeb, NODE_ENV: nodeEnv, GEONERVA_FAKE_NOW: ANCHOR });
      expect(config.GEONERVA_FAKE_NOW?.toISOString()).toBe(ANCHOR);
    }
  });

  it('does not make a production process fail merely for being production', () => {
    expect(
      loadWebConfig({ ...validWeb, NODE_ENV: 'production' }).GEONERVA_FAKE_NOW,
    ).toBeUndefined();
  });
});

/*
 * `apps/worker/src/cli/startup-error.ts` shows a `ConfigError` to the operator unredacted, on the
 * grounds that its message names variables and never values. That is a property of what the schema
 * produces, not something the class enforces — one `.refine(…, { message: `got ${value}` })` added
 * in a later phase would quietly turn the whitelist into a value printer. So it is pinned here,
 * where such a refinement would be written.
 */
describe('a configuration failure never echoes a value (startup-error.ts depends on this)', () => {
  it('names the variable and the rule, for every way each one can be wrong', () => {
    const poison = 'hunter2-SUPERSECRET';
    const cases: Record<string, string>[] = [
      { ...validWorker, DATABASE_URL_WORKER: `mysql://user:${poison}@host/db` },
      { ...validWorker, GEONERVA_BUILD: `built by ${poison}` },
      { ...validWorker, AI_MODE: poison },
      { ...validWorker, AI_DAILY_BUDGET_USD: poison },
      { ...validWeb, RATE_LIMIT_SECRET: poison },
      { ...validWeb, MAP_STYLE_URL: `http://insecure.example/${poison}` },
      { ...validWeb, NOMINATIM_CONTACT: '' },
    ];

    for (const env of cases) {
      const issues = issuesOf(() =>
        'DATABASE_URL_WORKER' in env ? loadWorkerConfig(env) : loadWebConfig(env),
      );
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) expect(issue).not.toContain(poison);
    }
  });
});

describe('secret inventory (docs/reviews/security-p1.md R-3)', () => {
  it('lists every declared variable whose name implies a credential', () => {
    const sensitive = ENV_VAR_NAMES.filter((name) =>
      /(SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|_URL$|_DSN$)/.test(name),
    );
    const covered = new Set<string>([...SECRET_ENV_VARS, ...PUBLIC_ENV_VARS]);
    const uncovered = sensitive.filter((name) => !covered.has(name));
    expect(
      uncovered,
      'add each of these to SECRET_ENV_VARS (canary-scanned) or PUBLIC_ENV_VARS (deliberately public)',
    ).toEqual([]);
  });

  it('only lists variables that are actually declared', () => {
    for (const name of [...SECRET_ENV_VARS, ...PUBLIC_ENV_VARS]) {
      expect(ENV_VAR_NAMES, `${name} is listed but not declared in any schema`).toContain(name);
    }
  });
});
