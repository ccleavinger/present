# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Frontend build and static web server
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2 AS web-build
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM nginx:stable-alpine AS web
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/web/dist /usr/share/nginx/html

# ---------------------------------------------------------------------------
# API build and runtime
# ---------------------------------------------------------------------------
FROM rust:1.99-bookworm AS api-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked -p present-server

FROM debian:bookworm-slim AS api
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 present \
    && useradd --system --uid 10001 --gid present --home-dir /app --shell /usr/sbin/nologin present

WORKDIR /app
COPY --from=api-build /app/target/release/present-server /usr/local/bin/present-server

RUN mkdir -p /data \
    && chown -R present:present /app /data

USER present

ENV PRESENT_ADDR=0.0.0.0:3000 \
    PRESENT_DATA_DIR=/data \
    PRESENT_SEED=1 \
    RUST_LOG=present_server=info,present_http_api=info,present_store=info

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["present-server"]
