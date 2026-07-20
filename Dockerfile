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

RUN npx prisma generate
RUN npm run build


FROM base AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=builder --chown=node:node /app /app

USER node

WORKDIR /app/web

EXPOSE 3000

CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
