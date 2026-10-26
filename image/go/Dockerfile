# The default pod image plus Go, for workspaces that build and test Go code (the `prbr-picky` profile). Contains NO credentials.
# BASE is the default image, pinned by digest in the workflow.
ARG BASE=ghcr.io/lerenn/paseo-kubernetes-runtime-default:latest
FROM golang:1.25-bookworm AS go

FROM ${BASE}
USER root
COPY --from=go /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:$PATH \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=mod
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
