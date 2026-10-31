# Roster runtime image for agent, review, setup and verify jobs (ADR 0016, ADR 0023, plan 002 section 9.1).
# Build from this folder:
#   docker build --build-arg ROSTER_COMMIT=<commit> -t roster/runtime-claude:<commit> container/runtime-claude
# Optional: --build-arg CLAUDE_CODE_VERSION=<version>. Upgrading the CLI goes through a PR that changes
# the default below (ADR 0016).
#
# No git, no gh, no credentials and no secrets in any layer or build argument. The token arrives at run
# time as CLAUDE_CODE_OAUTH_TOKEN, passed by name. At run time the root file system is read-only and
# /tmp is a noexec tmpfs (spike T14 finding 12): nothing here runs from /tmp.

# node:24-bookworm-slim pinned by digest (spike T14): Node v24.22.2, npm 11.19.1.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# Claude Code CLI version validated by spike T14.
ARG CLAUDE_CODE_VERSION=2.1.314

# 1. Common tools only: ripgrep and ca-certificates.
# 2. The official Claude Code CLI from npm at the pinned version (spike T14 finding 11).
# 3. Reuse the base image's uid 1000: rename user and group `node` to `agent`, home /home/agent.
# 4. Mount points; /workspace and /roster/out writable by uid 1000.
# 5. Fail the build if git or gh is present.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/* \
 && usermod -l agent -d /home/agent -m node \
 && groupmod -n agent node \
 && mkdir -p /workspace /roster/in /roster/out /etc/claude-code \
 && chown 1000:1000 /workspace /roster/out \
 && test "$(id -u agent)" = 1000 \
 && test "$(id -g agent)" = 1000 \
 && claude --version \
 && if command -v git || command -v gh; then echo "git and gh must not be in the image" >&2; exit 1; fi

# Auto-update off (ADR 0016). Non-essential traffic off, so the CLI needs only api.anthropic.com:443
# (spike T14 finding 7). The sandbox adapter passes both again with the rest of the environment.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Roster commit of the pinned install; required, so every image is traceable. Declared last so a new
# commit rebuilds only the label, not the layers above.
ARG ROSTER_COMMIT
RUN echo "${ROSTER_COMMIT}" | grep -Eqx '[0-9a-f]{7,40}' \
 || { echo "build argument ROSTER_COMMIT must be a git commit hash (7-40 lowercase hex)" >&2; exit 1; }
LABEL org.opencontainers.image.title="roster-runtime-claude" \
      org.opencontainers.image.revision="${ROSTER_COMMIT}" \
      dev.roster.commit="${ROSTER_COMMIT}" \
      dev.roster.claude-code.version="${CLAUDE_CODE_VERSION}"

USER 1000:1000
WORKDIR /workspace
