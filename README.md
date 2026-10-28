# paseo-kubernetes-runtime

A Paseo plugin (`kubernetes-runtime`, shown as "Kubernetes Runtime") that runs a workspace in a Kubernetes pod:
a **workspace runtime** for Paseo. The agents in that workspace are the real Claude and Codex agents (same provider,
icon, catalog and pickers as local agents); only where their process runs changes. Pods are
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) `Sandbox` objects, so there is no
custom operator. It knows nothing about roles.

It needs a Paseo with workspace runtimes (the fork's `registerWorkspaceRuntime`). On a Paseo without them the plugin
loads, shows its screen, and says it does nothing.

## How it works

```
Paseo daemon                                   cluster (paseo-agents)
┌──────────────────────────────┐               ┌─────────────────────────────────┐
│ runtime "kubernetes"         │  kubectl apply│ Sandbox pka-<repo>-<slug>-<rand>│
│  prepare  (before a launch)  │──────────────▶│  └ pod + RWO volume             │
│  exec     (the provider cmd) │  kubectl exec │      /workspace   (HOME, CLIs)  │
│  beforeInput / onActivity    │◀─────────────▶│      <daemon path> = checkout   │
│  destroy  (workspace archived│   stdio       │      claude / codex  (real)     │
│  bridge: push, MCP tunnels   │               └─────────────────────────────────┘
└──────────────────────────────┘
```

- **One pod per workspace**, created when the first provider process is about to start (`prepare`), never when a
  workspace or a draft is merely opened. The Sandbox is labelled with the daemon id and the workspace id.
- **Same path.** Paths inside provider protocols (claude's session files, codex's thread cwd) are the daemon's, so the
  pod shows the checkout at the daemon's own absolute path: the volume is mounted at `/workspace` and its `checkout`
  subPath again at that path (a root init container makes it writable for the agent user).
- **Provider processes** run as `kubectl exec -i` with the exact command Paseo asks for. Their environment is the env
  delta Paseo passes (written to a short-lived env file in the pod, never on a command line), nothing from the daemon.
  `claude` and `codex` are installed on first use under `$HOME/.npm-global` (on the volume) if the image lacks them, and so is a
  checksum-verified `jq` (under `$HOME/bin`) for `gh --jq` and for agents; the default image already has it.
- **Seeding.** The daemon first fetches the chosen ref fresh from origin (the branch picker's branch, the base of a
  branch-off, a pull request head, or the checkout's own branch: the remote tip when the daemon's copy is behind, the
  local tip when it has unpushed commits), then bundles it from the project's own checkout (`git bundle`) and streams
  it into the pod over `pods/exec` stdin. Nothing is cloned from GitHub in the pod. The submodules recorded in the
  seeded commit are fetched through the bridge below in the background (several at a time) while the agent starts, with
  a notice when they are ready; an interrupted checkout resumes the next time the pod wakes.
- **Fetch bridge (`git fetch`, `git pull`, `git submodule update`).** The pod has no GitHub credential. Git there is
  pointed at local mirror repositories (a global `url.<mirror>.insteadOf`) for the project's origin and each
  submodule, with `remote.origin.uploadpack` set to a wrapper that, before serving a fetch, asks the plugin over the
  bridge to refresh the mirror: the daemon fetches the real remote with its own credentials and sends a thin pack of
  only what the pod lacks. Branches, tags and the default branch come across; `origin/HEAD` resolves. Only the origin
  and the submodules recorded in the project are fetchable (nothing else is reachable), and branches can be pushed to a submodule's remote the same way as to the project's
  (applied and pushed by the daemon with its credentials; no deletions, and the remote still refuses non-fast-forward
  pushes). Git in the pod uses the daemon's `user.name`/`user.email`. A submodule is checked out detached, as git does:
  `git switch -c <branch>` in it before committing (or check out the branch `.gitmodules` tracks). Seeded branches track
  their remote branch, so a plain `git pull` works, and the first push of a new branch sets its upstream. The daemon keeps this cheap with many pods: one `git ls-remote` per remote is shared for 8 s (and dropped after any push through the bridge), a mirror that already matches the remote's branches and tags is not fetched again, and at most 2 fetches (ssh upload-pack) run at once, first come first served (a wait over 2 minutes fails the pod's git command; run it again); the log line `git mirror last minute: ...` shows the counts. Limits: 64MB per fetch, no nested submodules, pull request refs (`refs/pull/*`) are not mirrored.
