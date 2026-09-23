export function StatusPill({ value }: { value: string }) {
  const normalized = value.replaceAll("_", " ");
  return <span className={`status-pill status-${value}`}>{normalized}</span>;
}
