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
  seeded commit are checked out too, through the fetch bridge below.
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
  bridge and with the same protections: branches only, no deletions, and the remote still refuses non-fast-forward
  pushes. The "Other repositories" setting turns it off or restricts it to `owner/*` or `owner/repo` patterns.
- **Push-back.** `git push` goes to a local "outbox" repository whose `pre-receive` hook asks the plugin, over the
  same bridge, to push the new commits from the daemon with the daemon's git credentials (branches only, no
  deletions). `gh` and GitHub tools go through the GitHub Proxy plugin if it is installed and the agent is opted in
  (`PASEO_GITHUB_PROXY=on`, or its scope set to all).
- **Loopback MCP servers** (`http://127.0.0.1:<port>`: GitHub Proxy, MCP Proxy, Inbox, Leases, ...) found in the
  agent's MCP config at `prepare` are tunnelled by port, byte for byte, to the daemon's loopback over the same
  channel: URLs and headers stay unchanged, streams work, and only the named ports are reachable.
- **Credentials.** Only `CLAUDE_CODE_OAUTH_TOKEN`, from the Secret `paseo-agent-credentials`, by reference. Written from
  the screen (write-only: server-side apply on the Secret; removal is a merge patch through `kubectl proxy`).
- **Idle suspension.** When every agent of a workspace has been idle (no turn, no pending permission) for
  `podIdleMinutes` (default 30, 0 = never) the pod is deleted (`operatingMode: Suspended`); the volume, with the
  checkout and the agents' session state, stays. The next input (`beforeInput`) recreates the pod on the same volume with
  the current image, and the provider resumes its own session. A process that ends because the pod went away is
  reported as `runtime-lost`, so the agent run fails like any process exit and the next message relaunches it.
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

## Development

```bash
npm ci
npm run typecheck && npm test
dagger call all        # same as CI: typecheck, test, build in a container (with git, the tests run real git)
```

`server/runtime-types.ts` mirrors the fork's runtime contract until the published plugin SDK carries it.
