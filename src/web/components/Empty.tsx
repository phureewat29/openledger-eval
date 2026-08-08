/** What a screen says when it has nothing to show, in words rather than a spinner. */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <p className="text-muted">{title}</p>
        {hint !== undefined && <p className="mt-1 text-subtle">{hint}</p>}
      </div>
    </div>
  );
}
