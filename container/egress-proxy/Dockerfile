# Roster egress proxy image (ADR 0023, plan 002 sections 9.1 and 9.6).
# Build from this folder:
#   docker build --build-arg ROSTER_COMMIT=<commit> -t roster/egress-proxy:<commit> container/egress-proxy
# Run (the sandbox adapter does this per execution): the arguments are the allowed hosts, port 443 only.
#   docker run --rm roster/egress-proxy:<commit> api.anthropic.com

# Same base as the runtime image, pinned by digest (spike T14). Node v24.22.2 runs the .ts files
# through type stripping; nothing is installed.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# Files owned by root and read-only for the proxy user.
COPY package.json decision.ts proxy.ts /opt/roster/egress-proxy/

# Roster commit of the pinned install; required, so every image is traceable.
ARG ROSTER_COMMIT
RUN echo "${ROSTER_COMMIT}" | grep -Eqx '[0-9a-f]{7,40}' \
 || { echo "build argument ROSTER_COMMIT must be a git commit hash (7-40 lowercase hex)" >&2; exit 1; }
LABEL org.opencontainers.image.title="roster-egress-proxy" \
      org.opencontainers.image.revision="${ROSTER_COMMIT}" \
      dev.roster.commit="${ROSTER_COMMIT}"

# Non-root: uid 1000 (user `node` of the base image).
USER 1000:1000
EXPOSE 3128
ENTRYPOINT ["node", "/opt/roster/egress-proxy/proxy.ts"]
