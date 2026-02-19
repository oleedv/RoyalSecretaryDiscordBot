FROM oven/bun:latest AS base
WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY src/ ./src/
COPY settings.js ./

CMD ["bun", "run", "start"]
