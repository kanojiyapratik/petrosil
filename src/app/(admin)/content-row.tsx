/** The small links under a title in the content lists: View on the brand site, or Restore from Deleted. */

export function ViewOnSite({ href }: { href: string }) {
  return (
    <a className="small" href={href} target="_blank" rel="noreferrer">
      View on site ↗
    </a>
  );
}

export function RestoreButton({
  action,
  id,
  site,
}: {
  action: (form: FormData) => void | Promise<void>;
  id: number;
  site: string;
}) {
  return (
    <form action={action} style={{ display: "inline" }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="site" value={site} />
      <button type="submit" className="small">
        Restore
      </button>
    </form>
  );
}
