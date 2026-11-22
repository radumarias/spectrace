# syntax=docker/dockerfile:1
# Claude Code, run headless (`claude -p`) as a Cloudflare Container that the
# Worker reaches through `ClaudeCodeRunner` (worker/src/claude-code-container.ts).
# It signs in with the owner's own Claude subscription through
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), or with ANTHROPIC_API_KEY.
# The CLI is installed exactly as Anthropic publishes it on npm and is never
# patched (Anthropic's terms require the unmodified binary). `server.mjs` is a
# small HTTP front door: one POST /run is one `claude -p` in a fresh folder.
# `wrangler deploy` builds it; `just dev` and the tests never do.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.330

# git: Claude Code works in repositories; ca-certificates: HTTPS to Anthropic.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

RUN useradd --create-home --uid 10001 agent && mkdir /work && chown agent:agent /work
COPY server.mjs /opt/spectrace/server.mjs
USER agent
WORKDIR /work

# No auto-update inside an image (the version is pinned above), no telemetry
# or error reporting from a server, and no onboarding prompts.
ENV DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    PORT=8080
EXPOSE 8080
CMD ["node", "/opt/spectrace/server.mjs"]
