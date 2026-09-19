# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability** (private vulnerability reporting). Include:

- what is affected (component, endpoint, commit or deployment URL);
- steps to reproduce or a proof of concept;
- the impact you believe it has.

You should receive an acknowledgement within 7 days. We will keep you informed while a fix is
prepared and credit you in the release notes unless you prefer otherwise.

## Scope

In scope: this repository's code, its CI configuration and the official public deployment.

Particularly relevant for GeoNerva:

- anything that can make the application present **false or stale hazard information as
  current**, hide a data-source outage, or leak data from the future into historical replay;
- exposure of credentials or of users' precise locations;
- injection through provider data (XSS, prompt injection) or through API parameters.

Out of scope: vulnerabilities in third-party data providers themselves (report those to the
provider), and denial-of-service through sheer request volume.

## Supported versions

Until v1.0 is released, only the `main` branch is supported.

The threat model is documented in [docs/SECURITY.md](docs/SECURITY.md).
