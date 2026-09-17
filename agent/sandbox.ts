import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

/**
 * Sandbox for the ARC Eve parent agent.
 *
 * The parent orchestrates work and delegates heavy lifting to workers via
 * `arc_delegate`. Workers run as separate host processes spawned outside
 * this sandbox (eve's instructions are explicit: workloads run against the
 * supplied real host checkout, not the agent sandbox), so the parent only
 * needs read / write / list over the project tree plus a simulated bash for
 * ad-hoc checks. The pure-JS `just-bash` interpreter satisfies that without
 * a daemon, a VM, or platform-specific kernel support, and eve
 * auto-installs the `just-bash` package during `eve dev`.
 *
 * Why not the default cascade? `defaultBackend()` probes platform support
 * for the heavier `microsandbox` tier (which requires the `microsandbox`
 * npm package that the cascade cannot auto-install on a pnpm workspace
 * root) and selects it before reaching `justbash`. Pinning here removes
 * that surprise and keeps `pnpm dev` working on a plain developer box
 * without operator intervention.
 *
 * Why not Docker? Docker requires a running daemon and the operator user
 * to belong to the `docker` group. That is a reasonable production choice
 * for worker isolation but is friction we do not need at the parent layer
 * for this spike. Switch to the Docker backend (or back to the eve default
 * backend cascade) once Docker is reliably available on the host.
 */
export default defineSandbox({
  backend: justbash(),
});
