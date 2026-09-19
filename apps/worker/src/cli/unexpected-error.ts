/**
 * Describes an unexpected error for the console without its message or stack, which may embed
 * input values such as connection strings (docs/reviews/security-p1.md F-2). Structured logging
 * with field-level redaction replaces this in P3.
 */
export function describeUnexpectedError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `✗ unexpected ${error.name}${typeof code === 'string' ? ` (${code})` : ''}; details withheld because they may contain secrets`;
  }
  return '✗ unexpected non-Error value thrown; details withheld';
}
