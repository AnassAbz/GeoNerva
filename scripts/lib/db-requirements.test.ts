import { describe, expect, it } from 'vitest';

import { LOCAL_COMPOSE_URL, resolveDatabaseUrl } from './db-requirements.ts';

describe('resolveDatabaseUrl', () => {
  it('prefers the worker URL, then the web URL, then the local compose database', () => {
    expect(
      resolveDatabaseUrl({ DATABASE_URL_WORKER: 'postgres://w', DATABASE_URL: 'postgres://d' }),
    ).toBe('postgres://w');
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://d' })).toBe('postgres://d');
    expect(resolveDatabaseUrl({})).toBe(LOCAL_COMPOSE_URL);
  });
});
