/**
 * Lightweight, dependency-free chart primitives for the admin statistics page.
 *
 * - StatTile        — headline number with label + optional hint
 * - TimeSeriesChart — multi-line SVG chart with crosshair, tooltip (pointer +
 *                     keyboard), integer y-ticks and a legend
 * - BarList         — horizontal bars with direct labels, for per-app magnitude
 *
 * Series colors come from the --chart-N custom properties (declared in
 * index.css for both light and dark surfaces); all text uses theme text tokens.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDay } from '@/lib/format';

// ── Stat tile ───────────────────────────────────────────────────────────────

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1 text-3xl font-semibold">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

// ── Time-series line chart ──────────────────────────────────────────────────

export type ChartSeries = {
  key: string;
  label: string;
  /** CSS color, e.g. 'var(--chart-1)' */
  color: string;
};

type Point = { date: string } & Record<string, unknown>;

const PAD = { top: 12, right: 12, bottom: 22, left: 36 };
const HEIGHT = 220;

/** Round up to a "nice" axis maximum with integer ticks. */
function niceTicks(maxValue: number): { max: number; ticks: number[] } {
  const target = Math.max(4, maxValue);
  const rawStep = target / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep) ?? 10 * magnitude;
  const max = step * 4;
  return { max, ticks: [0, step, step * 2, step * 3, max] };
}

export function TimeSeriesChart({
  data,
  series,
  ariaLabel,
}: {
  data: Point[];
  series: ChartSeries[];
  ariaLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const { max, ticks } = useMemo(() => {
    const values = data.flatMap((p) => series.map((s) => Number(p[s.key] ?? 0)));
    return niceTicks(Math.max(0, ...values));
  }, [data, series]);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const xAt = (i: number) =>
    PAD.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const yAt = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const indexFromClientX = (clientX: number): number => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || data.length === 0) return 0;
    const x = clientX - rect.left - PAD.left;
    const ratio = plotW > 0 ? x / plotW : 0;
    return Math.min(data.length - 1, Math.max(0, Math.round(ratio * (data.length - 1))));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      setHover((h) => Math.min(data.length - 1, Math.max(0, (h ?? 0) + delta)));
    }
  };

  // X labels: first, last, and up to 3 evenly spaced in between, skipping
  // neighbors that would collide at narrow widths.
  const xLabelIndexes = useMemo(() => {
    if (data.length <= 2) return data.map((_, i) => i);
    const count = Math.min(5, Math.max(2, Math.floor(plotW / 90) + 1));
    const idx = new Set<number>();
    for (let i = 0; i < count; i++) {
      idx.add(Math.round((i / (count - 1)) * (data.length - 1)));
    }
    return Array.from(idx).sort((a, b) => a - b);
  }, [data, plotW]);

  const hovered = hover !== null ? data[hover] : undefined;
  const tooltipLeft =
    hover !== null && width > 0
      ? Math.min(Math.max(xAt(hover) + 10, PAD.left), width - 150)
      : 0;

  return (
    <div className="space-y-2">
      {/* Legend — always present for ≥2 series */}
      {series.length > 1 && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              {s.label}
            </span>
          ))}
        </div>
      )}

      <div ref={containerRef} className="relative">
        <svg
          role="img"
          aria-label={ariaLabel}
          width="100%"
          height={HEIGHT}
          tabIndex={0}
          className="block outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={(e) => setHover(indexFromClientX(e.clientX))}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover((h) => h ?? data.length - 1)}
          onBlur={() => setHover(null)}
          onKeyDown={onKeyDown}
        >
          {width > 0 && data.length > 0 && (
            <>
              {/* Gridlines + y ticks (hairline, recessive) */}
              {ticks.map((t) => (
                <g key={t}>
                  <line
                    x1={PAD.left}
                    x2={width - PAD.right}
                    y1={yAt(t)}
                    y2={yAt(t)}
                    stroke="hsl(var(--border))"
                    strokeWidth={1}
                  />
                  <text
                    x={PAD.left - 6}
                    y={yAt(t) + 3}
                    textAnchor="end"
                    fontSize={10}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                    fill="hsl(var(--muted-foreground))"
                  >
                    {t.toLocaleString()}
                  </text>
                </g>
              ))}

              {/* X labels */}
              {xLabelIndexes.map((i) => (
                <text
                  key={i}
                  x={xAt(i)}
                  y={HEIGHT - 6}
                  textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}
                  fontSize={10}
                  fill="hsl(var(--muted-foreground))"
                >
                  {formatDay(data[i]!.date)}
                </text>
              ))}

              {/* Crosshair */}
              {hover !== null && (
                <line
                  x1={xAt(hover)}
                  x2={xAt(hover)}
                  y1={PAD.top}
                  y2={PAD.top + plotH}
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth={1}
                />
              )}

              {/* Series lines */}
              {series.map((s) => (
                <polyline
                  key={s.key}
                  points={data
                    .map((p, i) => `${xAt(i)},${yAt(Number(p[s.key] ?? 0))}`)
                    .join(' ')}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}

              {/* Hovered markers, with a surface ring so they stay legible */}
              {hover !== null &&
                series.map((s) => (
                  <circle
                    key={s.key}
                    cx={xAt(hover)}
                    cy={yAt(Number(data[hover]![s.key] ?? 0))}
                    r={4}
                    fill={s.color}
                    stroke="hsl(var(--card))"
                    strokeWidth={2}
                  />
                ))}
            </>
          )}
        </svg>

        {/* Tooltip — one readout, every series */}
        {hovered && (
          <div
            className="pointer-events-none absolute top-2 z-10 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
            style={{ left: tooltipLeft }}
          >
            <div className="mb-1 text-muted-foreground">{formatDay(hovered.date)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-0.5 w-3 rounded-full"
                  style={{ backgroundColor: s.color }}
                  aria-hidden
                />
                <span className="font-semibold tabular-nums">
                  {Number(hovered[s.key] ?? 0).toLocaleString()}
                </span>
                <span className="text-muted-foreground">{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Horizontal bar list ─────────────────────────────────────────────────────

export function BarList({
  items,
}: {
  items: { label: string; value: number; detail?: string }[];
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-3 text-sm">
          <span className="w-36 shrink-0 truncate sm:w-44" title={item.label}>
            {item.label}
          </span>
          <span className="relative h-5 flex-1">
            <span
              className="absolute inset-y-0 left-0 rounded-r"
              style={{
                width: `${(item.value / max) * 100}%`,
                minWidth: item.value > 0 ? 4 : 0,
                backgroundColor: 'var(--chart-1)',
              }}
              aria-hidden
            />
          </span>
          <span className="w-14 shrink-0 text-right font-medium tabular-nums">
            {item.value.toLocaleString()}
          </span>
          {item.detail !== undefined && (
            <span className="hidden w-36 shrink-0 text-right text-xs text-muted-foreground sm:block">
              {item.detail}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Card wrapper for a chart section ────────────────────────────────────────

export function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
