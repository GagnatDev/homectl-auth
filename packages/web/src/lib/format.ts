/** Format an ISO timestamp for display, or an em dash when absent. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Short day label for chart axes/tooltips (e.g. "18 Jul"). */
export function formatDay(value: string): string {
  // Chart dates arrive as plain YYYY-MM-DD; parse as local, not UTC midnight.
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