- **Other repositories** (a plugin change plus a lab config PR): any URL of an allowed host (default `github.com`: https,
  `git@` and `ssh://`) is turned by a global `insteadOf` rule into `paseo://host/owner/repo`, which the pod's
  `git-remote-paseo` helper serves from a bare mirror made on demand. `git clone`, `fetch`, `pull`, `ls-remote` and a branch
  `push` work for any repository the daemon's git credentials reach (it tries its ssh key, then https), through the same
  bridge and with the same protections: branches and new tags only, no deletions, and the remote still refuses non-fast-forward
  pushes. The "Other repositories" setting turns it off or restricts it to `owner/*` or `owner/repo` patterns.
- **Push-back.** `git push` goes to a local "outbox" repository whose `pre-receive` hook asks the plugin, over the
  same bridge, to push the new commits from the daemon with the daemon's git credentials (branches only, no
  deletions). The pod has no `gh`: GitHub is reached through GitHub's MCP server behind MCP Proxy (a loopback MCP
  server, tunnelled below) and the Events plugin, never with a token in the pod.
- **Loopback MCP servers** (`http://127.0.0.1:<port>`: MCP Proxy, Inbox, Leases, ...) found in the
  agent's MCP config at `prepare` are tunnelled by port, byte for byte, to the daemon's loopback over the same
  channel: URLs and headers stay unchanged, streams work, and only the named ports are reachable.
- **Credentials.** Only `CLAUDE_CODE_OAUTH_TOKEN`, from the Secret `paseo-agent-credentials`, by reference. Written from
  the screen (write-only: server-side apply on the Secret; removal is a merge patch through `kubectl proxy`).
- **Idle suspension.** When every agent of a workspace has been idle (no turn, no pending permission) for
  `podIdleMinutes` (default 30, 0 = never) the pod is deleted (`operatingMode: Suspended`); the volume, with the
  checkout and the agents' session state, stays. The next input (`beforeInput`) recreates the pod on the same volume with
  the current image, and the provider resumes its own session. A process that ends because the pod went away is
  reported as `runtime-lost`, so the agent run fails like any process exit and the next message relaunches it. Our own idle
  suspension is reported as the planned `suspended` exit, which idle agents drop quietly instead of showing an error.
- **Finished agents.** When every agent of a workspace is closed or archived (and none has a turn open), the pod is
  suspended after `finishedGraceSeconds` (default 30, 0 = off) instead of after `podIdleMinutes`, from the 10 s tick,
  with the same guards as idle suspension (no background work in the pod, `idleExemptLabels` respected). The next
  input resumes it. A workspace the Paseo agent list does not show any agent for is left to `podIdleMinutes`.
