# Agent runner image. Build context is the repo root (the runner reads the
# program IDL from app/lib/idl.json); the root .dockerignore keeps keys/ and
# state/ out of it. Keys come from Fly secrets, state lives on a volume.
FROM node:24-slim
WORKDIR /repo/agent
COPY agent/package.json agent/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY agent/tsconfig.json ./
COPY agent/src ./src
COPY app/lib/idl.json /repo/app/lib/idl.json
ENV NODE_ENV=production STATE_DIR=/data
CMD ["node_modules/.bin/tsx", "src/runner.ts"]
