import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_MAP_STYLE_URL, loadWebConfig, loadWorkerConfig } from './env.ts';

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
