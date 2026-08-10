import type { LivePayload, ProcessesPayload, SandboxesPayload } from "../../shared/payloads.js";
import { Crashed } from "../components/system/Crashed.js";
import { ProcessTree } from "../components/system/ProcessTree.js";
import { Sandboxes } from "../components/system/Sandboxes.js";
import { useChannel } from "../lib/channel.js";

// What the dashboard can see of the machine it is running on: the processes a
// run is actually made of, and the sandboxes those runs leave behind. Both exist
// because a run that is killed outright cleans up neither.

export function System() {
  const processes = useChannel<ProcessesPayload>("processes");
  const sandboxes = useChannel<SandboxesPayload>("sandboxes");
  const live = useChannel<LivePayload>("live");

  return (
    <div className="space-y-8 p-5">
      <Crashed live={live} />
      <ProcessTree processes={processes} />
      <Sandboxes sandboxes={sandboxes} />
    </div>
  );
}
