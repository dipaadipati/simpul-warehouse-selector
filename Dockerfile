# Node 24 runs the TypeScript directly through native type stripping, so there is
# no build step and no compiled output to copy.
FROM node:24-alpine

WORKDIR /app

# No runtime dependencies, so there is nothing to install. package.json is copied
# because Node reads "type": "module" from it, and that is what makes the .ts
# files load as ES modules instead of being rejected.
COPY package.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# The image ships with an unprivileged "node" user; use it.
USER node

EXPOSE 3000

# The healthcheck lives in docker-compose.yml rather than here, so that a plain
# `docker run` does not grow a wget dependency it does not need.
CMD ["node", "src/http/server.ts"]
