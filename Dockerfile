FROM oven/bun:latest AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Copy the committed lockfile (text `bun.lock`, or legacy binary `bun.lockb`) so the
# install is reproducible. The glob must match `bun.lock` — `bun.lockb*` did not, which
# silently forced the unpinned fallback below.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY src/ ./src/
COPY settings.js settings.staging.js settings.production.js ./

RUN groupadd --system --gid 1001 botgroup && \
    useradd --system --uid 1001 --gid botgroup --no-create-home botuser && \
    chown -R botuser:botgroup /app

USER botuser

CMD ["bun", "run", "start"]
