import { AlertTriangle, Info, OctagonAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// One shape for every status the dashboard states, so a reader learns it once.
// The word inside is always the fact; the tone repeats it and never carries it
// alone — which is also what keeps the green/amber pair legible to a reader who
// cannot separate those hues.

export type Tone = "accent" | "warn" | "bad" | "muted";

const TONES: Record<Tone, string> = {
  accent: "border-accent/35 bg-accent/10 text-accent",
  warn: "border-warn/35 bg-warn/10 text-warn",
  bad: "border-bad/35 bg-bad/10 text-bad",
  muted: "border-line-strong bg-surface-2 text-muted",
};

export function Badge({
  tone = "muted",
  dot = false,
  pulse = false,
  children,
}: {
  tone?: Tone;
  /** A leading dot, for a state that is about liveness rather than outcome. */
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] leading-4 ${TONES[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? "breathe" : ""}`} aria-hidden />}
      {children}
    </span>
  );
}

/**
 * A bordered surface for anything that needs to read as one thing — a section, a
 * banner, a table. Hairline rather than heavy: the border is the accent laid
 * over the ground, so structure is branded without becoming loud.
 */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-surface ${className}`}>{children}</div>;
}

const CALLOUT_EDGE: Record<Tone, string> = {
  accent: "border-accent/35 bg-accent/5",
  warn: "border-warn/35 bg-warn/5",
  bad: "border-bad/35 bg-bad/5",
  muted: "border-line bg-surface",
};

/** The mark reaches a reader before the sentence does, and does not depend on hue. */
const CALLOUT_ICON: Record<Tone, LucideIcon> = {
  accent: Info,
  warn: AlertTriangle,
  bad: OctagonAlert,
  muted: Info,
};

const CALLOUT_TEXT: Record<Tone, string> = {
  accent: "text-accent",
  warn: "text-warn",
  bad: "text-bad",
  muted: "text-muted",
};

/** A panel that is saying something is wrong, tinted by how wrong. */
export function Callout({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = CALLOUT_ICON[tone];
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${CALLOUT_EDGE[tone]}`}>
      <Icon size={15} strokeWidth={1.75} className={`mt-0.5 shrink-0 ${CALLOUT_TEXT[tone]}`} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function SectionHeading({
  children,
  aside,
  icon: Icon,
}: {
  children: ReactNode;
  aside?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-fg">
      {Icon !== undefined && <Icon size={15} strokeWidth={1.75} className="text-accent" aria-hidden />}
      {children}
      {aside !== undefined && <span className="tnum text-subtle">{aside}</span>}
    </h2>
  );
}
