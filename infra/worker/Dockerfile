# The GeoNerva worker container (IMPLEMENTATION_PLAN.md §3, P10 task 1).
#
# ### Why this image ships a workspace rather than a flattened tree
#
# ADR-026 runs the worker directly on Node 24 with native type stripping: there is no build step,
# and the image ships TypeScript sources. That decision reaches further than it looks. Node
# **refuses to strip types for any file under `node_modules`**
# (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and it decides that by the *real* path, after
# resolving symlinks. In a pnpm workspace `@geonerva/config` is a symlink into `packages/config`,
# so the real path is outside `node_modules` and stripping is allowed.
#
# `pnpm deploy` — the obvious way to produce a self-contained directory — copies those packages
# *into* `node_modules` instead, at which point their real path is inside it and the worker cannot
# start. That was measured here rather than reasoned about: the flattened image built cleanly and
# then failed on its first import.
#
# So the image keeps the workspace: a filtered production install, and the repository layout
# copied across with its symlinks intact.
#
# Hardening (docs/SECURITY.md, §3a F-12): non-root, expects a **read-only root filesystem**, no
# package manager or build toolchain in the final layer, `NODE_ENV=production` set explicitly.

# ── build ────────────────────────────────────────────────────────────────────────────────────
# Pinned by digest, not by tag: a tag is a moving target and this is a supply-chain boundary.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

# Corepack pins pnpm from `packageManager` in package.json, so the image cannot drift from the
# version the lockfile was written by.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# The lockfile and every workspace manifest first, so that a source-only change does not
# re-resolve dependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/baselines/package.json packages/baselines/
COPY packages/changes/package.json packages/changes/
COPY packages/config/package.json packages/config/
COPY packages/correlation/package.json packages/correlation/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/geo/package.json packages/geo/
COPY packages/geocoding/package.json packages/geocoding/
COPY packages/http/package.json packages/http/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/relevance/package.json packages/relevance/
COPY packages/sources/package.json packages/sources/
COPY packages/test-fixtures/package.json packages/test-fixtures/

# `extra_ca` is an optional BuildKit secret for a machine whose outbound HTTPS is intercepted by a
# local TLS-inspecting proxy or antivirus — common on a developer laptop, absent in CI. It is
# handed to Node as `NODE_EXTRA_CA_CERTS` for the **install only** (Node carries its own CA bundle
# and ignores the system one): a secret mount never becomes a layer, and the runtime stage below
# is built from the stock image with the stock trust store. Build without it and nothing changes.
#
#   docker build --secret id=extra_ca,src=<the CA in PEM> -f infra/worker/Dockerfile .
#
# The alternative — `pnpm config set strict-ssl false` — would turn one machine's trust problem
# into a supply-chain hole committed to the repository, and is not offered.
#
# `--filter=@geonerva/worker...` installs the worker and what it depends on; `--prod` leaves the
# dev toolchain out. Between them, `next`, `vitest` and `playwright` never enter the image.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    sh -c 'if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; pnpm install --frozen-lockfile --ignore-scripts --prod --filter=@geonerva/worker...'

COPY apps/worker apps/worker
COPY packages packages

# ── runtime ──────────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

# Explicit, not inherited: §3a's F-12 asks deployment manifests to set it and the worker to log it.
ENV NODE_ENV=production
ENV TZ=UTC

# Which build this is. Empty here on purpose — a base image cannot know — and set by the
# deployment, which is what lets a soak attribute a failure to a build.
ENV GEONERVA_BUILD=""

# `node` (uid 1000) ships with the image. A new user would be the same privilege with a different
# number, and this one already owns nothing.
WORKDIR /app
COPY --from=build --chown=node:node /repo /app

USER node

# The worker writes nothing to disk — configuration comes from the environment, data goes to
# PostgreSQL, and logs are one JSON object per line on stdout — so the root filesystem can be
# mounted read-only. A Dockerfile cannot require that; the compose unit sets `read_only: true`
# and `docs/DEPLOYMENT.md` says why.
#
# No HEALTHCHECK: the worker is not a server, and "the process is alive" is not the question worth
# asking about it. Liveness is the heartbeat in the run ledger, which the smoke check reads
# (docs/TESTING.md §10, check 7).

ENTRYPOINT ["node", "apps/worker/src/main.ts"]
CMD ["start"]
