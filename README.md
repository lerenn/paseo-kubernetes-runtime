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
  their remote branch, so a plain `git pull` works, and the first push of a new branch sets its upstream. Limits: 64MB per fetch, no nested submodules, pull request refs (`refs/pull/*`) are not mirrored.
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

(If the installed version has no `nodeSelector` in profiles, set it on the pod through the global setting for a dedicated plugin
instance; profiles take `image`, `storage`, `resources` and `seed` as shown below.)

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

The default image is built from `image/Dockerfile` (node 22, git, gh, jq, ripgrep, claude, codex) by the `image` workflow and
published to `ghcr.io/lerenn/paseo-kubernetes-runtime-default`; `DEFAULT_IMAGE` in `shared/settings.ts` pins it by digest
(the workflow prints the new digest in its summary). A custom image needs node and git; claude, codex and a verified jq are
installed on first use when missing.

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
