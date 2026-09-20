/**
 * The log redaction allowlist.
 *
 * The thing being protected against is specific: a provider URL can carry an API key (FIRMS puts
 * one in the path), and a provider body can carry anything at all. A log line that quietly passes
 * one of those through is a credential in a log aggregator, and nothing downstream would notice.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_DETAIL_LENGTH,
  createJsonLogger,
  createMemoryLogger,
  redact,
  sanitizeDetail,
} from './logging.ts';

describe('redact', () => {
  it('keeps the fields a run is described by', () => {
    expect(
      redact({ sourceId: 'usgs', runId: 'r1', status: 'SUCCEEDED', accepted: 230, fetchMs: 12 }),
    ).toStrictEqual({
      sourceId: 'usgs',
      runId: 'r1',
      status: 'SUCCEEDED',
      accepted: 230,
      fetchMs: 12,
    });
  });

  it('drops anything not on the allowlist', () => {
    // Allowlist, not blocklist: a field nobody thought about must be dropped by default, because
    // the alternative fails the first time a provider invents one.
    const smuggled = {
      sourceId: 'usgs',
      url: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/SECRETKEY123/world/1',
      apiKey: 'SECRETKEY123',
      body: '{"features": []}',
      headers: { authorization: 'Bearer token' },
    } as unknown as Parameters<typeof redact>[0];

    const line = JSON.stringify(redact(smuggled));
    expect(line).toContain('usgs');
    expect(line).not.toContain('SECRETKEY123');
    expect(line).not.toContain('Bearer');
    expect(line).not.toContain('features');
  });

  it('omits fields that were not set rather than logging null', () => {
    expect(Object.keys(redact({ sourceId: 'usgs' }))).toStrictEqual(['sourceId']);
  });
});

describe('sanitizeDetail', () => {
  it('collapses a stack trace onto one line', () => {
    // A multi-line detail would break the one-event-per-line format and blow the 1 KB column.
    expect(sanitizeDetail('failed\n  at foo\n  at bar')).toBe('failed at foo at bar');
  });

  it('bounds the length to what the run column accepts', () => {
    const long = sanitizeDetail('x'.repeat(5_000));
    expect(long.length).toBe(MAX_DETAIL_LENGTH);
    expect(long.endsWith('…'), 'truncation is visible, not silent').toBe(true);
  });

  it('bounds a detail passed through the log fields too', () => {
    const fields = redact({ detail: 'y'.repeat(5_000) });
    expect(String(fields['detail'])).toHaveLength(MAX_DETAIL_LENGTH);
  });
});

describe('the loggers', () => {
  it('writes one JSON object per line', () => {
    const lines: string[] = [];
    const logger = createJsonLogger(
      (line) => lines.push(line),
      () => new Date('2026-09-19T12:00:00.000Z'),
    );
    logger.log('info', 'ingestion.run', { sourceId: 'usgs', status: 'SUCCEEDED' });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toStrictEqual({
      ts: '2026-09-19T12:00:00.000Z',
      level: 'info',
      event: 'ingestion.run',
      sourceId: 'usgs',
      status: 'SUCCEEDED',
    });
    expect(lines[0], 'a log line must not contain a newline').not.toContain('\n');
  });

  it('records through the same redaction as it prints', () => {
    const logger = createMemoryLogger();
    logger.log('warn', 'e', { sourceId: 'usgs', secret: 'x' } as unknown as Parameters<
      typeof redact
    >[0]);
    expect(logger.entries[0]?.fields).toStrictEqual({ sourceId: 'usgs' });
  });
});
