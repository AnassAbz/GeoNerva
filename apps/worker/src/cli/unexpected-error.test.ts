import { describe, expect, it } from 'vitest';

import { describeUnexpectedError } from './unexpected-error.ts';

describe('describeUnexpectedError', () => {
  it('reports the error type and code but never the message', () => {
    const error = Object.assign(new TypeError('Invalid URL: postgresql://u:hunter2@x'), {
      code: 'ERR_INVALID_URL',
    });
    const text = describeUnexpectedError(error);
    expect(text).toContain('TypeError');
    expect(text).toContain('ERR_INVALID_URL');
    expect(text).not.toContain('hunter2');
  });

  it('handles non-Error throws', () => {
    expect(describeUnexpectedError('postgresql://u:hunter2@x')).not.toContain('hunter2');
  });
});
