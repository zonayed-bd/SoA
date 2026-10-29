# syntax=docker/dockerfile:1
# Multi-stage build. Dependencies are installed in a throwaway stage; the runtime
# image receives only production node_modules and the source code.
ARG NODE_IMAGE=node:24.22.2-alpine3.24

# ---- Stage 1: install production dependencies (cached until the lock file changes)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- Stage 2: minimal runtime
FROM ${NODE_IMAGE} AS runtime
# Package managers are not needed at run time; removing them shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Code stays owned by root (read-only to the app); the process runs as the
# unprivileged 'node' user (uid 1000) shipped with the official image.
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live > /dev/null || exit 1
CMD ["node", "src/index.js"]
