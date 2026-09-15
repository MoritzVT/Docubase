import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function Brand() {
  const markRef = useRef<HTMLButtonElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const frameRef = useRef<number | null>(null);
  const nextOffsetRef = useRef({ x: 0, y: 0 });
  const [eyesVisible, setEyesVisible] = useState(false);

  useEffect(() => {
    if (!eyesVisible) {
      if (eyesRef.current) eyesRef.current.style.transform = "translate(0px, 0px)";
      return;
    }

    const followPointer = (event: PointerEvent) => {
      const bounds = markRef.current?.getBoundingClientRect();
      if (!bounds) return;

      const x = event.clientX - (bounds.left + bounds.width / 2);
      const y = event.clientY - (bounds.top + bounds.height / 2);
      const distance = Math.hypot(x, y) || 1;
      const strength = Math.min(distance / 90, 1);

      nextOffsetRef.current = {
        x: (x / distance) * 2.8 * strength,
        y: (y / distance) * 4.2 * strength,
      };

      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        const { x: nextX, y: nextY } = nextOffsetRef.current;
        if (eyesRef.current) {
          eyesRef.current.style.transform = `translate(${nextX}px, ${nextY}px)`;
        }
        frameRef.current = null;
      });
    };

    window.addEventListener("pointermove", followPointer);
    return () => {
      window.removeEventListener("pointermove", followPointer);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [eyesVisible]);

  return (
    <div className="brand">
      <button
        aria-label={eyesVisible ? "Hide logo eyes" : "Show logo eyes"}
        aria-pressed={eyesVisible}
        className={`brand-mark${eyesVisible ? " is-awake" : ""}`}
        onClick={() => setEyesVisible((visible) => !visible)}
        ref={markRef}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 40.81 78.32">
          <rect height="42.96" width="5" x="35.81" />
          <polygon points="35.54 78.32 0 78.32 0 37.99 39.98 37.99 39.98 42.99 5 42.99 5 73.32 35.54 73.32 35.54 78.32" />
          <rect height="42.96" width="5" />
          <polygon points="40.81 78.32 5.27 78.32 5.27 73.32 35.81 73.32 35.81 42.99 .83 42.99 .83 37.99 40.81 37.99 40.81 78.32" />
          <g className="brand-eyes">
            <g className="brand-eye-position" ref={eyesRef}>
              <rect height="7" rx="0.6" width="3.5" x="12" y="56" />
              <rect height="7" rx="0.6" width="3.5" x="25.3" y="56" />
            </g>
          </g>
        </svg>
      </button>
      <strong>docubase</strong>
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
