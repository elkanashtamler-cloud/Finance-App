import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  TrendingUp,
  Wallet,
  ArrowDownLeft,
  ArrowUpRight,
  Edit3,
} from 'lucide-react';
import { fetchSheetRows } from '../services/sheetService';
import {
  BarChart,
  Bar,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
} from 'recharts';

const CURRENCY_FORMATTER = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 2,
});

// Desired display order of expense categories (without 'הכנסות')
const CATEGORY_ORDER = [
  'הוצאות משתנות',
  'סופר',
  'אוכל בחוץ',
  'רכב',
  'תחבורה ציבורית',
  'פנאי',
  'ביגוד והנעלה',
  'הוצאות קבועות',
];

// Options available when editing a transaction category (includes income)
const CATEGORY_OPTIONS = [...CATEGORY_ORDER, 'הכנסות'];

function buildMonthlyAggregation(rows) {
  const monthByKey = new Map();
  const allCategories = new Set();
  const now = new Date();
  const endOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  );

  function getFinancialMonthMeta(date) {
    let year = date.getFullYear();
    let monthIndex = date.getMonth(); // 0-11
    const day = date.getDate();
    if (day < 10) {
      monthIndex -= 1;
      if (monthIndex < 0) {
        monthIndex = 11;
        year -= 1;
      }
    }
    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const startDate = new Date(year, monthIndex, 10, 0, 0, 0, 0);
    const endDate = new Date(year, monthIndex + 1, 9, 23, 59, 59, 999);
    const label = startDate.toLocaleString(undefined, {
      month: 'long',
      year: 'numeric',
    }); // e.g. "אפריל 2025"
    return { key, year, monthIndex, startDate, endDate, label };
  }

  for (const row of rows) {
    const d = row.date instanceof Date ? row.date : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    // Ignore future transactions – only current and past months
    if (d > endOfToday) continue;

    const { key, year, monthIndex, startDate, endDate, label } =
      getFinancialMonthMeta(d);

    let month = monthByKey.get(key);
    if (!month) {
      month = {
        key,
        year,
        monthIndex,
        label,
        startDate,
        endDate,
        income: 0,
        expenses: 0, // negative sum
        categories: new Map(), // name -> { name, total, transactions }
      };
      monthByKey.set(key, month);
    }

    const amount = row.amount ?? 0;
    if (amount > 0) {
      month.income += amount;
    } else if (amount < 0) {
      month.expenses += amount;
    }

    const categoryName = row.category || 'הוצאות משתנות';
    if (categoryName !== 'הכנסות') {
      allCategories.add(categoryName);
    }

    // Per-category aggregation:
    // - תמיד שומרים את העסקה במערך transactions של הקטגוריה
    // - totals:
    //   * עבור הוצאות – סכום החיובים (amount < 0, בערך מוחלט)
    //   * עבור "הכנסות" – סכום ההכנסות (amount > 0)
    let cat = month.categories.get(categoryName);
    if (!cat) {
      cat = { name: categoryName, total: 0, transactions: [] };
      month.categories.set(categoryName, cat);
    }
    if (amount < 0 && categoryName !== 'הכנסות') {
      cat.total += Math.abs(amount);
    } else if (amount > 0 && categoryName === 'הכנסות') {
      cat.total += amount;
    }
    cat.transactions.push(row);
  }

  const months = Array.from(monthByKey.values()).sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year;
    return b.monthIndex - a.monthIndex;
  });

  const categories = Array.from(allCategories).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    const sa = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
    const sb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  return { months, monthByKey, categories };
}

function getWeekIndexForDate(date, month) {
  if (!date || !month || !month.startDate) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor(
    (date.setHours(0, 0, 0, 0) - month.startDate.getTime()) / msPerDay,
  );
  if (diffDays < 0) return null;
  if (diffDays <= 6) return 0;
  if (diffDays <= 13) return 1;
  if (diffDays <= 20) return 2;
  return 3;
}

function getWeekRangesForMonth(month) {
  if (!month?.startDate || !month?.endDate) return [];
  const msPerDay = 24 * 60 * 60 * 1000;
  const ranges = [];
  for (let i = 0; i < 4; i += 1) {
    const start = new Date(month.startDate.getTime() + i * 7 * msPerDay);
    let end = new Date(start.getTime() + 6 * msPerDay);
    if (end > month.endDate) end = new Date(month.endDate);
    ranges.push({ start, end });
  }
  return ranges;
}

