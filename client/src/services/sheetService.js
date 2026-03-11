import Papa from 'papaparse';

const CSV_URL = import.meta.env.VITE_SHEET_CSV_URL;

if (!CSV_URL) {
  // This will surface clearly in the console during development
  // so you remember to set the URL.
  // eslint-disable-next-line no-console
  console.warn(
    'VITE_SHEET_CSV_URL is not set. Configure it in your .env file to load sheet data.',
  );
}

function parseAmount(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number') return raw;
  const normalized = String(raw).replace(/,/g, '').trim();
  const value = Number(normalized);
  // NaN → 0 to avoid breaking aggregates
  return Number.isFinite(value) ? value : 0;
}

function parseDate(raw) {
  if (!raw) return null;
  // We expect yyyy-MM-dd from the sync script, but allow more.
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function fetchSheetRows() {
  if (!CSV_URL) {
    return {
      rows: [],
    };
  }

  const response = await fetch(CSV_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch sheet CSV: ${response.status}`);
  }

  const csvText = await response.text();

  const parsed = Papa.parse(csvText, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: true,
  });

  if (parsed.errors?.length) {
    // You could surface details here if needed
    // eslint-disable-next-line no-console
    console.error('Error parsing sheet CSV:', parsed.errors[0]);
  }

  const rawRows = parsed.data || [];

  const rows = rawRows
    .map((row, index) => {
      const date = parseDate(row.Date);
      const amount = parseAmount(row.Amount);

      return {
        _index: index,
        rawDate: row.Date ?? '',
        date,
        description: row.Description ?? '',
        amount,
        category: row.Category ?? '',
        provider: row.Provider ?? '',
        bankTransactionId: row.Bank_Transaction_ID ?? '',
        owner: row.Owner ?? '',
        accountName: row.Account_Name ?? '',
        userName: row.User_Name ?? '',
      };
    })
    // Drop rows that have neither a date nor description nor amount
    .filter(
      (r) =>
        r.rawDate !== '' || r.description !== '' || Number.isFinite(r.amount),
    );

  return { rows };
}

