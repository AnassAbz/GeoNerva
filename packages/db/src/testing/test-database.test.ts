import { describe, expect, it } from 'vitest';

import {
  ALLOW_REMOTE_VAR,
  DEFAULT_TEST_DATABASE_URL,
  TEST_DATABASE_URL_VAR,
  UnsafeTestDatabaseError,
  resolveTestDatabaseUrl,
} from './test-database.ts';

const REMOTE_PROD = 'postgresql://app:pw@db.abcdefgh.supabase.co:5432/postgres';
const REMOTE_TEST = 'postgresql://app:pw@db.abcdefgh.supabase.co:5432/geonerva_test';
const LOCAL_TEST = 'postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva_test';

describe('F-6: integration tests may only reach a test database', () => {
  it('uses the documented local default when the variable is unset', () => {
    expect(resolveTestDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(DEFAULT_TEST_DATABASE_URL).toContain('geonerva_test');
  });

  it('never falls back to the application URLs', () => {
    // The whole point of F-6: a developer with a production URL exported in their shell must not
    // lose data to `pnpm test:integration`.
    const env = {
      DATABASE_URL: REMOTE_PROD,
      DATABASE_URL_WORKER: REMOTE_PROD,
    };
    expect(resolveTestDatabaseUrl(env)).toBe(DEFAULT_TEST_DATABASE_URL);
  });

  it('accepts an explicit local test database', () => {
    expect(resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: LOCAL_TEST })).toBe(LOCAL_TEST);
  });

  it('refuses a local database that is not named *_test (S-3)', () => {
    // Loopback is not evidence that a database is disposable: the development database is on
    // loopback, and so is any production database someone has tunnelled. These tests migrate and
    // TRUNCATE whatever they are given, so the name has to say that losing it is acceptable.
    for (const local of [
      'postgresql://geonerva:geonerva@localhost:54320/geonerva',
      'postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva_scratch',
    ]) {
      expect(() => resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: local })).toThrow(
        UnsafeTestDatabaseError,
      );
    }
  });

  it('accepts a local database whose name ends in _test', () => {
    const local = 'postgresql://geonerva:geonerva@localhost:54320/scratch_test';
    expect(resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: local })).toBe(local);
  });

  it('refuses a remote host by default, even when the name ends in _test', () => {
    expect(() => resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: REMOTE_TEST })).toThrow(
      UnsafeTestDatabaseError,
    );
  });

  it('refuses a remote non-test database by default', () => {
    expect(() => resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: REMOTE_PROD })).toThrow(
      UnsafeTestDatabaseError,
    );
  });

  it('allows a remote database only with the explicit escape hatch', () => {
    expect(
      resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: REMOTE_TEST, [ALLOW_REMOTE_VAR]: '1' }),
    ).toBe(REMOTE_TEST);
  });

  it('treats any value other than "1" as not granting the escape hatch', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      expect(() =>
        resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: REMOTE_TEST, [ALLOW_REMOTE_VAR]: value }),
      ).toThrow(UnsafeTestDatabaseError);
    }
  });

  it('refuses a URL with no database name', () => {
    expect(() =>
      resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: 'postgresql://geonerva@127.0.0.1:54320/' }),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it('treats an empty variable as unset rather than as an error', () => {
    expect(resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: '   ' })).toBe(
      DEFAULT_TEST_DATABASE_URL,
    );
  });

  it('names the host and database in the refusal, but never the password', () => {
    try {
      resolveTestDatabaseUrl({ [TEST_DATABASE_URL_VAR]: REMOTE_PROD });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('db.abcdefgh.supabase.co');
      expect(message).toContain(ALLOW_REMOTE_VAR);
      expect(message).not.toContain('pw');
    }
  });
});
