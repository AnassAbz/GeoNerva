import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from '@geonerva/config';

import { describeWorkerConfig } from './check-config.ts';

describe('describeWorkerConfig', () => {
  it('never reveals credentials, keys or full connection strings', () => {
    const config = loadWorkerConfig({
      DATABASE_URL_WORKER: 'postgresql://worker:s3cr3t-pass@db.example.internal:5432/geonerva',
      FIRMS_MAP_KEY: 'firms-map-key-value',
      AI_MODE: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-should-not-appear',
      WORKER_TRIGGER_SECRET: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // gitleaks:allow
    });
    const text = describeWorkerConfig(config).join('\n');

    expect(text).toContain('db.example.internal');
    expect(text).not.toContain('s3cr3t-pass');
    expect(text).not.toContain('worker:');
    expect(text).not.toContain('firms-map-key-value');
    expect(text).not.toContain('sk-ant-should-not-appear');
    expect(text).not.toContain('9f86d081884c7d65');
    expect(text).toContain('AI_MODE             anthropic (claude-opus-5');
  });

  it('describes keyless FIRMS mode and disabled AI by default', () => {
    const text = describeWorkerConfig(
      loadWorkerConfig({ DATABASE_URL_WORKER: 'postgres://w:p@localhost/geonerva' }),
    ).join('\n');
    expect(text).toContain('absent (keyless FIRMS mode)');
    expect(text).toContain('AI_MODE             disabled');
    expect(text).toContain('WORKER_TRIGGER      disabled');
  });
});
