# Cluster requirements (lab: `anyshift-personal-lab`, namespace `paseo-agents`)

What the Kubernetes Runtime plugin needs from the cluster. Nothing here is created by the plugin.

## 1. agent-sandbox controller

Install kubernetes-sigs/agent-sandbox, controller named `paseo-agents-controller` (core `agents.x-k8s.io` CRDs; the PoC uses only `Sandbox`).
The default `sandboxApiVersion` is `agents.x-k8s.io/v1beta1`; confirm with
`kubectl get crd sandboxes.agents.x-k8s.io -o jsonpath='{.spec.versions[*].name}'`.

## 2. Namespace

`paseo-agents`, on the Karpenter burst pool. Pods get the pool through the node selector and
tolerated taint keys in the Kubernetes Runtime settings (the lab agent should tell us the labels/taints).
Suggested labels: `pod-security.kubernetes.io/enforce: baseline` (the agent runs non-root with no SA token; only a short-lived init container runs as root, to make the volume's checkout writable for uid 1000, which baseline allows).

## 3. RBAC for the daemon ServiceAccount (Role + RoleBinding in `paseo-agents`)

```yaml
rules:
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["get", "list", "watch", "create", "patch", "delete"]   # kubectl apply/wait/delete
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "patch"]                        # patch: keeps the pod's name/agent/state labels current (optional)
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]                                               # seed + provider stdio
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "delete", "patch"]                       # workspace volume: status, cleanup on archive, labels (patch optional)
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]                                                  # debugging only
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["paseo-agent-credentials"]
    verbs: ["patch", "update"]                                      # write-only credentials from the plugin UI
```

The daemon never gets `get`/`list`/`watch`/`create` on secrets, so it cannot read credentials back; the pod
reads the Secret through a `secretKeyRef` via the kubelet. The plugin sets a key with a server-side apply sent on stdin
(`kubectl apply --server-side --field-manager=paseo-kube-agents-<key> --force-conflicts -f -` with a Secret manifest carrying
only that key). It must not use `kubectl patch`, which GETs the object first and would be refused without `get`.
Server-side apply needs only `patch`; the lab creates the Secret placeholder, so `create` is not needed. One field manager
per key keeps writes to different keys independent.
Because values can't be read, the UI's "set / not set" comes from plugin-local state, not the cluster. No ClusterRole needed. Only the core `Sandbox` resource is used; the extension CRDs are not.

## 3b. Workspace storage

By default each workspace pod gets a plain ReadWriteOnce PersistentVolumeClaim (10Gi, the cluster's default
StorageClass unless one is set) through the Sandbox's `volumeClaimTemplates`; nothing is cloud-specific. The
Sandbox controller creates it as `workspace-<sandbox>` and owns it, so deleting the Sandbox (archive) deletes the claim and, with a `Delete` reclaim policy, its volume. The plugin also deletes the
claim explicitly (best effort). If the replacement pod after a node loss cannot be scheduled (for example the
volume is bound to a zone with no capacity), the session shows the scheduler's message. `ephemeral` mode
uses an `emptyDir` and needs none of this.

## 4. Credentials Secret

`paseo-agent-credentials` in the namespace, created as an empty placeholder by the lab (not in git, not in images); values are written from the plugin UI. Keys become
env vars in every workspace pod:

| key | use |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | claude (from `claude setup-token`); the only key pods read, by reference |

The Secret is `optional` in the pod spec so the pod still starts without it.

## 5. NetworkPolicy (default-deny, then allow)

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: agent-pods, namespace: paseo-agents}
spec:
  podSelector: {matchLabels: {app.kubernetes.io/managed-by: paseo-kube-agents}}
  policyTypes: [Ingress, Egress]
  ingress: []        # exec goes API server -> kubelet, not over the pod network
  egress:
    - to: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}}]
      ports: [{port: 53, protocol: UDP}, {port: 53, protocol: TCP}]
    - to: [{ipBlock: {cidr: 0.0.0.0/0, except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254/32]}}]
      ports: [{port: 443, protocol: TCP}]   # github.com, api.anthropic.com, api.openai.com, npm, Go proxy
```

Pods need no GitHub egress: seeding and pushing go through the daemon over `pods/exec`, so GitHub (and the MCP
servers on the daemon) are never reached from the pod network. 443 egress is still needed for the Claude API and for
npm (`claude` and `codex` are installed there on first use if the image lacks them). Adjust the `except` list to the cluster's pod/service/VPC CIDRs. SSH (22) is not needed: clones use https.
