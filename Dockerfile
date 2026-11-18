# Stellwerk in a container.
#
# The image holds Stellwerk and Node. Hermes and Pi stay installed in your home
# folder on the host: compose.yaml runs the container as your user, with your
# home mounted at the same path and host networking, so Stellwerk finds the
# agents and the Hermes gateway exactly where a normal install would.
# See the "Docker" section of README.md before you use it.
# Pi runs on Node 22.19 or newer, which Debian doesn't package yet, so the
# image takes Node (and npm) from the official Node image.
FROM node:22-bookworm-slim AS node

FROM python:3.13-slim

# Tools that Stellwerk itself needs (git for the Changes drawer) plus a few
# that Pi's bash tool commonly reaches for. Pi runs *inside* this container,
# so anything you want it to be able to run must be installed here. Add more
# at build time, e.g.:
#   docker compose build --build-arg EXTRA_PACKAGES="build-essential make"
ARG EXTRA_PACKAGES=""
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git less libstdc++6 openssh-client procps ripgrep \
      ${EXTRA_PACKAGES} \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    STELLWERK_HOST=127.0.0.1 \
    STELLWERK_PORT=7777

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# World-readable, owned by root: the container runs as whatever uid you give
# it, and that user never needs to write here.
COPY server/ ./server/
COPY web/ ./web/

EXPOSE 7777

# /api/me answers 200 whether or not you're signed in. Probe the first address
# in STELLWERK_HOST (a wildcard address means loopback works too).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import os, urllib.request; h = os.environ.get('STELLWERK_HOST', '127.0.0.1').split(',')[0].strip(); h = '127.0.0.1' if h in ('', '0.0.0.0', '::') else h; h = '[' + h + ']' if ':' in h else h; urllib.request.urlopen('http://%s:%s/api/me' % (h, os.environ.get('STELLWERK_PORT', '7777')), timeout=4)" || exit 1

CMD ["python", "-m", "server.app"]
