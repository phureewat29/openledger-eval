// The one version every report document on disk claims to be. A v1 document
// may carry fields this build never heard of — an older report directory
// does — so the guard checks only the version number, and every reader takes
// the fields it knows and leaves the rest alone.

export const SCHEMA_VERSION = 1;

export function isVersionOne(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (value as { schemaVersion?: unknown }).schemaVersion === SCHEMA_VERSION;
}
