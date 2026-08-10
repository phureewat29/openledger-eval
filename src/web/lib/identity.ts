import type { ConfigEcho } from "../../report/benchmark.js";
import type { RunIdentity } from "../../report/record.js";

// What one invocation was measured against, turned into words once — so the
// live panel and the report's identity table cannot each describe the same run
// a different way. `oled` keeps its own case throughout because it is the
// CLI's name rather than a description of one, the way `npm` is.

export interface IdentityRow {
  label: string;
  value: string;
}

export function identityRows(identity: RunIdentity, config: ConfigEcho): IdentityRow[] {
  return [
    { label: "Started", value: identity.startedAt },
    { label: "oled", value: identity.oledVersion },
    { label: "SKILL.md", value: `${identity.skillVersion} · ${identity.skillSha256.slice(0, 12)}` },
    { label: "Prompts", value: identity.suiteSha256.slice(0, 12) },
    { label: "Eval", value: identity.evalVersion },
    { label: "Suites", value: config.suites.join(", ") },
    { label: "Trials", value: String(config.trials) },
    { label: "Concurrency", value: String(config.concurrency) },
  ];
}
