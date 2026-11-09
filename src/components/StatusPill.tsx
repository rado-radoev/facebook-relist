import { STATUS_META } from "../lib/status";

interface Props {
  status: string;
}

export default function StatusPill({ status }: Props) {
  const meta = STATUS_META[status];
  const color = meta ? meta.color : "#a6adc8";
  const label = meta ? meta.label : status;

  return (
    <span className="status-pill" style={{ color, borderColor: color }}>
      <span className="status-dot" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
