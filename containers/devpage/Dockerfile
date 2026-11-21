# syntax=docker/dockerfile:1
# devpage server from Radu's fork (github.com/radumarias/devpage), as a
# Cloudflare Container that the Worker reaches through `DevpageServer`
# (worker/src/devpage-container.ts). It is the fork's own deploy/server image,
# built from the fork at DEVPAGE_REV: devpage under Litestream, every version
# and the SQLite store in the bucket named by DEVPAGE_BUCKET_URL (an R2 bucket
# through its S3 API). The container's disk is only a cache, so a restart
# loses nothing. `wrangler deploy` builds it; `just dev` never does.
ARG DEVPAGE_REV=022b88c87e3308ec18c25879f892d5eacb926d6f

FROM rust:1.98.1-slim-bookworm AS fork
ARG DEVPAGE_REV
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src \
 && git remote add origin https://github.com/radumarias/devpage.git \
 && git fetch --depth 1 origin "$DEVPAGE_REV" && git checkout FETCH_HEAD

FROM fork AS build
WORKDIR /src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/target \
    CARGO_TARGET_DIR=/target cargo install --path /src --locked

FROM litestream/litestream:0.5.2 AS litestream

FROM debian:bookworm-slim
# ca-certificates: the bucket is reached over HTTPS. The libraries are
# chrome-headless-shell's, which devpage uses to print a PDF download.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/cargo/bin/devpage /usr/local/bin/devpage
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=fork /src/deploy/server/litestream.yml /etc/litestream.yml
COPY --from=fork /src/deploy/server/devpage-server.sh /usr/local/bin/devpage-server
RUN chmod +x /usr/local/bin/devpage-server \
 && useradd --create-home --uid 10001 devpage \
 && mkdir /data && chown devpage:devpage /data
USER devpage
# The container is the sandbox, so Chrome runs without one of its own.
ENV DEVPAGE_CHROME_SANDBOX=off
RUN printf '# Ready\n' > /tmp/ready.md && devpage pdf /tmp/ready.md -o /tmp/ready.pdf && rm /tmp/ready.*
ENV DEVPAGE_HOST=0.0.0.0 \
    DEVPAGE_DATA_DIR=/data
EXPOSE 3030
CMD ["devpage-server"]
