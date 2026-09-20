/**
 * Connection-string policy — security finding **F-7**
 * (docs/reviews/security-p1.md, docs/IMPLEMENTATION_PLAN.md §3a).
 *
 * The worker connects to a managed database across the public Internet. A URL without TLS
 * parameters leaves TLS entirely to driver defaults, which means credentials and hazard data can
 * travel in cleartext, or over a connection whose certificate nobody checked.
 *
 * The rule this module enforces:
 *
 *  - In **production**, a database URL whose host is not loopback must carry
 *    `sslmode=require`, `verify-ca` or `verify-full`. `disable`, `allow`, `prefer` and a missing
 *    `sslmode` are refused, and the process fails to start.
 *  - Whatever `sslmode` says, GeoNerva always configures the driver with
 *    `rejectUnauthorized: true`. `sslmode=require` in libpq means "encrypt but do not verify",
 *    which is not a security property worth having; GeoNerva verifies regardless, so the weakest
 *    accepted setting still authenticates the server.
 *  - Errors never echo the URL. They name the variable, the host and the rule, because a
 *    connection string is a credential and would otherwise end up in logs and crash reports.
 */

/** Hosts that are on the machine itself, where TLS is not required. */
// `0.0.0.0` is deliberately absent: it means "all interfaces", not "this machine", and a URL
// pointing at it is not evidence that the target is local (S-18).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** `sslmode` values that actually encrypt the connection. */
const TLS_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/** `sslmode` values that do not guarantee encryption. */
const INSECURE_SSL_MODES = new Set(['disable', 'allow', 'prefer']);

/** Raised when a connection string violates the policy. Never contains the URL. */
export class DatabaseUrlError extends Error {
  readonly variableName: string;

  constructor(variableName: string, reason: string) {
    super(`${variableName}: ${reason}`);
    this.name = 'DatabaseUrlError';
    this.variableName = variableName;
  }
}

/** True when the host refers to this machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Parses a Postgres URL, or throws a `DatabaseUrlError` that does not echo it. */
function parse(url: string, variableName: string): URL {
  if (!URL.canParse(url)) {
    throw new DatabaseUrlError(variableName, 'is not a valid URL');
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new DatabaseUrlError(variableName, 'must use the postgres:// or postgresql:// scheme');
  }
  if (parsed.hostname === '') {
    throw new DatabaseUrlError(variableName, 'must contain a host');
  }
  return parsed;
}

/** The `sslmode` query parameter, lowercased, or `null` when absent. */
export function sslModeOf(url: string, variableName = 'DATABASE_URL'): string | null {
  const parsed = parse(url, variableName);
  // Query-parameter names are case-sensitive in the URL API but not in libpq (R-8).
  for (const [name, value] of parsed.searchParams) {
    if (name.toLowerCase() === 'sslmode') return value.trim().toLowerCase();
  }
  return null;
}

/**
 * A description safe to log or print: `host:port/database`. Never the user, the password or the
 * query string.
 */