export default function Dashboard() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedMonthKey, setSelectedMonthKey] = useState(null);
  const [activeCategory, setActiveCategory] = useState(null);
  const [editingTxn, setEditingTxn] = useState(null);
  const [editCategory, setEditCategory] = useState('');
  const [splitLines, setSplitLines] = useState([]);
  const [savingAction, setSavingAction] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [showIncomeDetails, setShowIncomeDetails] = useState(false);
  const incomeDetailsRef = useRef(null);
  const [selectedWeekIndex, setSelectedWeekIndex] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const { rows: sheetRows } = await fetchSheetRows();
        if (!cancelled) {
          setRows(sheetRows);
        }
      } catch (err) {
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.error(err);
          setError('Failed to load data from Google Sheets.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const { months, monthByKey, categories } = useMemo(
    () => buildMonthlyAggregation(rows),
    [rows],
  );

  const sixMonthCategoryAverages = useMemo(() => {
    const map = new Map();
    const recentMonths = months.slice(0, 6);
    if (!recentMonths.length) return map;

    for (const m of recentMonths) {
      for (const [name, cat] of m.categories.entries()) {
        const prev = map.get(name) || 0;
        map.set(name, prev + (cat.total || 0));
      }
    }
    const denominator = recentMonths.length;
    for (const [name, sum] of map.entries()) {
      map.set(name, sum / denominator);
    }
    return map;
  }, [months]);

  // Initialize / keep selected month in sync with available data
  useEffect(() => {
    if (!months.length) {
      setSelectedMonthKey(null);
      return;
    }
    if (!selectedMonthKey || !monthByKey.has(selectedMonthKey)) {
      setSelectedMonthKey(months[0].key);
    }
  }, [months, monthByKey, selectedMonthKey]);

  // activeCategory starts as null – user must click to open
  useEffect(() => {
    if (!categories.length) {
      setActiveCategory(null);
    }
  }, [categories]);

  // Reset selected week when changing month or category
  useEffect(() => {
    setSelectedWeekIndex(null);
  }, [selectedMonthKey, activeCategory]);

  // When month changes, close income details
  useEffect(() => {
    setShowIncomeDetails(false);
  }, [selectedMonthKey]);

  const selectedMonth =
    selectedMonthKey && monthByKey.has(selectedMonthKey)
      ? monthByKey.get(selectedMonthKey)
      : null;

  const selectedMonthIndex = useMemo(
    () => months.findIndex((m) => m.key === selectedMonthKey),
    [months, selectedMonthKey],
  );

  const goToMonthByOffset = useCallback(
    (delta) => {
      if (!months.length || selectedMonthIndex === -1) return;
      const nextIndex = selectedMonthIndex + delta;
      if (nextIndex < 0 || nextIndex >= months.length) return;
      setSelectedMonthKey(months[nextIndex].key);
    },
    [months, selectedMonthIndex],
  );

  const goToPrevMonth = useCallback(
    () => goToMonthByOffset(1),
    [goToMonthByOffset],
  );

  const goToNextMonth = useCallback(
    () => goToMonthByOffset(-1),
    [goToMonthByOffset],
  );

  const incomeThisMonth = selectedMonth?.income ?? 0;
  const expensesThisMonth = selectedMonth?.expenses ?? 0; // negative sum
  const netThisMonth = incomeThisMonth + expensesThisMonth;
  const totalExpensesAbs = Math.abs(expensesThisMonth);

  const trendText = useMemo(() => {
    if (!selectedMonth) return '—';

    const idx = months.findIndex((m) => m.key === selectedMonth.key);
    const prevMonth = idx >= 0 && idx + 1 < months.length ? months[idx + 1] : null;
    if (!prevMonth || prevMonth.expenses === 0) {
      return 'No data for last month';
    }

    const currentAbs = Math.abs(expensesThisMonth);
    const prevAbs = Math.abs(prevMonth.expenses);
    if (prevAbs === 0) {
      return 'No data for last month';
    }

    const diff = ((currentAbs - prevAbs) / prevAbs) * 100;
    if (!Number.isFinite(diff) || diff === 0) {
      return 'Same as last month';
    }
    const rounded = Math.round(Math.abs(diff));
    return diff > 0
      ? `${rounded}% more than last month`
      : `${rounded}% less than last month`;
  }, [selectedMonth, monthByKey, expensesThisMonth]);

  const summaryCards = [
    {
      label: 'Net balance (month)',
      value: CURRENCY_FORMATTER.format(netThisMonth),
      icon: Wallet,
      delay: 0.1,
    },
    {
      label: 'Income (month)',
      value: CURRENCY_FORMATTER.format(incomeThisMonth),
      icon: ArrowDownLeft,
      delay: 0.15,
      accent: 'text-emerald-400',
      onClick: () => {
        setActiveCategory(null);
        setEditingTxn(null);
        setActionMessage('');
        setShowIncomeDetails((prev) => !prev);
        setTimeout(() => {
          if (incomeDetailsRef.current) {
            incomeDetailsRef.current.scrollIntoView({
              behavior: 'smooth',
              block: 'start',
            });
          }
        }, 0);
      },
    },
    {
      label: 'Expenses (month)',
      value: CURRENCY_FORMATTER.format(Math.abs(expensesThisMonth)),
      icon: ArrowUpRight,
      delay: 0.2,
      accent: 'text-rose-400',
    },
    {
      label: 'Trend vs last month',
      value: trendText,
      icon: TrendingUp,
      delay: 0.25,
    },
  ];

  const activeCategoryData =
    selectedMonth && activeCategory
      ? selectedMonth.categories.get(activeCategory) || {
          name: activeCategory,
          total: 0,
          transactions: [],
        }
      : null;

  const deepDiveTransactions = useMemo(() => {
    if (!activeCategoryData) return [];
    return [...activeCategoryData.transactions].sort((a, b) => {
      const da = a.date instanceof Date ? a.date.getTime() : 0;
      const db = b.date instanceof Date ? b.date.getTime() : 0;
      return db - da;
    });
  }, [activeCategoryData]);

  const incomeTransactions = useMemo(() => {
    if (!selectedMonth) return [];
    const incomeCat = selectedMonth.categories.get('הכנסות');
    if (!incomeCat) return [];
    return [...incomeCat.transactions].sort((a, b) => {
      const da = a.date instanceof Date ? a.date.getTime() : 0;
      const db = b.date instanceof Date ? b.date.getTime() : 0;
      return db - da;
    });
  }, [selectedMonth]);

  const beginEditTransaction = useCallback(
    (txn) => {
      const same =
        editingTxn &&
        (editingTxn.bankTransactionId || editingTxn._index) ===
          (txn.bankTransactionId || txn._index);
      if (same) {
        setEditingTxn(null);
        setActionMessage('');
        return;
      }
      setEditingTxn(txn);
      setEditCategory(txn.category || '');
      setSplitLines([
        {
          amount: Math.abs(txn.amount || 0),
          category: txn.category || '',
          note: '',
        },
      ]);
      setActionMessage('');
    },
    [editingTxn],
  );

  const handleChangeCategory = useCallback(async () => {
    if (!editingTxn || !editCategory) return;
    try {
      setSavingAction(true);
      const resp = await fetch('/api/rules/change-category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankTransactionId: editingTxn.bankTransactionId,
          newCategory: editCategory,
          vendorPattern: editingTxn.description,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      const affected = data.affected ?? 0;
      if (affected > 0) {
        setActionMessage(`Updated ${affected} similar transactions across all months.`);
      } else {
        setActionMessage('Updated transaction.');
      }
      // optimistic update in UI
      setRows((prev) =>
        prev.map((r) =>
          r.bankTransactionId === editingTxn.bankTransactionId
            ? { ...r, category: editCategory }
            : r,
        ),
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    } finally {
      setSavingAction(false);
    }
  }, [editCategory, editingTxn, setRows]);

  const handleSplitSave = useCallback(async () => {
    if (!editingTxn || !splitLines.length) return;
    try {
      setSavingAction(true);
      await fetch('/api/transactions/split', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankTransactionId: editingTxn.bankTransactionId,
          splits: splitLines,
        }),
      });
      // After split, simplest is to reload from sheet on next refresh.
      setEditingTxn(null);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    } finally {
      setSavingAction(false);
    }
  }, [editingTxn, splitLines]);

  const categoryTimeline = useMemo(() => {
    if (!activeCategory) return [];
    return months
      .slice()
      .reverse()
      .map((m) => {
        const cat = m.categories.get(activeCategory);
        const total = cat ? cat.total : 0;
        return {
          key: m.key,
          label: m.label.split(' ')[0], // month name only
          total,
        };
      })
      .filter((d) => d.total > 0);
  }, [months, activeCategory]);

  return (
    <div className="min-h-screen relative">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Header + Month navigation */}
        <motion.header
          className="mb-8 sm:mb-10"
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <div className="glass-card p-2.5">
                <LayoutDashboard className="w-7 h-7 text-white/90" />
              </div>
              <div>
                <h1 className="text-2xl sm:text-3xl font-bold text-white drop-shadow-sm">
                  Finance Dashboard
                </h1>
                <p className="text-white/70 text-sm sm:text-base mt-0.5">
                  Monthly view of your cashflow and categories
                </p>
              </div>
            </div>

            {/* RiseUp-style month strip */}
            <div className="glass-card px-3 py-3 sm:px-4 sm:py-3.5">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-xs sm:text-sm text-white/70">
                  {selectedMonth
                  ? `Showing · ${selectedMonth.label}`
                    : 'No data yet'}
                </p>
                <div className="flex items-center gap-2">
                  {/* Dropdown month selector (6-month view) */}
                  <select
                    className="glass-panel px-2.5 py-1.5 text-[11px] sm:text-xs text-white bg-transparent focus:outline-none cursor-pointer"
                    value={selectedMonthKey || ''}
                    onChange={(e) => setSelectedMonthKey(e.target.value)}
                    disabled={!months.length}
                  >
                    {months.map((m) => (
                      <option
                        key={m.key}
                        value={m.key}
                        className="text-slate-900"
                      >
                        {m.label}
                      </option>
                    ))}
                    {!months.length && <option value="">No data yet</option>}
                  </select>
                  <button
                    type="button"
                    onClick={goToNextMonth}
                    disabled={
                      !months.length ||
                      selectedMonthIndex === -1 ||
                      selectedMonthIndex === months.length - 1
                    }
                    className="glass-panel px-2 py-1 rounded-full text-xs text-white/80 disabled:opacity-40 disabled:cursor-default hover:bg-white/10"
                  >
                    &larr;
                  </button>
                  <button
                    type="button"
                    onClick={goToPrevMonth}
                    disabled={!months.length || selectedMonthIndex <= 0}
                    className="glass-panel px-2 py-1 rounded-full text-xs text-white/80 disabled:opacity-40 disabled:cursor-default hover:bg-white/10"
                  >
                    &rarr;
                  </button>
                </div>
              </div>

              <div className="flex gap-2 overflow-x-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent pb-1">
                {months.map((m, idx) => {
                  const isActive = m.key === selectedMonthKey;
                  const isFuture =
                    months.length && idx < selectedMonthIndex;
                  return (
                    <motion.button
                      key={m.key}
                      type="button"
                      onClick={() => setSelectedMonthKey(m.key)}
                      className={`flex-shrink-0 rounded-full px-3.5 py-1.5 text-xs sm:text-sm border transition-colors ${
                        isActive
                          ? 'bg-white text-slate-900 border-white shadow-sm'
                          : 'bg-white/5 text-white/80 border-white/10 hover:bg-white/12'
                      } ${isFuture ? 'opacity-60' : ''}`}
                      whileTap={{ scale: 0.97 }}
                    >
                      {m.label}
                    </motion.button>
                  );
                })}
                {!months.length && (
                  <span className="text-xs text-white/60">
                    Connect your data to see months here.
                  </span>
                )}
              </div>
            </div>
          </div>
        </motion.header>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-4">
          {summaryCards.map(
            ({ label, value, icon: Icon, delay, accent, onClick }) => {
              const clickable = typeof onClick === 'function';
              const Wrapper = clickable ? 'button' : 'div';
              return (
                <motion.div
                  key={label}
                    className="glass-card p-0 overflow-hidden w-full"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay }}
                >
                  <Wrapper
                    type={clickable ? 'button' : undefined}
                    onClick={clickable ? onClick : undefined}
                    className={`w-full text-left p-5 sm:p-6 ${
                      clickable ? 'hover:bg-white/5 cursor-pointer' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-white/60 text-xs sm:text-sm font-medium">
                          {label}
                        </p>
                        <p
                          className={`text-lg sm:text-2xl font-semibold mt-1 ${accent || 'text-white'}`}
                        >
                          {value}
                        </p>
                      </div>
                      <div className="glass-panel p-2">
                        <Icon
                          className={`w-5 h-5 ${accent || 'text-white/80'}`}
                        />
                      </div>
                    </div>
                  </Wrapper>
                </motion.div>
              );
            },
          )}
        </div>

        {/* Income details panel (opens when clicking Income summary card) */}
        {showIncomeDetails && (
          <motion.section
            ref={incomeDetailsRef}
            className="glass-card p-4 sm:p-6 mb-6"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Income details
                </h2>
                <p className="text-xs text-white/60 mt-0.5">
                  {selectedMonth ? selectedMonth.label : 'No data yet'}
                </p>
              </div>
              {actionMessage && (
                <p className="text-[10px] sm:text-xs text-emerald-300">
                  {actionMessage}
                </p>
              )}
            </div>
            {incomeTransactions.length === 0 ? (
              <p className="text-xs text-white/60">
                No income transactions for this month.
              </p>
            ) : (
              <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
                <div className="grid grid-cols-[auto_1fr_1fr_auto_auto] gap-2 text-[11px] sm:text-xs font-medium text-white/70 bg-white/5 px-3 py-2">
                  <span />
                  <span>Date</span>
                  <span>Description</span>
                  <span>User</span>
                  <span className="text-right">Amount</span>
                </div>
                <div className="max-h-80 overflow-auto divide-y divide-white/10">
                  {incomeTransactions.map((row) => {
                    const isEditingTxn =
                      editingTxn &&
                      (editingTxn.bankTransactionId || editingTxn._index) ===
                        (row.bankTransactionId || row._index);
                    return (
                      <div
                        key={row.bankTransactionId || row._index}
                        className="px-3 py-1.5"
                      >
                        <div className="grid grid-cols-[auto_1fr_1fr_auto_auto] gap-2 items-center text-[11px] sm:text-xs text-white/90">
                          <button
                            type="button"
                            className="p-1 rounded-full hover:bg-white/10 text-white/70"
                            onClick={(e) => {
                              e.stopPropagation();
                              beginEditTransaction(row);
                            }}
                            aria-label="עריכת עסקה"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <span className="truncate">
                            {row.rawDate || ''}
                          </span>
                          <span className="truncate">
                            {row.description || ''}
                          </span>
                          <span
                            className="truncate text-white/75"
                            title={row.userName || row.accountName || row.owner || ''}
                          >
                            {row.userName ||
                              (row.owner && row.accountName
                                ? `${row.owner} · ${row.accountName}`
                                : row.accountName || row.owner || '—')}
                          </span>
                          <span className="text-right font-medium text-emerald-300">
                            {CURRENCY_FORMATTER.format(row.amount ?? 0)}
                          </span>
                        </div>

                        {isEditingTxn && (
                          <div className="mt-1 rounded-md border border-white/20 bg-slate-900/90 px-2 py-2 space-y-2">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div className="space-y-1.5">
                                <p className="text-white/60 text-[10px] uppercase tracking-wide">
                                  Change category
                                </p>
                                <select
                                  className="w-full rounded-md bg-white/10 border border-white/20 px-2 py-1 text-[11px] text-white"
                                  value={editCategory}
                                  onChange={(e) => setEditCategory(e.target.value)}
                                >
                                  <option value="">בחר קטגוריה…</option>
                                  {CATEGORY_OPTIONS.map((c) => (
                                    <option
                                      key={c}
                                      value={c}
                                      className="text-slate-900"
                                    >
                                      {c}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  disabled={!editCategory || savingAction}
                                  onClick={handleChangeCategory}
                                  className="inline-flex items-center justify-center rounded-md bg-sky-500/90 hover:bg-sky-400 px-3 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
                                >
                                  שמור קטגוריה
                                </button>
                              </div>
                              <div className="space-y-1.5">
                                <p className="text-white/60 text-[10px] uppercase tracking-wide">
                                  Split transaction
                                </p>
                                {splitLines.map((line, idx) => (
                                  <div
                                    key={idx}
                                    className="flex items-center gap-2 mb-1"
                                  >
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      className="w-20 rounded-md bg-white/10 border border-white/20 px-1 py-0.5 text-[11px] text-white"
                                      value={line.amount}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setSplitLines((prev) =>
                                          prev.map((p, j) =>
                                            j === idx ? { ...p, amount: v } : p,
                                          ),
                                        );
                                      }}
                                    />
                                    <select
                                      className="flex-1 rounded-md bg-white/10 border border-white/20 px-2 py-0.5 text-[11px] text-white"
                                      value={line.category}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setSplitLines((prev) =>
                                          prev.map((p, j) =>
                                            j === idx ? { ...p, category: v } : p,
                                          ),
                                        );
                                      }}
                                    >
                                      <option value="">קטגוריה…</option>
                                      {CATEGORY_OPTIONS.map((c) => (
                                        <option
                                          key={c}
                                          value={c}
                                          className="text-slate-900"
                                        >
                                          {c}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      type="text"
                                      placeholder="הערה"
                                      className="flex-1 rounded-md bg-white/10 border border-white/20 px-2 py-0.5 text-[11px] text-white"
                                      value={line.note || ''}
                                      onChange={(e) => {
                                        const v = e.target.value;
                                        setSplitLines((prev) =>
                                          prev.map((p, j) =>
                                            j === idx ? { ...p, note: v } : p,
                                          ),
                                        );
                                      }}
                                    />
                                  </div>
                                ))}
                                <div className="flex items-center gap-2 mt-1">
                                  <button
                                    type="button"
                                    className="rounded-md border border-white/30 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10"
                                    onClick={() =>
                                      setSplitLines((prev) => [
                                        ...prev,
                                        {
                                          amount: '',
                                          category: editCategory || '',
                                          note: '',
                                        },
                                      ])
                                    }
                                  >
                                    הוסף חלק
                                  </button>
                                  <button
                                    type="button"
                                    disabled={savingAction}
                                    onClick={handleSplitSave}
                                    className="rounded-md bg-emerald-500/90 hover:bg-emerald-400 px-3 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
                                  >
                                    שמור פיצול
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </motion.section>
        )}

        {/* Categories grid + drill-down inline */}
        <div className="space-y-4">
          {/* Category boxes + per-category drill-down */}
          <motion.section
            className="space-y-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.25 }}
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Spending by category
                </h2>
                <p className="text-xs text-white/60 mt-0.5">
                  Total spent in the selected month, grouped by category
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:gap-4">
              {categories.map((categoryName) => {
                const month = selectedMonth;
                const catData =
                  month?.categories.get(categoryName) || {
                    name: categoryName,
                    total: 0,
                    transactions: [],
                  };
                const share =
                  totalExpensesAbs > 0 && catData.total
                    ? Math.round((catData.total / totalExpensesAbs) * 100)
                    : 0;
                const avg =
                  sixMonthCategoryAverages.get(categoryName) || 0;
                const progressMax = avg > 0 ? avg : catData.total || 0;
                const progressPct =
                  progressMax > 0 && catData.total
                    ? Math.min(100, (catData.total / progressMax) * 100)
                    : 0;

                // Weekly breakdown: 4 weeks within financial month (10th–9th)
                const weekly = [0, 0, 0, 0];
                if (month && catData.transactions.length) {
                  for (const t of catData.transactions) {
                    const d = t.date instanceof Date ? t.date : null;
                    if (!d) continue;
                    const idx = getWeekIndexForDate(new Date(d), month);
                    if (idx == null) continue;
                    const value =
                      categoryName === 'הכנסות'
                        ? Math.max(0, t.amount || 0)
                        : Math.abs(t.amount || 0);
                    weekly[idx] += value;
                  }
                }
                const isActive = activeCategory === categoryName;
                const catTransactions = [...catData.transactions].sort((a, b) => {
                  const da = a.date instanceof Date ? a.date.getTime() : 0;
                  const db = b.date instanceof Date ? b.date.getTime() : 0;
                  return db - da;
                });
                const weekFilteredTransactions =
                  selectedWeekIndex == null
                    ? []
                    : catTransactions.filter((row) => {
                        const d = row.date instanceof Date ? row.date : null;
                        if (!d) return false;
                        const idx = getWeekIndexForDate(new Date(d), month);
                        return idx === selectedWeekIndex;
                      });

              return (
                  <div key={categoryName} className="space-y-2">
                    <button
                      type="button"
                    onClick={() => {
                      setActiveCategory((prev) =>
                        prev === categoryName ? null : categoryName,
                      );
                      setSelectedWeekIndex(null);
                    }}
                      className={`w-full glass-card text-left p-4 sm:p-5 transition ring-0 ${
                        isActive
                          ? 'ring-2 ring-sky-400/80'
                          : 'opacity-90 hover:opacity-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-white truncate">
                          {categoryName}
                        </span>
                        <span className="text-[11px] text-white/60 whitespace-nowrap">
                          {share > 0 ? `${share}% of spend` : '—'}
                        </span>
                      </div>
                      <p className="mt-2 text-lg font-semibold text-rose-200">
                        {CURRENCY_FORMATTER.format(catData.total || 0)}
                      </p>
                      <div className="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            isActive ? 'bg-sky-400' : 'bg-rose-400/80'
                          }`}
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-white/60">
                        {share > 0
                          ? `${share}% of total month · ${catData.transactions.length} tx`
                          : `${catData.transactions.length} tx`}
                      </p>
                      <div className="mt-2 flex justify-between text-[10px] text-white/55">
                        {weekly.map((w, idx) => (
                          <span key={idx}>
                            {`שבוע ${idx + 1}: ${
                              w > 0 ? CURRENCY_FORMATTER.format(w) : '—'
                            }`}
                          </span>
                        ))}
                      </div>
                    </button>

                    {isActive && catTransactions.length > 0 && (
                      <div className="rounded-lg border border-white/15 bg-slate-900/80 px-3 py-2 text-[11px] sm:text-xs text-white/90 space-y-2">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[10px] text-white/60">
                            {selectedMonth?.label} • {categoryName}
                          </p>
                          {actionMessage && (
                            <p className="text-[10px] text-emerald-300">
                              {actionMessage}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2 mb-2">
                          {[0, 1, 2, 3].map((idx) => {
                            const isSelected = selectedWeekIndex === idx;
                            return (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => setSelectedWeekIndex(idx)}
                                className={`px-2.5 py-1 rounded-full text-[10px] border transition-colors ${
                                  isSelected
                                    ? 'border-sky-400 bg-sky-500/20 text-white'
                                    : 'border-white/20 bg-white/5 text-white/80 hover:bg-white/10'
                                }`}
                              >
                                שבוע {idx + 1}
                              </button>
                            );
                          })}
                        </div>
                        {selectedWeekIndex != null && (
                          <>
                            <div className="grid grid-cols-[auto_1fr_1fr_auto_auto] gap-2 font-medium text-white/70 bg-white/5 px-2 py-1 rounded-md">
                              <span />
                              <span>Date</span>
                              <span>Description</span>
                              <span>User</span>
                              <span className="text-right">Amount</span>
                            </div>
                            <div className="max-h-60 overflow-auto divide-y divide-white/10">
                              {weekFilteredTransactions.length === 0 ? (
                                <div className="px-2 py-1.5 text-[11px] text-white/60">
                                  אין עסקאות לשבוע הזה.
                                </div>
                              ) : (
                                weekFilteredTransactions.map((row) => {
                                  const isEditingTxn =
                                    editingTxn &&
                                    (editingTxn.bankTransactionId ||
                                      editingTxn._index) ===
                                      (row.bankTransactionId || row._index);
                                  return (
                                    <div
                                      key={row.bankTransactionId || row._index}
                                      className="px-2 py-1.5"
                                    >
                                      <div className="grid grid-cols-[auto_1fr_1fr_auto_auto] gap-2 items-center">
                                        <button
                                          type="button"
                                          className="p-1 rounded-full hover:bg-white/10 text-white/70"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            beginEditTransaction(row);
                                          }}
                                          aria-label="עריכת עסקה"
                                        >
                                          <Edit3 className="w-3.5 h-3.5" />
                                        </button>
                                        <span className="truncate">
                                          {row.rawDate || ''}
                                        </span>
                                        <span className="truncate">
                                          {row.description || ''}
                                        </span>
                                        <span
                                          className="truncate text-white/75"
                                          title={
                                            row.userName ||
                                            row.accountName ||
                                            row.owner ||
                                            ''
                                          }
                                        >
                                          {row.userName ||
                                            (row.owner && row.accountName
                                              ? `${row.owner} · ${row.accountName}`
                                              : row.accountName ||
                                                row.owner ||
                                                '—')}
                                        </span>
                                        <span
                                          className={`text-right font-medium ${
                                            row.amount < 0
                                              ? 'text-rose-300'
                                              : row.amount > 0
                                                ? 'text-emerald-300'
                                                : 'text-white/80'
                                          }`}
                                        >
                                          {CURRENCY_FORMATTER.format(
                                            row.amount ?? 0,
                                          )}
                                        </span>
                                      </div>

                                      {isEditingTxn && (
                                        <div className="mt-1 rounded-md border border-white/20 bg-slate-900/90 px-2 py-2 space-y-2">
                                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            <div className="space-y-1.5">
                                              <p className="text-white/60 text-[10px] uppercase tracking-wide">
                                                Change category
                                              </p>
                                              <select
                                                className="w-full rounded-md bg-white/10 border border-white/20 px-2 py-1 text-[11px] text-white"
                                                value={editCategory}
                                                onChange={(e) =>
                                                  setEditCategory(
                                                    e.target.value,
                                                  )
                                                }
                                              >
                                                <option value="">
                                                  בחר קטגוריה…
                                                </option>
                                                {CATEGORY_OPTIONS.map((c) => (
                                                  <option
                                                    key={c}
                                                    value={c}
                                                    className="text-slate-900"
                                                  >
                                                    {c}
                                                  </option>
                                                ))}
                                              </select>
                                              <button
                                                type="button"
                                                disabled={
                                                  !editCategory || savingAction
                                                }
                                                onClick={handleChangeCategory}
                                                className="inline-flex items-center justify-center rounded-md bg-sky-500/90 hover:bg-sky-400 px-3 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
                                              >
                                                שמור קטגוריה
                                              </button>
                                            </div>
                                            <div className="space-y-1.5">
                                              <p className="text-white/60 text-[10px] uppercase tracking-wide">
                                                Split transaction
                                              </p>
                                              {splitLines.map((line, idx) => (
                                                <div
                                                  key={idx}
                                                  className="flex items-center gap-2 mb-1"
                                                >
                                                  <input
                                                    type="number"
                                                    min="0"
                                                    step="0.01"
                                                    className="w-20 rounded-md bg-white/10 border border-white/20 px-1 py-0.5 text-[11px] text-white"
                                                    value={line.amount}
                                                    onChange={(e) => {
                                                      const v = e.target.value;
                                                      setSplitLines((prev) =>
                                                        prev.map((p, j) =>
                                                          j === idx
                                                            ? {
                                                                ...p,
                                                                amount: v,
                                                              }
                                                            : p,
                                                        ),
                                                      );
                                                    }}
                                                  />
                                                  <select
                                                    className="flex-1 rounded-md bg-white/10 border border-white/20 px-2 py-0.5 text-[11px] text-white"
                                                    value={line.category}
                                                    onChange={(e) => {
                                                      const v = e.target.value;
                                                      setSplitLines((prev) =>
                                                        prev.map((p, j) =>
                                                          j === idx
                                                            ? {
                                                                ...p,
                                                                category: v,
                                                              }
                                                            : p,
                                                        ),
                                                      );
                                                    }}
                                                  >
                                                    <option value="">
                                                      קטגוריה…
                                                    </option>
                                                    {CATEGORY_OPTIONS.map(
                                                      (c) => (
                                                        <option
                                                          key={c}
                                                          value={c}
                                                          className="text-slate-900"
                                                        >
                                                          {c}
                                                        </option>
                                                      ),
                                                    )}
                                                  </select>
                                                  <input
                                                    type="text"
                                                    placeholder="הערה"
                                                    className="flex-1 rounded-md bg-white/10 border border-white/20 px-2 py-0.5 text-[11px] text-white"
                                                    value={line.note || ''}
                                                    onChange={(e) => {
                                                      const v = e.target.value;
                                                      setSplitLines((prev) =>
                                                        prev.map((p, j) =>
                                                          j === idx
                                                            ? {
                                                                ...p,
                                                                note: v,
                                                              }
                                                            : p,
                                                        ),
                                                      );
                                                    }}
                                                  />
                                                </div>
                                              ))}
                                              <div className="flex items-center gap-2 mt-1">
                                                <button
                                                  type="button"
                                                  className="rounded-md border border-white/30 px-2 py-0.5 text-[11px] text-white/80 hover:bg-white/10"
                                                  onClick={() =>
                                                    setSplitLines((prev) => [
                                                      ...prev,
                                                      {
                                                        amount: '',
                                                        category:
                                                          editCategory || '',
                                                        note: '',
                                                      },
                                                    ])
                                                  }
                                                >
                                                  הוסף חלק
                                                </button>
                                                <button
                                                  type="button"
                                                  disabled={savingAction}
                                                  onClick={handleSplitSave}
                                                  className="rounded-md bg-emerald-500/90 hover:bg-emerald-400 px-3 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
                                                >
                                                  שמור פיצול
                                                </button>
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {!categories.length && (
                <div className="glass-card p-6 text-sm text-white/60">
                  No categorized data yet. Once transactions are synced and
                  categorized, categories will appear here.
                </div>
              )}
            </div>
          </motion.section>
        </div>
      </div>
    </div>
  );
}

