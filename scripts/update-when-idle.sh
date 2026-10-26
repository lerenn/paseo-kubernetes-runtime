#!/bin/bash
# Updates plugins on a Paseo daemon only when no agent is running in a runtime (pod) workspace, so a Kubernetes Runtime
# update does not cut a turn in half. Usage: scripts/update-when-idle.sh <plugin-id>[=<expected revision prefix>] ...
# Environment: PASEO_HOME (default ~/.paseo), MAX_WAIT_MINUTES (default 240).
set -u
log() { echo "$(date -u +%T) $*"; }
HOME_DIR="${PASEO_HOME:-$HOME/.paseo}"
CLIENT=/usr/local/lib/node_modules/@getpaseo/cli/dist/utils/client.js

# Agents that are running in a workspace that has a runtime (whether or not its pod exists yet: a first launch has no
# Sandbox to look for), or in a directory a Sandbox serves. Prints the count; prints -1 when it cannot tell.
busy_count() {
  node --input-type=module -e '
    import { connectToDaemon } from "'"$CLIENT"'";
    try {
      const c = await connectToDaemon({ target: { kind: "instance", home: process.argv[1] } });
      const ws = await c.fetchWorkspaces({});
      const runtimeWs = new Set((ws.entries ?? ws.workspaces ?? ws).filter((w) => w.runtimeId).map((w) => w.id));
      const ag = await c.fetchAgents({});
      const running = (ag.entries ?? ag.agents ?? ag).map((e) => e.agent ?? e).filter((a) => (a.status ?? a.lifecycle) === "running");
      console.log(running.filter((a) => runtimeWs.has(a.workspaceId)).length);
      await c.close();
    } catch { console.log(-1); }
  ' "$HOME_DIR" 2>/dev/null | tail -1
}

deadline=$(( $(date +%s) + ${MAX_WAIT_MINUTES:-240} * 60 ))
while :; do
  n=$(busy_count)
  [ "$n" = "0" ] && break
  [ "$(date +%s)" -gt "$deadline" ] && { log "gave up: $n agent(s) still running in runtime workspaces"; exit 2; }
  sleep 15
done
log "idle window"
status=0
for spec in "$@"; do
  id="${spec%%=*}"; want=""; [[ "$spec" == *=* ]] && want="${spec#*=}"
  for t in 1 2 3; do
    out=$(paseo plugin update "$id" --ref main --yes 2>&1 | tail -1); log "$id: $out"
    echo "$out" | grep -qE "updated|current" && break
    paseo plugin reload "$id" >/dev/null 2>&1; sleep 4   # the first update can fail while the old runtime is unregistering
  done
  sleep 6
  row=$(paseo plugin ls | awk -v id="$id" '$1==id {print $2, $5}')
  log "$id now: $row"
  case "$row" in running*) ;; *) log "$id is NOT running"; status=1;; esac
  [ -n "$want" ] && [[ "$row" != *" $want"* ]] && log "WARNING $id revision differs from $want"
done
exit $status