export function describeConnectionTarget(url: string, variableName = 'DATABASE_URL'): string {
  const parsed = parse(url, variableName);
  const port = parsed.port === '' ? '5432' : parsed.port;
  const database = parsed.pathname.replace(/^\//, '');
  return `${parsed.hostname}:${port}/${database}`;
}

/** The database name from a connection string, percent-decoded. */
export function databaseNameOf(url: string, variableName = 'DATABASE_URL'): string {
  // The path is percent-encoded in a URL, so a database named `my test` arrives as `my%20test`
  // and a guard that compares names would not recognise it (V-2).
  return decodeURIComponent(parse(url, variableName).pathname.replace(/^\//, ''));
}

/** The host from a connection string. */
export function hostOf(url: string, variableName = 'DATABASE_URL'): string {
  return parse(url, variableName).hostname;
}

export interface ConnectionPolicyOptions {
  /** `production` turns the TLS requirement on. Anything else is treated as non-production. */
  readonly nodeEnv?: string | undefined;
  /** The environment variable this URL came from, used in error messages. */
  readonly variableName?: string;
}

/**
 * Validates a connection string against the TLS policy (F-7). Throws `DatabaseUrlError` when it
 * is refused; returns nothing when it is acceptable.
 */
export function assertConnectionUrlPolicy(
  url: string,
  options: ConnectionPolicyOptions = {},
): void {
  const variableName = options.variableName ?? 'DATABASE_URL';
  const parsed = parse(url, variableName);
  const isProduction = options.nodeEnv === 'production';
  const mode = sslModeOf(url, variableName);

  if (mode !== null && !TLS_SSL_MODES.has(mode) && !INSECURE_SSL_MODES.has(mode)) {
    throw new DatabaseUrlError(variableName, `has an unknown sslmode ("${mode}")`);
  }

  // node-postgres lets the connection string decide TLS, and these parameters make it decide
  // *weakly*: `uselibpqcompat=true&sslmode=require` yields `rejectUnauthorized: false` today, and
  // from pg v9 plain `sslmode=require` will too. GeoNerva strips TLS parameters before handing the
  // URL to the driver (see `driverConnectionString`), so carrying them is always a mistake worth
  // naming rather than silently ignoring (S-2).
  for (const name of parsed.searchParams.keys()) {
    const lower = name.toLowerCase();
    // `sslmode` is the one TLS parameter the policy *reads*; everything else that could steer the
    // driver's TLS is refused rather than silently stripped, so a deployment cannot believe it
    // pinned a certificate in the URL (S-2, R-5, R-8).
    if (lower !== 'sslmode' && isTlsParameter(lower)) {
      throw new DatabaseUrlError(
        variableName,
        `must not set "${name}": GeoNerva configures TLS on the driver, not in the URL`,
      );
    }
  }

  if (!isProduction) return;
  if (isLoopbackHost(parsed.hostname)) return;

  if (mode === null) {
    throw new DatabaseUrlError(
      variableName,
      `must require TLS in production: add sslmode=verify-full (host ${parsed.hostname})`,
    );
  }
  if (INSECURE_SSL_MODES.has(mode)) {
    throw new DatabaseUrlError(
      variableName,
      `must not use sslmode=${mode} in production; use verify-full (host ${parsed.hostname})`,
    );
  }
}

/** The TLS configuration handed to node-postgres. */
export type DriverSslConfig = false | { readonly rejectUnauthorized: true; readonly ca?: string };

/**
 * Resolves the driver's `ssl` option.
 *
 * Returning an explicit object matters: node-postgres maps `sslmode=require` from the connection
 * string to `rejectUnauthorized: false`, i.e. encryption without authentication. GeoNerva always
 * verifies the server certificate, so an attacker on the path cannot present their own.
 */
export function sslConfigFor(
  url: string,
  options: ConnectionPolicyOptions & { readonly caCertificate?: string | undefined } = {},
): DriverSslConfig {
  const variableName = options.variableName ?? 'DATABASE_URL';
  const mode = sslModeOf(url, variableName);
  const host = hostOf(url, variableName);

  if (mode !== null && TLS_SSL_MODES.has(mode)) {
    return options.caCertificate === undefined
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: true, ca: options.caCertificate };
  }
  if (mode === null && !isLoopbackHost(host) && options.nodeEnv === 'production') {
    // Unreachable once `assertConnectionUrlPolicy` has run, but a second refusal costs nothing
    // and keeps this function safe to call on its own.
    throw new DatabaseUrlError(variableName, 'must require TLS in production');
  }
  return false;
}

/** Query parameters that decide TLS. GeoNerva owns this decision, so they never reach the driver. */
/**
 * Parameters that influence TLS. Matched case-insensitively, and `ssl*` is a prefix rule rather
 * than a list: libpq keeps adding parameters (`sslnegotiation` was missed by an explicit list,
 * R-5), and a parameter GeoNerva has never heard of must not get to configure the socket.
 */
function isTlsParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('ssl') || lower === 'uselibpqcompat' || lower === 'requiressl';
}

/**
 * The connection string to hand to node-postgres, with every TLS parameter removed (S-2).
 *
 * node-postgres merges the parsed connection string **over** the explicit config object, so a URL
 * carrying `sslmode` silently discards the `ssl` object — including a pinned CA — and substitutes
 * the driver's own interpretation. Removing the parameters makes `sslConfigFor` authoritative.
 * The policy in `assertConnectionUrlPolicy` still reads the original URL, so `sslmode` is
 * required in production; it just does not get to configure the socket.
 */
export function driverConnectionString(url: string, variableName = 'DATABASE_URL'): string {
  const parsed = parse(url, variableName);
  for (const name of [...parsed.searchParams.keys()]) {
    if (isTlsParameter(name)) parsed.searchParams.delete(name);
  }
  return parsed.toString();
}
