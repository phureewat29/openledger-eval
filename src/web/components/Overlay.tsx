import type { ReactNode } from "react";
import { useEscape } from "../lib/hooks.js";

// The one modal shell every dialog on the page sits inside: a dimmed backdrop
// that closes on click, a panel that does not, and Escape wired to the same
// close a click on the backdrop reaches. `className` is the panel's own size
// and layout, which differs enough between callers — a fixed-width confirm, a
// flex column with its own header and footer — that there is nothing generic
// to give it here.

export function Overlay({
  onClose,
  role = "dialog",
  label,
  className = "",
  children,
}: {
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  useEscape(true, onClose);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-bg/80 p-4" onClick={onClose}>
      <div
        role={role}
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        className={`rounded-lg border border-line-strong bg-surface ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
