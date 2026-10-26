# Fat default image for Kubernetes Runtime pods. Contains NO credentials: tokens arrive at runtime
# through the paseo-agent-credentials Secret (envFrom).
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client curl ca-certificates jq ripgrep python3 python3-pip build-essential \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/gh.list \
 && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# kubectl, for agents with a ServiceAccount (the paseo-ops one reads the cluster). Verified against the published checksum.
ARG KUBECTL_VERSION=v1.33.5
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" \
 && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256")  /usr/local/bin/kubectl" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/kubectl

# The provider CLIs the runtime starts with `kubectl exec` (it installs them on first use only if they are missing).
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# The node image already has uid 1000 ("node"), which the pod runs as; HOME is set to the workspace volume by the runtime.
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
