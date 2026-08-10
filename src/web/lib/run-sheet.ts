import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { LiveItem } from "../../report/live-item.js";
import { modelSlug } from "../../shared/vocabulary.js";

// The run sheet's URL contract: which cell is open, carried in `model`/`suite`/
// `case` search params so the sheet is shareable and survives a refresh. Every
// screen that opens a cell, and the sheet that reads one back, call this on the
// same router state — so they can never disagree about the contract's shape.

export interface RunSheetParams {
  model: string | null;
  suite: string | null;
  caseId: string | null;
}

export interface RunSheetHandle {
  params: RunSheetParams;
  open(item: LiveItem): void;
  close(): void;
}

export function useRunSheet(): RunSheetHandle {
  const [searchParams, setSearchParams] = useSearchParams();

  const open = useCallback(
    (item: LiveItem): void => {
      setSearchParams((held) => {
        const next = new URLSearchParams(held);
        next.set("model", modelSlug(item.model));
        next.set("suite", item.suite);
        next.set("case", item.caseId);
        return next;
      });
    },
    [setSearchParams],
  );

  const close = useCallback((): void => {
    setSearchParams((held) => {
      const next = new URLSearchParams(held);
      next.delete("model");
      next.delete("suite");
      next.delete("case");
      return next;
    });
  }, [setSearchParams]);

  return {
    params: {
      model: searchParams.get("model"),
      suite: searchParams.get("suite"),
      caseId: searchParams.get("case"),
    },
    open,
    close,
  };
}
