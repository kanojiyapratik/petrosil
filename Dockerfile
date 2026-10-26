# The container Railway runs. Two stages: the build needs every dev
# dependency, the server needs the standalone bundle and the migrator.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0

# The standalone server traces only what the app imports, which is not the
# migrator, so the two packages it needs are installed beside it.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY drizzle ./drizzle
COPY scripts/migrate.mjs ./scripts/migrate.mjs
RUN npm install --no-save --omit=dev drizzle-orm@0.36.4 postgres@3.4.5

# Schema first, so a deploy whose migration fails never starts serving.
# Railway sets PORT; server.js reads it.
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
