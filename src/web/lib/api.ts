// Everything that is not pushed. These are reads of things that do not move and
// the four writes the dashboard is allowed to make.

/**
 * A refusal carries the whole body beside its sentence. Most callers want only
 * the sentence, but a route that refuses for a reason the page can act on — a
 * rerun into a report measured against another build — has somewhere to put the
 * detail without every caller having to parse prose to find it.
 */
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; body: unknown };

async function refusal(response: Response): Promise<{ ok: false; error: string; body: unknown }> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const error = typeof body?.error === "string" ? body.error : `${response.status} ${response.statusText}`;
  return { ok: false, error, body };
}

function broke(error: unknown): { ok: false; error: string; body: unknown } {
  return { ok: false, error: error instanceof Error ? error.message : String(error), body: null };
}

export async function get<T>(path: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path);
    if (!response.ok) return await refusal(response);
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    return broke(error);
  }
}

export async function post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return await refusal(response);
    return { ok: true, value: (await response.json()) as T };
  } catch (error) {
    return broke(error);
  }
}
