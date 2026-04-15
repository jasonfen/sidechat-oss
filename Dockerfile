# syntax=docker/dockerfile:1.7

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json ./
# No bun.lockb is committed (see .gitignore), so plain install is correct.
RUN bun install --production --no-progress

FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# Operator tooling for Portainer's "Exec into container" console plus the
# requested network utilities. bash gives Portainer a predictable shell;
# bind-tools provides dig/nslookup; iputils provides a ping binary that works
# for non-root users once we set the net_raw capability on it.
RUN apk add --no-cache bash curl bind-tools iputils libcap \
 && setcap cap_net_raw+ep /bin/ping \
 && mkdir -p /var/sidechat/archives /var/sidechat/files \
 && chown -R bun:bun /var/sidechat

COPY --chown=bun:bun --from=deps /app/node_modules ./node_modules
COPY --chown=bun:bun package.json server.ts ./
COPY --chown=bun:bun static ./static
COPY --chown=bun:bun install ./install
COPY --chown=bun:bun docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

# Build-time SHA stamp (set via --build-arg BUILD_SHA=<short-sha>).
# Server reads /app/version.txt at startup and exposes it via /version
# and /install/version so clients can detect they're behind.
ARG BUILD_SHA=unknown
RUN echo "${BUILD_SHA}" > /app/version.txt

USER bun

ENV PORT=3000 \
    DB_PATH=/var/sidechat/sidechat.db \
    ARCHIVE_DIR=/var/sidechat/archives \
    FILES_DIR=/var/sidechat/files \
    ADMIN_USER=admin

EXPOSE 3000
VOLUME ["/var/sidechat"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "server.ts"]
