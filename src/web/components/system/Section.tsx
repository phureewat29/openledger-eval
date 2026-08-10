import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Panel, SectionHeading } from "../Badge.js";

// The one wrapper every panel on this page shares, so a processes table, a
// sandbox list and a crash notice all read as the same kind of thing.

export function Section({
  title,
  note,
  icon,
  children,
}: {
  title: string;
  note?: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section>
      <SectionHeading aside={note} icon={icon}>
        {title}
      </SectionHeading>
      <Panel className="overflow-x-auto">{children}</Panel>
    </section>
  );
}
