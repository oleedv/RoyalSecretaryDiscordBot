FROM oven/bun:latest AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY src/ ./src/
COPY settings.js settings.staging.js settings.production.js ./

RUN addgroup --system --gid 1001 botgroup && \
    adduser --system --uid 1001 --ingroup botgroup botuser && \
    chown -R botuser:botgroup /app

USER botuser

CMD ["bun", "run", "start"]
