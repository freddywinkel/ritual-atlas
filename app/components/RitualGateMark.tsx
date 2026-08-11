import { publicPath } from "../lib/publicPath";

export function RitualGateMark({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    // The shared public SVG is the deterministic source used by the PWA icon pipeline.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={publicPath(compact ? "/brand/ritual-gate-micro.svg" : "/brand/ritual-gate-mark.svg")}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
