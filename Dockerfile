FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ARG APP_BUILD=local
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP_BUILD=$APP_BUILD PORT=4317 HOSTNAME=0.0.0.0
LABEL org.opencontainers.image.source="https://github.com/jimgreco/package_tracker"
LABEL org.opencontainers.image.revision=$APP_BUILD
RUN groupadd --system doorstep && useradd --system --gid doorstep --home-dir /app doorstep
COPY --from=build --chown=doorstep:doorstep /app/.next/standalone ./
COPY --from=build --chown=doorstep:doorstep /app/.next/static ./.next/static
COPY --from=production-dependencies --chown=doorstep:doorstep /app/node_modules ./node_modules
COPY --chown=doorstep:doorstep lib ./lib
COPY --chown=doorstep:doorstep db ./db
COPY --chown=doorstep:doorstep scripts/migrate.ts scripts/worker.ts scripts/worker-health.ts ./scripts/
COPY --chown=doorstep:doorstep tsconfig.json ./
RUN mkdir -p /app/.local/uploads && chown -R doorstep:doorstep /app/.local
USER doorstep
EXPOSE 4317
CMD ["node", "server.js"]
