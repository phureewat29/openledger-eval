import { Activity, Cpu, LayoutList, Plus } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import type { LivePayload, SandboxesPayload } from "../../shared/payloads.js";
import { useChannel, useConnection, useServerIdentity, type ConnectionStatus } from "../lib/channel.js";
import { LaunchDialog } from "./LaunchDialog.js";
import { Tip } from "./Tip.js";
import { TopBar } from "./TopBar.js";

// One frame for every screen: a rail that also reports, a bar that carries the
// run's vitals, and whatever the route puts between them.

/** The product's name where a person reads it. Machine surfaces use `openledger-eval`. */
const BRAND = "OpenLedger Eval";

const NAV = [
  { to: "/", label: "Live", Icon: Activity, end: true, hint: "the run in flight" },
  { to: "/reports", label: "Reports", Icon: LayoutList, end: false, hint: "finished iterations" },
  { to: "/system", label: "System", Icon: Cpu, end: false, hint: "processes and sandboxes" },
] as const;

const STATUS_DOT: Record<ConnectionStatus, string> = {
  open: "bg-accent",
  connecting: "bg-warn breathe",
  closed: "bg-bad",
};

/** The dot is the only thing on screen with no word beside it, so hovering it has to answer for itself. */
const STATUS_WORDS: Record<ConnectionStatus, string> = {
  open: "Connected",
  connecting: "Connecting to the dashboard…",
  closed: "Disconnected — the dashboard is not answering; retrying",
};

function RailButton({
  to,
  label,
  Icon,
  end,
  badge,
  hint,
}: {
  to: string;
  label: string;
  Icon: typeof Activity;
  end: boolean;
  badge?: number;
  hint?: string;
}) {
  return (
    <Tip label={hint === undefined ? label : `${label} — ${hint}`}>
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      className={({ isActive }) =>
        [
          "relative grid h-10 w-10 place-items-center rounded-md transition-colors",
          isActive ? "bg-surface-2 text-accent" : "text-accent/45 hover:bg-surface-2 hover:text-accent/80",
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute -left-2 h-5 w-0.5 rounded-full bg-accent" />}
          <Icon size={17} strokeWidth={1.75} />
          {badge !== undefined && badge > 0 && (
            <span className="tnum absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-warn px-1 text-[10px] font-medium leading-4 text-bg">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </>
      )}
    </NavLink>
    </Tip>
  );
}

export function AppShell() {
  useServerIdentity();
  const connection = useConnection();
  const live = useChannel<LivePayload>("live");
  const sandboxes = useChannel<SandboxesPayload>("sandboxes");
  const [launching, setLaunching] = useState(false);

  const running = live?.kind === "running-fresh" || live?.kind === "starting";
  const held = live?.kind === "running-paused";
  const runDotLabel = held ? "Run held" : "Run in flight";
  const orphans = (sandboxes?.entries ?? []).filter((entry) => entry.owner === "none").length;

  return (
    /*
     * Only the main region ever scrolls. Two things make that true and both are
     * load-bearing: `overflow-hidden` here, so nothing can push the document
     * itself into scrolling and take the rail out of view with it; and
     * `min-h-0` on the column below, because a flex child defaults to
     * `min-height: auto` and refuses to shrink under its content — which leaves
     * `main`'s own `overflow-auto` with nothing to do.
     */
    <div className="flex h-full overflow-hidden">
      {/*
        * No overflow on the rail, ever. Its tooltips are absolutely positioned
        * and open to the right of it, and any overflow here clips them — CSS
        * cannot scroll one axis while leaving the other visible. The rail holds
        * a handful of 40px buttons and cannot outgrow the window, so there is
        * nothing to scroll and nothing to gain by allowing it.
        */}
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface pb-5 pt-3">
        {/* The brand's only mark on screen; the rail is too narrow for its name,
            which the document title carries instead. */}
        <Tip label={BRAND}>
        <div
          aria-label={BRAND}
          className="mb-2 grid h-8 w-8 place-items-center rounded-md border border-line-strong text-[11px] font-semibold tracking-tight text-accent"
        >
          OE
        </div>
        </Tip>

        {NAV.map((item) => (
          <RailButton
            key={item.to}
            {...item}
            badge={item.to === "/system" ? orphans : undefined}
          />
        ))}

        {/* A dot on Live while a run is in flight: the rail reports as well as
            navigates. A held run keeps the dot and loses the breath, because the
            breath is what says the run is working. */}
        {(running || held) && (
          <Tip label={runDotLabel}>
            <span
              role="status"
              aria-label={runDotLabel}
              className={`-mt-1 h-1 w-1 rounded-full ${held ? "bg-warn" : "bg-accent breathe"}`}
            />
          </Tip>
        )}

        <div className="flex-1" />

        <Tip label="New Run — start an eval">
          <button
            type="button"
            aria-label="New Run"
            onClick={() => setLaunching(true)}
            className="grid h-10 w-10 place-items-center rounded-md text-accent/45 transition-colors hover:bg-surface-2 hover:text-accent"
          >
            <Plus size={17} strokeWidth={1.75} />
          </button>
        </Tip>
        <Tip label={STATUS_WORDS[connection]}>
          <span
            role="status"
            aria-label={STATUS_WORDS[connection]}
            className={`mt-2 h-1.5 w-1.5 rounded-full ${STATUS_DOT[connection]}`}
          />
        </Tip>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar live={live} />
        <main className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <Outlet context={live} />
        </main>
      </div>

      <LaunchDialog open={launching} onClose={() => setLaunching(false)} />
    </div>
  );
}
