# Override NODE_IMAGE with a reviewed, platform-appropriate digest for releases.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN node scripts/vendor.mjs && npm run check && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    FUORI_STUDIO_DATA_DIR=/data \
    FUORI_STUDIO_BIND=0.0.0.0 \
    PORT=4386
WORKDIR /app
COPY --from=build --chown=root:root /app/package.json /app/package-lock.json ./
COPY --from=build --chown=root:root /app/server.mjs ./
COPY --from=build --chown=root:root /app/lib ./lib
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/scripts ./scripts
COPY --from=build --chown=root:root /app/docs ./docs
COPY --from=build --chown=root:root /app/node_modules ./node_modules
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node:node
EXPOSE 4386
HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=3 \
    CMD ["node", "scripts/healthcheck.mjs"]
STOPSIGNAL SIGTERM
CMD ["node", "scripts/start.mjs"]
