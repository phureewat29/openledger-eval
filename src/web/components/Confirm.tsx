import { useEffect, type ReactNode } from "react";

// The one shape for "this is about to spend money or destroy something, and here
// is what it will cost". The body is the point: a dialog that only asks whether
// you are sure has told the reader nothing they did not already know.

const ACTION_TONE = {
  accent: "bg-accent text-bg",
  bad: "bg-bad text-bg",
} as const;

export function Confirm({
  title,
  action,
  tone = "bad",
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  /** The verb on the button; never "OK", so the last thing read is what happens. */
  action: string;
  tone?: keyof typeof ACTION_TONE;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-bg/80 p-4" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        className="w-[min(30rem,92vw)] rounded-lg border border-line-strong bg-surface p-4"
      >
        <h3 className="mb-2 text-fg">{title}</h3>
        <div className="mb-4 space-y-2 text-muted">{children}</div>
        {error !== null && <p className="mb-2 text-bad">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-muted hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 font-medium transition-opacity disabled:opacity-35 ${ACTION_TONE[tone]}`}
          >
            {busy ? "Working…" : action}
          </button>
        </div>
      </div>
    </div>
  );
}
