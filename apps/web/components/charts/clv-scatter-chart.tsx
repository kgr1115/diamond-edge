'use client';

import { useMemo } from 'react';

interface ClvTimePoint {
  date: string;
  pick_id: string;
  market: string;
  clv_edge: number;
}

interface ClvScatterChartProps {
  data: ClvTimePoint[];
}

const CHART_H = 200;
const CHART_W = 600;
const PAD_L = 52;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;

const MARKET_COLORS: Record<string, string> = {
  moneyline: '#60a5fa',
  run_line: '#a78bfa',
  total: '#34d399',
  prop: '#fb923c',
};

function markerColor(market: string): string {
  return MARKET_COLORS[market] ?? '#9ca3af';
}

export function ClvScatterChart({ data }: ClvScatterChartProps) {
  const chart = useMemo(() => {
    if (data.length === 0) return null;

    const edges = data.map((d) => d.clv_edge);
    const minEdge = Math.min(...edges);
    const maxEdge = Math.max(...edges);
    const edgeRange = Math.max(Math.abs(minEdge), Math.abs(maxEdge)) * 1.15 || 0.05;

    const innerW = CHART_W - PAD_L - PAD_R;
    const innerH = CHART_H - PAD_T - PAD_B;
    const midY = PAD_T + innerH / 2;

    const points = data.map((d, i) => ({
      x: PAD_L + (i / Math.max(data.length - 1, 1)) * innerW,
      y: midY - (d.clv_edge / edgeRange) * (innerH / 2),
      clv: d.clv_edge,
      market: d.market,
      date: d.date,
      id: d.pick_id,
    }));

    // Y-axis ticks
    const tickCount = 5;
    const yTicks = Array.from({ length: tickCount }, (_, i) => {
      const frac = i / (tickCount - 1);
      const val = edgeRange - frac * 2 * edgeRange;
      const y = PAD_T + frac * innerH;
      return { y, val };
    });

    // X-axis: first, mid, last dates
    const xLabels = [0, Math.floor(data.length / 2), data.length - 1]
      .filter((idx, pos, arr) => pos === 0 || idx !== arr[pos - 1])
      .map((idx) => ({ x: points[idx].x, date: data[idx].date }));

    return { points, midY, yTicks, xLabels, edgeRange };
  }, [data]);

  if (!chart || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        No CLV data yet.
      </div>
    );
  }

  const { points, midY, yTicks, xLabels } = chart;

  return (
    <div className="w-full overflow-x-auto" role="img" aria-label="CLV edge scatter chart">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full" style={{ minWidth: 280 }} aria-hidden="true">
        {/* Zero line */}
        <line x1={PAD_L} y1={midY} x2={CHART_W - PAD_R} y2={midY} stroke="#374151" strokeDasharray="4,3" strokeWidth={1} />

        {/* Positive zone shading */}
        <rect x={PAD_L} y={PAD_T} width={CHART_W - PAD_L - PAD_R} height={midY - PAD_T} fill="#34d39908" />

        {/* Y-axis ticks */}
        {yTicks.map((t) => (
          <g key={t.y}>
            <line x1={PAD_L - 4} y1={t.y} x2={PAD_L} y2={t.y} stroke="#374151" strokeWidth={1} />
            <text x={PAD_L - 6} y={t.y + 4} textAnchor="end" fontSize={9} fill="#6b7280">
              {t.val >= 0 ? '+' : ''}{(t.val * 100).toFixed(1)}%
            </text>
          </g>
        ))}

        {/* Scatter points */}
        {points.map((p) => (
          <circle
            key={p.id}
            cx={p.x}
            cy={p.y}
            r={4}
            fill={markerColor(p.market)}
            fillOpacity={0.8}
            stroke={p.clv > 0 ? '#34d399' : '#f87171'}
            strokeWidth={0.5}
          >
            <title>{p.date} — {p.market} — CLV: {(p.clv * 100).toFixed(2)}%</title>
          </circle>
        ))}

        {/* X-axis labels */}
        {xLabels.map((l) => (
          <text key={l.date} x={l.x} y={CHART_H - PAD_B + 16} textAnchor="middle" fontSize={9} fill="#6b7280">
            {new Date(l.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </text>
        ))}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2">
        {Object.entries(MARKET_COLORS).map(([mkt, color]) => (
          <span key={mkt} className="flex items-center gap-1 text-xs text-gray-400">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
            {mkt}
          </span>
        ))}
      </div>
    </div>
  );
}
