/**
 * Which errors an operator gets to read, and which stay withheld.
 *
 * The risk being managed runs both ways. Withhold too much and a deployment restarts forever with
 * "details withheld" and no way forward — which is what happened the first time this container met
 * a production database URL without `sslmode`. Withhold too little and a connection string reaches
 * the logs, which is what F-2 was raised about.
 */

import { ConfigError } from '@geonerva/config';
import { DatabaseUrlError } from '@geonerva/db';
import { describe, expect, it } from 'vitest';

import { describeStartupError } from './startup-error.ts';

const SECRET_URL = 'postgresql://geonerva:hunter2@db.example.com:5432/geonerva';

describe('describeStartupError', () => {
  it('shows a refused database URL, which names the variable and the rule', () => {
    const error = new DatabaseUrlError(
      'DATABASE_URL_WORKER',
      'must require TLS in production: add sslmode=verify-full (host db.example.com)',
    );
    const message = describeStartupError(error);
    expect(message).toContain('DATABASE_URL_WORKER');
    expect(message).toContain('sslmode=verify-full');
    expect(message).not.toContain('hunter2');
  });

  it('shows an invalid environment, which lists variables and never values', () => {
    const message = describeStartupError(
      new ConfigError('worker', ['DATABASE_URL_WORKER: is required']),
    );
    expect(message).toContain('DATABASE_URL_WORKER: is required');
  });

  /*
   * The whitelist is by class, not by inspecting the text. An error that merely *looks* harmless
   * is still an error nobody promised anything about.
   */
  it('withholds anything else, however innocuous it looks', () => {
    expect(describeStartupError(new Error(`connect ECONNREFUSED ${SECRET_URL}`))).toBeNull();
    expect(describeStartupError(new TypeError('Invalid URL'))).toBeNull();
    expect(describeStartupError(SECRET_URL)).toBeNull();
    expect(describeStartupError(undefined)).toBeNull();
  });
});
