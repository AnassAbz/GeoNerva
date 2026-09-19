import { describe, expect, it } from 'vitest';

import {
  DatabaseUrlError,
  assertConnectionUrlPolicy,
  databaseNameOf,
  describeConnectionTarget,
  hostOf,
  isLoopbackHost,
  sslConfigFor,
  sslModeOf,
} from './connection-url.ts';

/** A realistic-looking but fake production URL. */
const REMOTE = 'postgresql://app:s3cr3t-pw@db.abcdefgh.supabase.co:5432/postgres';
const LOCAL = 'postgresql://geonerva:geonerva@127.0.0.1:54320/geonerva';

describe('F-7: production database URLs must require TLS', () => {
  it('refuses a production URL with no sslmode', () => {
    expect(() => {
      assertConnectionUrlPolicy(REMOTE, { nodeEnv: 'production' });
    }).toThrow(DatabaseUrlError);
  });

  it.each(['disable', 'allow', 'prefer'])('refuses sslmode=%s in production', (mode) => {
    expect(() => {
      assertConnectionUrlPolicy(`${REMOTE}?sslmode=${mode}`, { nodeEnv: 'production' });
    }).toThrow(DatabaseUrlError);
  });

  it.each(['require', 'verify-ca', 'verify-full'])('accepts sslmode=%s in production', (mode) => {
    expect(() => {
      assertConnectionUrlPolicy(`${REMOTE}?sslmode=${mode}`, { nodeEnv: 'production' });
    }).not.toThrow();
  });

  it('allows a loopback host without TLS, even in production', () => {
    expect(() => {
      assertConnectionUrlPolicy(LOCAL, { nodeEnv: 'production' });
    }).not.toThrow();
  });

  it('does not require TLS outside production', () => {
    expect(() => {
      assertConnectionUrlPolicy(REMOTE, { nodeEnv: 'development' });
    }).not.toThrow();
    expect(() => {
      assertConnectionUrlPolicy(REMOTE, {});
    }).not.toThrow();
  });

  it('refuses an sslmode value it does not recognize, in any environment', () => {
    expect(() => {
      assertConnectionUrlPolicy(`${REMOTE}?sslmode=maybe`);
    }).toThrow(DatabaseUrlError);
  });

  it('refuses a non-postgres scheme and a URL with no host', () => {
    expect(() => {
      assertConnectionUrlPolicy('https://example.org/db');
    }).toThrow(DatabaseUrlError);
    expect(() => {
      assertConnectionUrlPolicy('not a url');
    }).toThrow(DatabaseUrlError);
  });

  it('never echoes the connection string or its password in the error', () => {
    try {
      assertConnectionUrlPolicy(REMOTE, { nodeEnv: 'production', variableName: 'DATABASE_URL' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('s3cr3t-pw');
      expect(message).not.toContain('app:');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('sslmode=verify-full');
    }
  });
});

describe('driver TLS configuration', () => {
  it('always verifies the certificate, even for sslmode=require', () => {
    // libpq's `require` means "encrypt, do not verify". GeoNerva verifies regardless, so the
    // weakest accepted setting still authenticates the server.
    expect(sslConfigFor(`${REMOTE}?sslmode=require`, { nodeEnv: 'production' })).toStrictEqual({
      rejectUnauthorized: true,
    });
  });

  it('passes a pinned certificate authority through', () => {
    expect(
      sslConfigFor(`${REMOTE}?sslmode=verify-full`, {
        nodeEnv: 'production',
        caCertificate: '-----BEGIN CERTIFICATE-----',
      }),
    ).toStrictEqual({ rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----' });
  });

  it('disables TLS for a plain local connection', () => {
    expect(sslConfigFor(LOCAL)).toBe(false);
  });

  it('refuses on its own when asked for a production config with no TLS', () => {
    expect(() => sslConfigFor(REMOTE, { nodeEnv: 'production' })).toThrow(DatabaseUrlError);
  });
});

describe('safe descriptions', () => {
  it('describes a target without credentials', () => {
    expect(describeConnectionTarget(REMOTE)).toBe('db.abcdefgh.supabase.co:5432/postgres');
    expect(describeConnectionTarget(REMOTE)).not.toContain('s3cr3t');
  });

  it('defaults the port', () => {
    expect(describeConnectionTarget('postgresql://user@example.org/mydb')).toBe(
      'example.org:5432/mydb',
    );
  });

  it('extracts host and database', () => {
    expect(hostOf(LOCAL)).toBe('127.0.0.1');
    expect(databaseNameOf(LOCAL)).toBe('geonerva');
    expect(sslModeOf(`${REMOTE}?sslmode=VERIFY-FULL`)).toBe('verify-full');
    expect(sslModeOf(REMOTE)).toBeNull();
  });

  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['LOCALHOST', true],
    ['db.example.org', false],
    ['127.0.0.2', false],
  ])('isLoopbackHost(%s) → %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
