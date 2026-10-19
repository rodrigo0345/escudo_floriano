# syntax=docker/dockerfile:1

# ---- build: typecheck + bundle ---------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# dependencies first (cached until package files change)
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# `npm run build` regenerates nothing: schema.ts is committed. The spec is copied so
# `npm run generate:api-types` can be run in this stage when needed (`../api-spec/openapi.json`).
COPY api-spec /api-spec
COPY frontend/ ./
RUN npm run build

# ---- serve: static files + reverse proxy to the backend --------------------------------------
FROM nginx:1.27-alpine AS serve
ENV BACKEND_URL=http://backend:8080
COPY frontend/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD wget -qO- http://localhost/ >/dev/null || exit 1
