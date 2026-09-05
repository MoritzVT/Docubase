import { Film, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

export function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Film size={19} />
      </span>
      <strong>Docubase</strong>
    </div>
  );
}

export function Notice({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "error" | "success" | "warning";
}) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

export function LoadingScreen({ label }: { label: string }) {
  return (
    <main className="centered-shell">
      <LoadingBlock label={label} />
    </main>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="loading-block">
      <LoaderCircle className="spin" size={21} />
      <span>{label}</span>
    </div>
  );
}
