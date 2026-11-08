// Upstream now supplies the same isolated boolean selector. Keep one atom for
// readiness so background shell updates cannot re-render the chat through it.
export { useEnvironmentShellHasSnapshot as useEnvironmentShellBootstrapped } from "./shell";