- **Full namespace quota.** When the Sandbox cannot get a pod because the namespace ResourceQuota (requests.memory) is
  full, the plugin suspends other idle workspaces at once instead of making the new one wait: workspaces with only
  finished agents first, then the longest idle (at least 60 s). It frees `requested - (limited - used)` in total (each
  victim counts as its pod's memory request) and never touches the requester, a workspace with a turn, a pending
  permission, a running agent or background work, or one matching `idleExemptLabels`; each suspend runs under the
  workspace's lock with a final busy re-check. If the idle ones are not enough nothing is suspended and the start waits
  with the "Queued: namespace quota" notice. One log line per eviction: `quota: suspended <pod> (idle Nmin) to start
  <pod>`. Turn it off live with `quota.evictIdle: false`.
- **Archive.** Archiving the workspace (`destroy`) deletes the Sandbox and its volume claim. There is no expiry on a
  workspace's storage.
- **Orphans.** A reconciler (at start, then every 10 minutes) deletes the Sandbox and claim of any workspace Paseo no
  longer has (grace 5 minutes, every deletion logged); it only ever considers resources labelled with this daemon's id.
  Old `pka-` sandboxes with no daemon label are swept after 15 minutes unless the "Remove unlabelled leftovers"
  setting is off (turn it off where several daemons share a namespace). The screen shows "Last reconcile: N orphans
  removed".

## Finding a workspace's pod

Pods are named `pka-<repo>-<slug>-<random>` and labelled for people (values are sanitised to 63 characters; the full
name is in the `paseo.sh/workspace-name` annotation). The labels are on the Sandbox, the pod and the volume claim and
follow the workspace's agent, state and name:

```bash
kubectl -n paseo-agents get pods -L paseo.sh/workspace,paseo.sh/agent,paseo.sh/state,paseo.sh/repo
```

`paseo.sh/state` is `running` or `suspended` (a suspended workspace has no pod; its volume claim shows the state).
`paseo.sh/workspace-id` and `paseo.sh/daemon` are what the orphan reconciler goes by. Updating the labels of an
existing pod and claim needs `patch` on them in the daemon's Role; without it only the Sandbox's labels stay current.

## How the plugin reads the cluster

Pod and Sandbox state is read from one shared snapshot per namespace (`kubectl get pod,sandbox -o json`, `server/kube-cache.ts`)
instead of a `kubectl get pod <name>` per workspace. Concurrent readers share the call in flight, a snapshot is reused for
5 s (`SNAPSHOT_TTL_MS`), and every write the plugin makes (apply, patch, label, annotate, delete) drops it. Waiting for a pod to
become ready reads at most 1 s old; the warm-pool claim and the orphan reaper take a snapshot of their own before they act.
Execs, volume-claim lists and writes still run `kubectl` directly. The log has one line a minute:
`kube calls last minute: N spawns (snapshots S, direct D), cache hits H, latency avg/max`.

## Warm pool (off by default)

With "Warm pool" on, the plugin keeps `size` pods (1 to 5) running ahead of any workspace, with the image, placement and a
volume of their own. A new Pod workspace is given one at once (relabelled for the workspace: Sandbox, pod template and
volume claim) instead of waiting for scheduling and the volume (about 15 s of a 33 s cold start), is seeded, and the pool
starts the next. If none is ready, the workspace gets a pod of its own as usual. A warm pod costs its CPU and memory
request (250m / 512Mi by default, usage is a few dozen MiB) and a volume (10Gi by default) while it waits; the pool
removes warm pods when it is turned off or the image changes. Warm pods show in the Pods table and can be deleted there.

The pods of a pool are not tied to a workspace, so they cannot mount the checkout at the daemon's path. With the pool on,
new workspaces use the **mapped layout**: the checkout is at `/workspace/checkout` in every pod and Paseo rewrites the
daemon's workspace path to it in what it sends the pod and back in what the pod prints (the runtime's `mapCwd`). Workspaces
created before, or with the pool off, keep the **legacy layout** (the checkout at the daemon's own path) for their whole
life; `paseo.sh/layout: mapped` on the Sandbox marks the new one.

## In the sidebar and the workspace header

The runtime's badge shows the pod's image name beside the ship wheel, with the pod name, state, full image reference and
repository on hover, and a one-line detail in the workspace header (`image · pod · running`). It is answered from what
the plugin already knows, so showing a workspace never starts or reads a pod; the state follows suspend and resume.

## Placement and the autoscaler

`nodeSelector`, `tolerationKeys` (operator Exists) and `tolerations` (key, operator, value, effect: e.g. key
`lab.anyshift.io/agents`, Equal, `true`, NoSchedule) place every pod, warm ones too. `resources` sets the container's
requests and limits (leave the CPU limit out for none). `podAnnotations` go on the pods of workspaces but not on warm
pods, for instance `{"karpenter.sh/do-not-disrupt": "true"}` so the autoscaler keeps a node while an agent works on it; a
suspended workspace has no pod, so the hint goes with it, and a claimed warm pod gets it at the claim. A resumed pod
follows today's placement and annotations. `warmPool.idleMinutes` removes the warm pods that long after the last workspace
or agent start (0 = never) and brings them back with the next one.

`podAnnotations` are static, so a `karpenter.sh/do-not-disrupt` there pins the node for as long as the pod exists, idle or not,
and the node is never consolidated. Use `turnAnnotations` for it instead (default `{"karpenter.sh/do-not-disrupt": "true"}`):
the plugin puts them on the workspace's pod when any agent's turn opens and takes them off 30 s after no turn is open
(idempotent; a replaced pod gets them again; after a plugin restart it reads Paseo's agent list before changing anything).
`podAnnotations` should no longer carry do-not-disrupt (a key set in both is left on).

Recommended default `resources`: requests `cpu: 150m`, `memory: 768Mi`; limits `memory: 3Gi`; no CPU limit:

```json
"resources": { "requests": { "cpu": "150m", "memory": "768Mi" }, "limits": { "memory": "3Gi" } }
```

A `builder` profile for heavy builds, on on-demand capacity and with more memory:

```json
"profiles": {
  "builder": {
    "nodeSelector": { "karpenter.sh/capacity-type": "on-demand" },
    "resources": { "requests": { "cpu": "150m", "memory": "768Mi" }, "limits": { "memory": "4Gi" } }
  }
}
```

A profile's `nodeSelector` is added to the global one (the profile wins on a shared key).

## Out-of-memory kills

A process that dies of an OOM kill in a healthy pod is counted per workspace and per agent (the agents with a turn open), with the
time, the container's memory limit and, when readable, its peak (`memory.peak` of the cgroup, since the container started).
Each kill logs `[kubernetes-runtime] OOM: <workspace> agent <id> limit <x>`, shows as an `OOM ×n` badge on the workspace's row of
the Pods table (and in `kube.status`), and is kept in `plugin-data/kubernetes-runtime/oom.json`. Those agents get ONE resume
prompt through the same guard as an interruption (`recovery.autoResume`): the pod ran out of memory, commit and push more often, a
bigger profile such as `builder` exists. Once a day, if there were kills, a summary is logged. The plugin has no mail or
messenger path to the Agents Mail alias `@assistant` (it can only prompt an agent by id), so that summary is not mailed.

## The Pods table

The Kubernetes Runtime screen lists the pods, one row per workspace: its title (opens the workspace), the pod name, the
agents running in it, a state badge (running, suspended, creating, error), since when, the image (short name and digest)
and the volume size. Per row: Suspend and Restart (running), Resume (suspended), and Delete, which asks first and offers to
archive the workspace too. A pod with a running agent or a background command is only touched after a second
confirmation that names what is running. Above the table, "Last reconcile" and a "Reconcile now" button.

## Settings

A sidebar item "Kubernetes Runtime" opens a screen: namespace and image; an Advanced section (kubectl context, node
selector, tolerated taint keys, workspace storage mode/size/class, idle suspension, unlabelled sweep); a Status section
(workspaces: running or suspended; last orphan cleanup); and a collapsible Credentials section with a write-only field
for `CLAUDE_CODE_OAUTH_TOKEN`. New workspace gets a **Pod** location (with the branch picker) once the token is set.

Settings and the credential flags that were kept under the plugin's old id `kube-agents` are copied over on first
start (originals backed up under `~/.paseo/backups/`, never overwritten, never deleted).

## Pod image

The default image is built from `image/Dockerfile` (node 22, git, gh, jq, ripgrep, rsync, the docker CLI and compose plugin, `docker-sync`, claude, codex) by the `image` workflow and
published to `ghcr.io/lerenn/paseo-kubernetes-runtime-default`; `DEFAULT_IMAGE` in `shared/settings.ts` pins it by digest
(the workflow prints the new digest in its summary). A custom image needs node and git; claude, codex and a verified jq are
installed on first use when missing.

## Docker sidecar (opt-in, privileged)

Besides the separate sandbox pod below, a workspace pod can run Docker itself: a **privileged `docker:dind` sidecar container** named `dockerd` in the same pod. No extra node, and the pod's own requests do not change.

**Risk, accepted by the human owner** (decision 3230bc70, "It's okay if unsafe"): a privileged container is root on the node. The lab relaxes Pod Security for the agents namespace in a separate lab change; its admission policy keys on the pod label `paseo.sh/docker-sidecar=1`, the container name `dockerd` and the image.

```json
"dockerDefault": "off",
"profiles": { "ci": { "docker": "sidecar" } },
"dockerSidecar": {
  "image": "<dind image>",
  "resources": { "requests": { "cpu": "10m", "memory": "64Mi" }, "limits": { "memory": "8Gi", "ephemeral-storage": "20Gi" } }
}
```

- **Mode.** A profile's `docker` is `true` or `"sandbox"` (the sandbox pod, unchanged), `"sidecar"`, or `false`. `dockerDefault` (`"off"` by default, `"sidecar"`, `"sandbox"`) applies when the profile does not say, and to workspaces with no profile at all. Settings are read live. `sidecar` never creates the sandbox pod, Service or NetworkPolicy.
- **Container.** `dockerd` listens on `tcp://127.0.0.1:2375` only (TLS off), so no other pod can reach it; the agent container gets `DOCKER_HOST=tcp://127.0.0.1:2375` and the label `paseo.sh/docker=1`. `/var/lib/docker` is an emptyDir. `dockerSidecar.image` defaults to `docker.image`; limits cap memory (8Gi) and ephemeral storage (20Gi) so a build cannot fill the node's disk.
- **Bind mounts work.** The sidecar mounts the same workspace volume at the same paths as the agent (`/workspace` and the checkout path), so `docker run -v <checkout>:...` and compose bind mounts see the agent's files; no `docker-sync`.
- **Existing workspaces** get the sidecar the next time they resume (the resume patch rewrites the containers), and lose it again at the next resume if the mode is switched off. A pod that is running keeps what it has until then.
- **Readiness.** The pod becomes Ready without waiting for dockerd. After the pod is ready the runtime waits up to 60 s (not fatal) for `docker info` to answer and logs `docker sidecar ready in N s`. Workspaces in `sidecar` mode do not take warm-pool pods.
- Suspend, idle and auto-archive are unchanged: the sidecar dies with the pod.

## Docker sandbox (opt-in per profile)

Agents that need `docker` (build images, run `docker compose`) get a per-workspace engine in its own pod, never inside the agent
pod. The engine is a privileged `docker:dind` pod on a dedicated, tainted, on-demand node pool (one sandbox per node; the node
comes up in about 1-2 minutes). Turn it on for a profile:

```json
"profiles": { "docker": { "docker": true, "resources": { "requests": { "cpu": "1", "memory": "4Gi" } } } },
"docker": {
  "namespace": "paseo-docker", "image": "<sandbox image>", "idleMinutes": 15, "maxHours": 8,
  "nodeSelector": { "paseo.sh/pool": "docker" },
  "tolerations": [ { "key": "paseo.sh/docker", "operator": "Exists", "effect": "NoSchedule" } ],
  "resources": { "requests": { "cpu": "3", "memory": "26Gi" }, "limits": { "memory": "28Gi" } }
}
```

For a workspace whose profile has `docker: true` (also through `projectProfiles`) the runtime creates, in `docker.namespace` and named
`docker-<sandbox>` (`<sandbox>` is the agent pod's Sandbox name):

- a **Pod**: privileged, `docker.image`, an emptyDir for `/var/lib/docker`, `DOCKER_TLS_CERTDIR=""` (dockerd on tcp 2375), no ServiceAccount token, anti-affinity so each node holds one sandbox, labels `paseo.sh/docker-sandbox=<sandbox>` and `paseo.sh/workspace=<workspace id>`;
- a **Service** on 2375 (engine) and 873 (rsync);
- a **NetworkPolicy**: ingress to that pod only from pods of the agents' namespace labelled `paseo.sh/sandbox=<sandbox>`, on 2375/873.

The **agent pod** gets `DOCKER_HOST=tcp://docker-<sandbox>.<docker.namespace>.svc.cluster.local:2375` and the labels `paseo.sh/docker=1` and
`paseo.sh/sandbox=<sandbox>` (environment and labels are set whenever the profile has `docker: true`, at creation and on every resume;
a pod that already runs when the profile gains `docker` gets them at its next resume). The cluster must let the daemon's kubectl manage
pods, Services and NetworkPolicies in the docker namespace and `exec` into its pods, and must have the egress rule for `paseo.sh/docker=1`.

Lifecycle:

- **Start** (phase 1): when the workspace pod starts or resumes, and when a new agent process launches after the sandbox idled out. The runtime does not wait for the engine (the node takes a minute or two); a `docker` command in that window fails to connect, so retry it. A lazy start on the first `docker` command through a `docker` shim is phase 2 and not built.
- **Delete the pod** (the Service and NetworkPolicy stay): on workspace suspend; after `idleMinutes` with no running container (`docker ps -q` inside the sandbox, checked every 30 s; an engine that cannot answer counts as busy); and `maxHours` after it started, whatever it runs. `0` turns the idle or age limit off.
- **Delete everything**: when the workspace is archived or its pod deleted from the Pods table, and by the orphan reaper (and `reconcile`) for sandboxes whose workspace pod is gone.
- The Pods table shows `Docker starting|running|stopped|error`. Sandbox out-of-memory kills are counted separately (role `docker`, in the log and next to the state) from the agent pod's.

**Bind mounts.** A compose bind mount (`./src:/app`) or `docker run -v` is resolved on the engine's filesystem, which is not the agent's. The
agent image has `docker-sync <dir>`, which rsyncs the directory to `rsync://docker-<sandbox>:873/work/<same absolute path>` (the sandbox's rsync
daemon exports `/work`, mapped to `/` of the engine), so the same path then exists there. **Compose projects must be synced first**: run
`docker-sync .` before `docker compose up`, and again after editing files (`--keep` does not remove files that only exist in the sandbox). Named volumes and images need no sync.

## Node reclaims (Spot)

A pod taken away under a running agent (a Spot interruption, a node loss, an eviction) is told apart from an idle suspend and
from a process that failed on its own: when a process ends and the plugin did not end it, the pod is looked at (gone,
replaced, being deleted, `DisruptionTarget`, not ready: interrupted; healthy: the process failed, an OOM kill is named).
Settings `recovery`:

- `interruptedExit` (off): report the stop as the exit reason `interrupted` instead of `runtime-lost`. Turn it on once the Paseo in use
  has that reason (a turn open at the cut then ends as interrupted, with no error and no red dot); until then Paseo fails the turn as before.
- `autoResume` (on): each agent that had a turn open gets ONE prompt, "Your previous turn was interrupted by a node reclaim at HH:MMZ. Resume
  from your saved state", sent with `activeTurnBehavior: "skip"` (a turn already running is never steered); Paseo brings the pod back first.
  At least 10 minutes between two resumes of an agent, three an hour, and a stop (with a warning notice) after two interruptions that
  came within 2 minutes of a resume; a turn that completes well after clears that. State in `plugin-data/kubernetes-runtime/interruptions.json`.
- `checkpointNudge` (on): every 10 s, pods of agents mid-turn are looked at; when one starts to be taken away (Karpenter drains a Spot
  node on the 2-minute notice, so the pod is deleted or disrupted before its processes end), the agents get one steered message to
  commit and push. A hard loss gives no warning.

## Pod profiles (another image, a bigger volume, seeded data)

A workspace that needs more than the default pod picks a named profile from the `profiles` setting, with the runtime option `profile`.
A profile can change the image, the resources, the size and class of the volume (for a new volume: an existing claim keeps its size),
and list daemon directories to copy into the volume once:

```json
"profiles": {
  "prbr-picky": {
    "image": "ghcr.io/lerenn/paseo-kubernetes-runtime-go@sha256:<digest>",
    "storage": { "size": "10Gi" },
    "resources": { "requests": { "cpu": "1", "memory": "4Gi" } },
    "seed": [ { "from": "/home/paseo/prbr-picky", "to": "prbr-picky",
      "exclude": ["*.log", "*.done", "./wt-r3?", "./backup-2620", "./runs/*/src", "./runs/*/tmp"],
      "prune": [ { "dir": "runs", "keep": ["v0.1.33", "c2-v0.1.33", "g57", "c2-g57"] } ] } ]
  }
}
```

- `exclude` is `tar --exclude` patterns; `prune` keeps only the named entries of a directory (tar has no negation). A name that is not in `profiles` refuses the workspace with the list of known ones. A workspace with a profile never takes a warm pod.
- `seed` streams `tar` from the daemon into the pod's volume (`/workspace/<to>`), so the data goes from where it is to the volume and nowhere
  else (no bucket, no token). A marker on the volume (`/workspace/.seeded/`) stops a second copy; delete the marker to copy again.
  A failed copy is a warning and is tried again at the next start. `to` cannot be `checkout` or `.home`.
- `image/go/Dockerfile` is the default image plus Go 1.25, published by the `image` workflow as `ghcr.io/lerenn/paseo-kubernetes-runtime-go`.
- Making such a workspace: create a Pod workspace on the project that holds the code (for prbr-picky, a dedicated clone of anyshift-io/pr-blast-reviewer; set `PRBR_SUBMODULE` to its path in the pod, not the daemon's shared monorepo submodule) with the
  runtime options `{ "cwd": "<the daemon's checkout>", "profile": "prbr-picky" }`; the data appears next to the checkout at `/workspace/prbr-picky`.

### Profile by project (`projectProfiles`)

`projectProfiles` maps a project directory to a profile name, so every workspace of that project gets the profile without picking it:

```json
"projectProfiles": {
  "/home/paseo/src/github.com/anyshift-io/anyshift-monorepo": "builder",
  "/home/paseo/src/github.com/lerenn/paseo": "builder"
}
```

- It applies only to a workspace with no `profile` in its runtime options; an explicit `profile` always wins.
- A key is an exact path or a directory prefix (everything below it matches; the longest key wins).
- A Paseo worktree (`/home/paseo/.paseo/worktrees/<id>/<slug>`) is matched by its repository: the runtime asks git for the main checkout behind the worktree (`git rev-parse --git-common-dir`) and matches that. Limit: this needs the worktree to exist on the daemon and be a git worktree of the project; if git cannot say, the workspace gets no profile.
- A name that `profiles` does not define is ignored with a log line (the workspace runs without a profile), unlike an explicit unknown `profile`, which refuses the workspace.
- The profile is read when a pod is created: a running pod keeps its image. Workspaces with a profile never take a warm pod.

### Extra Secrets for a profile (a `codex` profile)

`extraSecrets` lists Secret keys that become environment variables on the pods of that profile only (by reference: the daemon never
reads the value; the Secret must be in the pods' namespace). Each entry is `{ "secret", "key", "env"?, "optional"? }`: `env` defaults
to `key`, `optional` to `true` (a missing Secret or key leaves the variable unset instead of blocking the pod). The list is part of
the spec hash, so a resumed pod picks up a change. Other profiles and the default pods are unchanged.

```json
"profiles": {
  "codex": { "extraSecrets": [ { "secret": "paseo-codex-credentials", "key": "OPENAI_API_KEY" } ] }
}
```

Pods of the `codex` profile then see `OPENAI_API_KEY` next to the Claude token, so the `codex` provider (`@openai/codex` is in the
image) can start in them. Make the workspace with the runtime option `{ "profile": "codex" }`. The Secret is created and filled
outside the plugin (for example `kubectl apply --server-side --field-manager=secret-entry` with a manifest read from stdin).

## Auto-archive (dry run by default)

A workspace nobody has used for `idleDays` (default 2) is archived, after a warning, and the reaper then removes its pod and volume. The setting is `autoArchive` in the plugin settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the whole thing off. |
| `dryRun` | `true` | Warn and log what would be archived, archive nothing. Turn it off after the first week, once the log looks right. |
| `idleDays` | `2` | Days since the last activity. `0` = never. Must be longer than `podIdleMinutes`. |
| `warnHours` | `12` | The warning (a notice in the workspace, "archives in Xh unless activity" in its tooltip) comes this long before the archive. Any input clears it. |
| `exemptLabels` | `["paseo.keep=1"]` | A workspace with an agent carrying one of these labels is never archived. |
| `maxPerRun` | `3` | At most this many per run (every minute). |
| `ephemeral` | `{ label: "paseo.ephemeral=1", idleHours: 6 }` | Throwaway workspaces are archived after `idleHours`. |
| `maxAgeDays` | unset | A ceiling on a workspace's age, whatever its activity. It still skips workspaces that are dirty or unpushed. |
| `podQuota` | unset | The namespace's pod limit. A suspended workspace without a stored check is resumed briefly to take one only while fewer than `podQuota - 2` pods run. |

The idle clock is the last activity (input, a turn, an agent at work), kept on the Sandbox (`paseo.sh/last-activity`, written at most every 10 minutes and at suspend) so a plugin restart does not reset it.

**Nothing is archived unless every check passes.** A workspace that fails one is never archived and is listed in the Auto-archive section of the Kubernetes Runtime screen with the reason and how long it has been idle:

- an in-pod git probe, after a `git fetch --prune`: no uncommitted or untracked files, no stash, no local branch or HEAD commit that is on no remote, no rebase or merge in progress, nothing in `outbox.git` or the mirrors that is not on a remote, and the same for every initialised submodule. A probe that cannot run counts as a finding. (A local branch whose upstream is gone, because its PR was squash-merged and the branch deleted, counts as pushed when merging it into the remote default branch changes nothing, i.e. its work is already there. A conflict, a diverged branch or a git without `merge-tree --write-tree` keeps it blocked: delete the local branch, or press Keep.)
- no `profile.seed` data (a profile with seeds, or a `/workspace/.seeded` marker on the volume);
- no open turn, no pending permission, no background work in the pod, and Paseo able to say so (an unreadable answer counts as busy);
- the probe is light on the pod: it runs at the lowest CPU and disk priority (`renice 19`, `ionice -c3` when present), takes no git optional locks, checks the top level with the untracked cache on and `--ignore-submodules=all` (each submodule is checked on its own), and skips `git fetch` when `FETCH_HEAD` is younger than 10 minutes (so "on a remote" can be up to 10 minutes old; the final check before an archive is the same). A running pod is only probed once the workspace is idle for `idleDays` (or the throwaway limit) minus `warnHours`, or older than `maxAgeDays`, and its result is reused for 2 hours; the probe at suspend is unchanged.
- a suspended workspace is judged by the probe run as it was suspended (stored on the Sandbox, cleared by a resume). One suspended before this existed is resumed briefly to take it, one at a time;
- a final re-check under the workspace's queue right before the archive.

The archive is `paseo workspace archive <id>`, with `--reason "auto-archived: idle Nd" --if-idle` when the `paseo` CLI supports them (the fork's change; detected from `--help`), so the daemon itself refuses if an agent has an open turn by then. Each decision is logged and the last 100 are kept in `plugin-data/kubernetes-runtime/auto-archive.json`. To keep a workspace, press Keep (Pods table or the Auto-archive section; it is a `paseo.sh/keep` annotation) or give its agent the label `paseo.keep=1`.

## Cluster requirements

See [docs/rbac-and-network.md](docs/rbac-and-network.md): Role for the daemon ServiceAccount, the credentials Secret,
storage and the default-deny NetworkPolicy.

## What Paseo does with the pod

- **Files panel** (Paseo with runtime files, fork #28): served from the pod through `fs` (stat, list, read, write,
  create, rename, copy, delete), confined to the workspace directory; a symlink that leaves it is refused. Only while
  the pod runs: a suspended or not-yet-started pod answers `EAGAIN`, and polling never wakes it or keeps it awake.
- **Git panel** (`exec` with purpose `command`): Git for a runtime workspace runs in the pod. A refresh in the
  background (`interactive: false`) is refused when the pod is not running; one the user waits for starts the pod.
- **Reconcile and checks**: Paseo lists the live workspaces on every registration (daemon start, plugin reload) and after
  a lost pod; a Sandbox for any other workspace (older than 5 minutes) is deleted with its volume. Before a session
  Paseo asks whether the provider binary exists (`claude` and `codex` are installed on first use, so they do) and
  warns about stdio MCP servers whose binary is missing from the image.
- **Workspaces created by agents** inherit the caller's runtime (fork #22): the runtime is told the new workspace's
  directory, which replaces the caller's directory in the copied options, and seeds from that directory's HEAD.

## Limits

- Model and version discovery runs on the daemon, so claude and codex must exist there too.
- A provider that starts its processes inside the plugin process (opencode, pi, omp, plugin providers) is refused in a
  runtime workspace.
- Uncommitted local changes are not copied (the seed is a commit).
- Files of a suspended pod are not available until it wakes.

## Updating the plugin

An update stops the plugin process, and the provider processes it started in the pods die with it. `stop()` ends them
itself and reports each as the planned `suspended` exit, so idle agents drop them quietly; a turn running at that moment
still fails. To keep that to idle moments use `scripts/update-when-idle.sh <plugin-id>[=<revision>] ...`: it waits until no
agent is running in a workspace that has a runtime (a first launch has no Sandbox yet, so it asks Paseo, not the
cluster), then runs `paseo plugin update` for each plugin, reloading and retrying once if the first update fails.

## Development

```bash
npm ci
npm run typecheck && npm test
dagger call all        # same as CI: typecheck, test, build in a container (with git, the tests run real git)
```

`server/runtime-types.ts` mirrors the fork's runtime contract until the published plugin SDK carries it.
