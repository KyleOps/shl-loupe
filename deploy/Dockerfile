# syntax=docker/dockerfile:1
#
# SHLoupe: a SMART Health Link viewer, debugger and teaching tool. A static Vite
# bundle served by nginx. There is no backend, no server-side rendering and no
# outbound call from this container: the browser makes every SHL request.
#
# Build from the repo ROOT (the build context needs package.json, src/ and
# index.html), never from deploy/:
#
#   docker build -f deploy/Dockerfile -t shl-loupe .
#   docker run --rm -p 8080:8080 shl-loupe
#
# Add --platform linux/amd64 only when the machine that will RUN the image is
# amd64 and you are building on Apple Silicon: a plain build there produces
# arm64 only, which lands on the other machine as "exec format error". Building
# for the host you are on is the common case and needs no flag.
# See deploy/README.md.

# Base images are pinned to a tag AND its multi-arch index digest, so a rebuild
# six months from now produces the same layers even after the tag moves. How
# these were chosen (2026-08-20), rather than from memory:
#   curl -s 'https://hub.docker.com/v2/repositories/nginxinc/nginx-unprivileged/tags?name=alpine-slim'
#     -> stable-alpine-slim, 1.30-alpine-slim and 1.30.4-alpine-slim all resolve
#        to sha256:e88d990b..., so 1.30 is the current nginx stable line
#        (even minor = stable) and 1.31 is mainline.
#   curl -s 'https://hub.docker.com/v2/repositories/library/node/tags?name=alpine'
#     -> lts-alpine and 24-alpine both resolve to sha256:d32cdf61..., so Node 24
#        is the current LTS; 26 is current.
# Refresh both with the same two commands, not by guessing a newer number.
ARG NODE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30-alpine-slim@sha256:e88d990b349df8cf4aa82f16642d7a23375016638c9ace4e5c6ca25028e62e65

# ---------------------------------------------------------------------------
# Build stage. Nothing from here reaches the runtime image.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true
WORKDIR /src

# pnpm is installed explicitly rather than through `corepack enable`: the
# official node:24-alpine image installs npm and yarn only (there is no corepack
# line in docker-node's 24/alpine3.23 Dockerfile), so enabling it is a
# dependency on something that may not be there. The version is the one
# package.json declares in `packageManager`; keep the two in step.
RUN npm install --global pnpm@9.15.9

# Manifest-only layer, so editing a component does not reinstall the tree.
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY . .
# `pnpm build` is `tsc --noEmit && vite build`, so a type error fails the image
# build rather than shipping a bundle CI would have rejected.
RUN pnpm run build

# Pre-compress for `gzip_static on`, in plain shell rather than with another
# dependency. -k keeps the original, which is still needed for a client that
# sends no Accept-Encoding and for a Range request. Files at or under 1k are
# skipped: gzip framing costs more than it saves at that size.
# .wasm is included on purpose. nginx serves foo.wasm.gz with the Content-Type
# of foo.wasm (application/wasm, line 55 of nginx's stock mime.types) plus
# Content-Encoding: gzip, which WebAssembly.instantiateStreaming accepts; an
# octet-stream would make it reject.
RUN find dist -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
         -o -name '*.json' -o -name '*.map' -o -name '*.wasm' -o -name '*.txt' \) \
      -size +1k -exec gzip -9 -k -f {} +

# ---------------------------------------------------------------------------
# Runtime stage. nginx and static files, no Node, no pnpm, no shell tooling
# beyond what alpine-slim ships.
# ---------------------------------------------------------------------------
FROM ${NGINX_IMAGE}

# The unprivileged image has already done the work that usually forces a root
# layer here (verified against docker-nginx-unprivileged stable/alpine-slim
# Dockerfile lines 15 to 138): ARG UID=101 with `USER $UID`, the stock server
# block rewritten to `listen 8080`, the pid file moved to /tmp/nginx.pid, and
# every *_temp_path redirected under /tmp. So the image runs read-only apart from
# a writable /tmp, and no capability is added back: 8080 is unprivileged, so
# NET_BIND_SERVICE is not required.
#
# -alpine-slim rather than -alpine: same nginx build flags (gzip_static is in
# pkg-oss's BASE_CONFIGURE_ARGS) without njs, geoip, image-filter, curl or
# ca-certificates. The cost is that `docker exec ... curl` is unavailable for
# probing from inside the container, which is no loss for an image whose only
# job is to serve files to a browser on the same machine.
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist/ /usr/share/nginx/html/

# Declarative only; `docker run -p` is what actually publishes the port.
EXPOSE 8080
