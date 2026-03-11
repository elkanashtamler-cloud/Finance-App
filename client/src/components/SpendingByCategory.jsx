import { useMemo } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const COLORS = [
  '#38bdf8',
  '#22c55e',
  '#f97316',
  '#e11d48',
  '#a855f7',
  '#facc15',
  '#0ea5e9',
  '#fb7185',
];

const CURRENCY_FORMATTER = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 0,
});

const CURRENT_MONTH = (() => {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
})();

function groupByCategoryForCurrentMonth(rows) {
  const buckets = new Map();

  for (const row of rows) {
    const amount = row.amount ?? 0;
    if (!(row.date instanceof Date) || Number.isNaN(row.date.getTime())) {
      continue;
    }

    // Only negative amounts (spending) in current month/year
    if (amount >= 0) continue;
    if (
      row.date.getFullYear() !== CURRENT_MONTH.year ||
      row.date.getMonth() !== CURRENT_MONTH.month
    ) {
      continue;
    }

    const rawCategory = (row.category || '').trim();
    const category = rawCategory === '' ? 'Other' : rawCategory;

    const prev = buckets.get(category) ?? 0;
    buckets.set(category, prev + Math.abs(amount));
  }

  return Array.from(buckets.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

function SpendingTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const { name, value } = payload[0].payload;
  return (
    <div className="glass-panel px-3 py-2 text-xs text-white shadow-lg">
      <div className="font-medium">{name}</div>
      <div className="text-white/80">{CURRENCY_FORMATTER.format(value)}</div>
    </div>
  );
}

export default function SpendingByCategory({ rows }) {
  const data = useMemo(
    () => groupByCategoryForCurrentMonth(rows || []),
    [rows],
  );

  const hasData = data.length > 0;

  return (
    <div className="glass-card p-4 sm:p-6 lg:p-8 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Spending by category
          </h2>
          <p className="text-xs text-white/60 mt-0.5">
            Current month, negative amounts only
          </p>
        </div>
      </div>

      {!hasData ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-white/50 text-sm text-center px-4">
            No spending data for the current month yet.
          </p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col sm:flex-row gap-4 items-center">
          <div className="w-full sm:w-1/2 h-56 sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius="60%"
                  outerRadius="90%"
                  paddingAngle={2}
                  stroke="rgba(15,23,42,0.8)"
                  strokeWidth={2}
                >
                  {data.map((entry, index) => (
                    <Cell
                      key={`cell-${entry.name}`}
                      fill={COLORS[index % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip content={<SpendingTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="w-full sm:w-1/2 space-y-2 text-xs sm:text-sm">
            <Legend
              verticalAlign="top"
              align="left"
              layout="vertical"
              payload={data.map((entry, index) => ({
                id: entry.name,
                type: 'square',
                value: `${entry.name} – ${CURRENCY_FORMATTER.format(entry.value)}`,
                color: COLORS[index % COLORS.length],
              }))}
              content={({ payload }) => (
                <ul className="space-y-1">
                  {payload?.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block w-3 h-3 rounded-full"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="text-white/80">{item.id}</span>
                      </span>
                      <span className="font-medium text-white/90">
                        {item.value.split('–')[1].trim()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}

