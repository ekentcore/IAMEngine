# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app


FROM base AS dependencies

WORKDIR /app/web

COPY web/package.json web/package-lock.json ./

RUN npm ci


FROM base AS builder

COPY --from=dependencies /app/web/node_modules /app/web/node_modules
COPY . .

WORKDIR /app/web

# Temporary build-only value so Prisma can validate the schema.
# Azure supplies the real DATABASE_URL when the container runs.
ARG DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
ENV DATABASE_URL=${DATABASE_URL}

RUN npx prisma generate
RUN npm run build


FROM base AS runtime

# pg_dump/pg_restore for the in-app nightly backup + restore drill. The server is
# PostgreSQL 17 (Azure Flexible Server) and pg_dump refuses a server newer than
# itself, so the PGDG repo's client-17 is required — bookworm ships 15.
# azure-cli because the off-box backup copy (lib/jobs/backup-blob.ts) shells out to
# `az storage blob upload/download` with the container app's managed identity — the
# design (D2) chose the CLI over the @azure/* SDKs, so the CLI must be in the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
       | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ bookworm main" \
       > /etc/apt/sources.list.d/azure-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-17 azure-cli \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
# Point the backup's binary probe straight at the versioned bin dir (lib/jobs/db-backup.ts findPgBin).
ENV PG_BIN_DIR=/usr/lib/postgresql/17/bin

WORKDIR /app

COPY --from=builder --chown=node:node /app /app

USER node

WORKDIR /app/web

EXPOSE 3000

CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]