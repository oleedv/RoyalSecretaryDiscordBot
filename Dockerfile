FROM oven/bun:latest AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY src/ ./src/
COPY settings.js settings.staging.js settings.production.js ./

CMD ["bun", "run", "start"]
