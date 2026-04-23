'use client';

import { useMemo } from 'react';

interface CumulativePoint {
  date: string;
  cumulative_units: number;
}

interface DrawdownChartProps {
  data: CumulativePoint[];
}

const CHART_H = 160;
const CHART_W = 600;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 12;
const PAD_B = 28;

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function DrawdownChart({ data }: DrawdownChartProps) {
  const points = useMemo(() => {
    if (data.length === 0) return null;

    const values = data.map((d) => d.cumulative_units);
    const minVal = Math.min(0, ...values);
    const maxVal = Math.max(0, ...values);
    const range = maxVal - minVal || 1;

    const innerW = CHART_W - PAD_L - PAD_R;
    const innerH = CHART_H - PAD_T - PAD_B;

    const coords = data.map((d, i) => ({
      x: PAD_L + (i / Math.max(data.length - 1, 1)) * innerW,
      y: PAD_T + innerH - ((d.cumulative_units - minVal) / range) * innerH,
      val: d.cumulative_units,
      date: d.date,
    }));

    // Compute peak-to-trough drawdown
    let peak = -Infinity;
    let maxDrawdown = 0;
    let peakIdx = 0;
    let troughIdx = 0;
    let tempPeakIdx = 0;

    for (let i = 0; i < values.length; i++) {
      if (values[i] > peak) {
        peak = values[i];
        tempPeakIdx = i;
      }
      const dd = peak - values[i];
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        peakIdx = tempPeakIdx;
        troughIdx = i;
      }
    }

    const zeroY = PAD_T + innerH - ((0 - minVal) / range) * innerH;
    const polyline = coords.map((c) => `${c.x},${c.y}`).join(' ');

    return { coords, zeroY, polyline, maxDrawdown, peakIdx, troughIdx, minVal, maxVal, innerH, innerW };
  }, [data]);

  if (!points || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
        No settled bets yet.
      </div>
    );
  }

  const { coords, zeroY, polyline, maxDrawdown, peakIdx, troughIdx } = points;
  const lastVal = data[data.length - 1].cumulative_units;
  const lineColor = lastVal >= 0 ? '#34d399' : '#f87171';
  const ddPeak = coords[peakIdx];
  const ddTrough = coords[troughIdx];

  // Y-axis labels: min, 0, max
  const yLabels = [
    { y: PAD_T, val: points.maxVal },
    { y: points.zeroY, val: 0 },
    { y: CHART_H - PAD_B, val: points.minVal },
  ].filter((l, i, arr) => i === 0 || Math.abs(l.y - arr[i - 1].y) > 18);

  // X-axis: show first, last, and up to 3 evenly spaced dates
  const xLabelIndices = [0];
  if (data.length > 2) xLabelIndices.push(Math.floor(data.length / 2));
  if (data.length > 1) xLabelIndices.push(data.length - 1);

  return (
    <div className="w-full overflow-x-auto" role="img" aria-label="Cumulative units chart">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full"
        style={{ minWidth: 280 }}
        aria-hidden="true"
      >
        {/* Zero line */}
        <line
          x1={PAD_L}
          y1={zeroY}
          x2={CHART_W - PAD_R}
          y2={zeroY}
          stroke="#374151"
          strokeDasharray="4,3"
          strokeWidth={1}
        />

        {/* Drawdown shading between peak and trough */}
        {maxDrawdown > 0.01 && (
          <rect
            x={ddPeak.x}
            y={ddPeak.y}
            width={ddTrough.x - ddPeak.x}
            height={ddTrough.y - ddPeak.y}
            fill="#ef444420"
          />
        )}

        {/* Cumulative line */}
        <polyline
          points={polyline}
          fill="none"
          stroke={lineColor}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Y-axis labels */}
        {yLabels.map((l) => (
          <text
            key={l.y}
            x={PAD_L - 4}
            y={l.y + 4}
            textAnchor="end"
            fontSize={9}
            fill="#6b7280"
          >
            {l.val >= 0 ? '+' : ''}{l.val.toFixed(1)}u
          </text>
        ))}

        {/* X-axis labels */}
        {xLabelIndices.map((idx) => (
          <text
            key={idx}
            x={coords[idx].x}
            y={CHART_H - PAD_B + 16}
            textAnchor="middle"
            fontSize={9}
            fill="#6b7280"
          >
            {formatDate(data[idx].date)}
          </text>
        ))}

        {/* Last value dot */}
        <circle
          cx={coords[coords.length - 1].x}
          cy={coords[coords.length - 1].y}
          r={3}
          fill={lineColor}
        />
      </svg>

      {maxDrawdown > 0.01 && (
        <p className="text-xs text-red-400 mt-1">
          Max drawdown: -{maxDrawdown.toFixed(2)}u (shaded region)
        </p>
      )}
    </div>
  );
}
