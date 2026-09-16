# Container image for the network-served Forgejo MCP server (issue #8).
#
# Runs `vbcdx-forgejo serve` — MCP over Streamable HTTP, credentials supplied per
# request in the Authorization header. No credentials are ever baked into the
# image, ENV, or any layer; the service settings arrive from the environment and
# credentials arrive per request.
#
# Base pinned by explicit version AND digest (Node 22 LTS on Alpine). Runs as the
# built-in unprivileged `node` user (uid 1000).

FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# Tini is not required: Node handles SIGTERM directly and serve shuts down clean.
WORKDIR /app

# Install production dependencies only (the pinned @modelcontextprotocol/sdk).
# Copy lockfiles first so this layer caches independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source. Tests, examples and Docker/CI scaffolding are excluded via
# .dockerignore so they never enter a layer.
COPY bin ./bin
COPY src ./src

# Network defaults. The listen port is overridable; credentials and the Forgejo
# URL are deliberately NOT set here — they are runtime concerns.
ENV VBCDX_FORGEJO_HTTP_PORT=8080 \
    VBCDX_FORGEJO_HTTP_HOST=0.0.0.0 \
    VBCDX_FORGEJO_WRITES=off \
    NODE_ENV=production
EXPOSE 8080

# Drop privileges: the official node image ships a `node` user (uid 1000).
USER node

# Liveness: the CLI's healthcheck probes the local /healthz endpoint (https-aware
# when TLS is configured). Start period covers listener bring-up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "bin/vbcdx-forgejo.js", "healthcheck"]

ENTRYPOINT ["node", "bin/vbcdx-forgejo.js"]
CMD ["serve"]
