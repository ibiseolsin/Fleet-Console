FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates gosu tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY --chown=node:node . .
RUN chown node:node /app /app/web
USER node
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run check
# Vendored tests contain Windows-specific path expectations; run them on Windows.
# The cross-platform application checks above exercise real dispatch and landing here.
RUN npm run web:build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates gosu tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/sp-sync ./sp-sync
COPY --from=build --chown=node:node /app/data ./data
COPY --from=build --chown=node:node /app/web ./web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=10000 \
    FLEET_STATE_ROOT=/var/data/fleet
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "sh", "/app/scripts/container-entrypoint.sh"]
