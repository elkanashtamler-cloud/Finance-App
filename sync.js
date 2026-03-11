require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { CompanyTypes, createScraper } = require('israeli-bank-scrapers');
const puppeteer = require('puppeteer');
const { format, parseISO, isValid } = require('date-fns');

const {
  GOOGLE_SHEETS_SPREADSHEET_ID,
  LEUMI_USERNAME,
  LEUMI_PASSWORD,
  MAX_USERNAME,
  MAX_PASSWORD,
  // Wife's credentials (separate login = separate cards/accounts)
  LEUMI_WIFE_USERNAME,
  LEUMI_WIFE_PASSWORD,
  MAX_WIFE_USERNAME,
  MAX_WIFE_PASSWORD,
} = process.env;

const TRANSACTIONS_SHEET_TITLE = 'Transactions';
const USER_RULES_SHEET_TITLE = 'User_Rules';

const TRANSACTIONS_HEADERS = [
  'Date',
  'Amount',
  'Description',
  'Category',
  'Provider',
  'Bank_Transaction_ID',
  'Owner',
  'Account_Name',
  'User_Name',
];

// Card ownership mapping by last 4 digits
const CARD_USER_NAME_BY_LAST4 = {
  '5585': 'אלקנה (Leumi)',
  '5544': 'מאיה (Leumi)',
  '5926': 'אלקנה (Max)',
  '7729': 'מאיה (Max)',
  '6213': 'אלקנה (Police Funds)',
};

// Canonical category names (Hebrew)
const CATEGORY_LABELS = {
  INCOME: 'הכנסות',
  FIXED: 'הוצאות קבועות',
  SUPERMARKET: 'סופר',
  EATING_OUT: 'אוכל בחוץ',
  CAR: 'רכב',
  PUBLIC_TRANSPORT: 'תחבורה ציבורית',
  LEISURE: 'פנאי',
  CLOTHING: 'ביגוד והנעלה',
  VARIABLE: 'הוצאות משתנות',
};

/**
 * Manual rule-based categorization.
 *
 * Keys: canonical category name (Hebrew, what will be written to the sheet)
 * Values: array of substrings to look for in the transaction description.
 *
 * Extend this map freely – no AI, just deterministic rules.
 */
const CATEGORY_MAP = {
  // הכנסות
  [CATEGORY_LABELS.INCOME]: [
    'משכורת',
    'שכר עבודה',
    'salary',
    'bit ממ',
    'ביט ממ',
    'העברה מביט',
    'החזר מס',
    'עוקב קרן',
  ],

  // הוצאות קבועות – recurring bills
  [CATEGORY_LABELS.FIXED]: [
    'ביטוח',
    'חברת חשמל',
    'חשמל',
    'מים',
    'ארנונה',
    'עירייה',
    'אינטרנט',
    'טלויזיה',
    'טלוויזיה',
    'יס ',
    'yes ',
    'HOT',
    'פרטנר',
    'Partner',
    'סלקום tv',
    'Cellcom tv',
    'Netflix',
    'נטפליקס',
    'Spotify',
    'ספוטיפיי',
    'Disney+',
    'דיסני+',
  ],

  // סופר – big chains + small groceries
  [CATEGORY_LABELS.SUPERMARKET]: [
    'שופרסל',
    'רמי לוי',
    'יוחננוף',
    'טיב טעם',
    'ויקטורי',
    'אושר עד',
    'חצי חינם',
    'סופרמרקט',
    'סופר מרקט',
    'מכולת',
    'מינימרקט',
    'mini market',
  ],

  // אוכל בחוץ – restaurants, fast food
  [CATEGORY_LABELS.EATING_OUT]: [
    'מסעדה',
    'restaurant',
    'cafe',
    'קפה',
    'בר ',
    'פיצה',
    'burgers',
    'burger',
    'מקדונלדס',
    'מק דונלדס',
    'מקדונלד\'ס',
    'בורגר',
    'שווארמה',
    'פלאפל',
    'sushi',
    'סושי',
    'Wolt',
    'וולט',
    'תן ביס',
    '10bis',
  ],

  // רכב – fuel, repairs, tests, parking
  [CATEGORY_LABELS.CAR]: [
    'פז',
    'סונול',
    'דלק',
    'דור אלון',
    'Ten דלק',
    'ten',
    'מוסך',
    'טסט לרכב',
    'מבחן רישוי',
    'טסט רכב',
    'ביטוח רכב',
    'צמיגים',
    'פנגו',
    'Pango',
    'סלו פנגו',
  ],

  // תחבורה ציבורית – Moovit etc.
  [CATEGORY_LABELS.PUBLIC_TRANSPORT]: [
    'Moovit',
    'מוביט',
    'רכבת ישראל',
    'אגד',
    'דן',
    'מטרופולין',
    'סופרבוס',
  ],

  // פנאי – fun / attractions
  [CATEGORY_LABELS.LEISURE]: [
    'קולנוע',
    'סינמה סיטי',
    'yes planet',
    'יס פלאנט',
    'אטרקציה',
    'פארק מים',
    'קארטינג',
    'escape room',
    'חדר בריחה',
    'לייזר טאג',
    'מוזיאון',
  ],

  // ביגוד והנעלה
  [CATEGORY_LABELS.CLOTHING]: [
    'זארה',
    'H&M',
    'קסטרו',
    'פוקס',
    'אקיוק',
    'adidas',
    'nike',
    'shoes',
    'נעליים',
    'ביגוד',
    'לבוש',
    'next',
    'asos',
    'shein',
    'שיין',
  ],
};

const DEFAULT_CATEGORY = CATEGORY_LABELS.VARIABLE;

function categorizeDescription(description) {
  const text = description ? String(description).toLowerCase() : '';

  for (const [category, keywords] of Object.entries(CATEGORY_MAP)) {
    for (const keyword of keywords) {
      if (!keyword) continue;
      if (text.includes(String(keyword).toLowerCase())) {
        return category;
      }
    }
  }

  return DEFAULT_CATEGORY;
}

async function getGoogleDoc() {
  if (!GOOGLE_SHEETS_SPREADSHEET_ID) {
    throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not set in .env');
  }

  const keyPath = path.resolve(__dirname, 'service-account.json');
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Service account JSON not found at: ${keyPath}`);
  }

  const creds = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

  const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(GOOGLE_SHEETS_SPREADSHEET_ID, auth);
  await doc.loadInfo();
  return doc;
}

async function getOrCreateTransactionsSheet(doc) {
  let sheet = doc.sheetsByTitle[TRANSACTIONS_SHEET_TITLE];

  if (!sheet) {
    sheet = await doc.addSheet({
      title: TRANSACTIONS_SHEET_TITLE,
      headerValues: TRANSACTIONS_HEADERS,
    });
    return sheet;
  }

  await sheet.loadHeaderRow();

  const currentHeaders = sheet.headerValues || [];
  const hasAnyData = sheet.rowCount > 1;
  const hasOwner = currentHeaders.includes('Owner');
  const hasAccountName = currentHeaders.includes('Account_Name');
  const hasUserName = currentHeaders.includes('User_Name');

  if (!hasAnyData && currentHeaders.length === 0) {
    await sheet.setHeaderRow(TRANSACTIONS_HEADERS);
  } else if (!hasAnyData) {
    const sameHeaders =
      currentHeaders.length === TRANSACTIONS_HEADERS.length &&
      currentHeaders.every((h, i) => h === TRANSACTIONS_HEADERS[i]);

    if (!sameHeaders) {
      await sheet.setHeaderRow(TRANSACTIONS_HEADERS);
    }
  } else if (!hasOwner || !hasAccountName || !hasUserName) {
    // Existing sheet missing columns – update header
    await sheet.setHeaderRow(TRANSACTIONS_HEADERS);
  }

  return sheet;
}

async function loadUserRules(doc) {
  const sheet = doc.sheetsByTitle[USER_RULES_SHEET_TITLE];
  if (!sheet) {
    return [];
  }
  await sheet.loadHeaderRow();
  const rows = await sheet.getRows();
  const rules = [];
  for (const row of rows) {
    const pattern = (row.Vendor_Pattern || row.Pattern || '').trim();
    const category = (row.Category || '').trim();
    const disabled =
      String(row.Disabled || '').trim().toLowerCase() === 'true' ||
      String(row.Enabled || '').trim().toLowerCase() === 'false';
    if (!pattern || !category || disabled) continue;
    rules.push({ pattern, category });
  }
  return rules;
}

async function getOrCreateUserRulesSheet(doc) {
  let sheet = doc.sheetsByTitle[USER_RULES_SHEET_TITLE];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: USER_RULES_SHEET_TITLE,
      headerValues: ['Vendor_Pattern', 'Category', 'Disabled', 'Created_At'],
    });
    return sheet;
  }
  await sheet.loadHeaderRow();
  if (!sheet.headerValues || !sheet.headerValues.length) {
    await sheet.setHeaderRow(['Vendor_Pattern', 'Category', 'Disabled', 'Created_At']);
  }
  return sheet;
}

/**
 * Transaction Hash = Date + Description + Amount + User_Name (normalized).
 * Used to deduplicate: same hash => same transaction => do not add again.
 */
function getTransactionHash(dateValue, description, amountValue, userName) {
  const base = buildUniqueTransactionKey(dateValue, description, amountValue);
  const user = userName ? String(userName).trim() : '';
  return [base, user].join('|');
}

/**
 * Reads the entire sheet and returns a Set of existing Transaction Hashes
 * (Date|Description|Amount|User_Name). Used to skip duplicates before adding rows.
 */
async function getExistingTransactionHashes(sheet) {
  const rows = await sheet.getRows();
  const hashes = new Set();

  for (const row of rows) {
    const hash =
      row.Bank_Transaction_ID ||
      getTransactionHash(row.Date, row.Description, row.Amount, row.User_Name);
    if (hash) hashes.add(hash);
  }

  return hashes;
}

/**
 * Base de-dup key (ignores user) used to avoid double-inserting the same
 * transaction when it appears both as "bank movement" and "card transaction".
 * Key = Date + Description + Amount (normalized)
 */
async function getExistingBaseTransactionKeys(sheet) {
  const rows = await sheet.getRows();
  const keys = new Set();
  for (const row of rows) {
    const key = buildUniqueTransactionKey(row.Date, row.Description, row.Amount);
    if (key) keys.add(key);
  }
  return keys;
}

function formatTransactionDate(dateStr) {
  if (!dateStr) return '';
  let d;

  try {
    d = parseISO(dateStr);
  } catch {
    d = new Date(dateStr);
  }

  if (!isValid(d)) {
    return dateStr;
  }

  return format(d, 'yyyy-MM-dd');
}

function normalizeAmountFromTxn(txn, isInstallment) {
  const raw =
    isInstallment && txn.chargedAmount != null
      ? txn.chargedAmount
      : txn.chargedAmount ?? txn.originalAmount ?? 0;

  if (typeof raw === 'number') return raw;
  return normalizeAmountValue(raw);
}

function normalizeAmountValue(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number') return raw;
  let normalized = String(raw)
    .replace(/₪/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Normalize unicode minus to hyphen-minus
  normalized = normalized.replace(/[−‒–—]/g, '-');

  // Handle trailing minus: "123.45-" => "-123.45"
  if (/-$/.test(normalized) && !/^-\d/.test(normalized)) {
    normalized = `-${normalized.replace(/-$/, '').trim()}`;
  }

  // Remove any remaining spaces
  normalized = normalized.replace(/\s+/g, '');

  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

function buildUniqueTransactionKey(dateValue, description, amountValue) {
  const dateStr = dateValue ? String(dateValue).trim() : '';
  const normalizedDescription = (description || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const amount = normalizeAmountValue(amountValue);
  const amountStr = amount.toFixed(2);

  return [dateStr, normalizedDescription, amountStr].join('|');
}

function normalizeDescriptionForRules(description) {
  if (!description) return '';
  let text = String(description)
    .replace(/₪/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Remove tokens that look like pure amounts (numbers with optional comma/decimal and optional minus)
  text = text
    .split(' ')
    .filter((token) => !/^[-−]?\d[\d,\.]*$/.test(token))
    .join(' ');
  return text.trim();
}

/**
 * Build a short label for the account/card (e.g. "Leumi ****12", "Cal ****1234").
 * Scraper account objects typically have accountNumber (or last4Digits).
 */
function getAccountName(providerLabel, account) {
  const num = account.accountNumber || account.last4Digits || '';
  const suffix = num ? ` ****${String(num).slice(-4)}` : '';
  return `${providerLabel}${suffix}`.trim();
}

function getLast4FromAccount(account) {
  const raw = account?.accountNumber || account?.last4Digits || '';
  const s = String(raw);
  return s.slice(-4);
}

function getUserNameForAccount(account) {
  const last4 = getLast4FromAccount(account);
  return CARD_USER_NAME_BY_LAST4[last4] || 'חשבון משותף';
}

function mapTransactionToRow(providerLabel, providerKey, account, txn, ownerLabel = 'Mine') {
  const isInstallment =
    txn.installments && Number(txn.installments.total) > 1;

  let amount = normalizeAmountFromTxn(txn, isInstallment);

  let description = txn.description || '';
  if (isInstallment) {
    const number = txn.installments.number;
    const total = txn.installments.total;
    description = `${description} (${number}/${total})`;
  }

  // Leumi cards UI scraping often yields amounts without sign (sign is visual).
  // For Leumi card last4 5544/5585 we treat amounts as expenses (negative)
  // unless there's an explicit minus or refund/credit hint in the text.
  const accountLast4 = getLast4FromAccount(account);
  if (providerLabel === 'Leumi' && (accountLast4 === '5544' || accountLast4 === '5585')) {
    const rawAmountStr = txn?.chargedAmount != null ? String(txn.chargedAmount) : '';
    const hasExplicitMinus = /-/.test(rawAmountStr) || /-/.test(String(txn?.originalAmount ?? ''));
    const looksLikeRefund = /זיכוי|החזר|Refund|Chargeback/i.test(description);
    if (!hasExplicitMinus && !looksLikeRefund && amount > 0) {
      amount = -amount;
    }
  }

  // Prefer explicit user rules if exist, then fall back to rule engine
  const userCategory = applyUserRules(description);
  let autoCategory;
  if (userCategory) {
    autoCategory = userCategory;
  } else if (amount > 0) {
    autoCategory = CATEGORY_LABELS.INCOME;
  } else {
    autoCategory = categorizeDescription(description);
  }
  const formattedDate = formatTransactionDate(txn.processedDate || txn.date);

  const userName = getUserNameForAccount(account);

  // Transaction Hash = Date + Description + Amount + User_Name (unique string for dedup)
  const transactionHash = getTransactionHash(
    formattedDate,
    description,
    amount,
    userName,
  );
  const accountName = getAccountName(providerLabel, account);

  return {
    Date: formattedDate,
    Amount: amount,
    Description: description,
    Category: autoCategory,
    Provider: providerLabel,
    Bank_Transaction_ID: transactionHash,
    Owner: ownerLabel,
    Account_Name: accountName,
    User_Name: userName,
  };
}

const SCRAPER_NAVIGATION_TIMEOUT_MS = 90000;
const SCRAPER_SELECTOR_TIMEOUT_MS = 90000;
const SMS_MANUAL_WAIT_MS = 5000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrapeBank({
  label,
  providerKey,
  companyId,
  credentials,
  needsSmsPrompt = false,
  ownerLabel = 'Mine',
  filterTxn = null,
  startDateOverride = null,
}) {
  const rows = [];

  try {
    const startDate = startDateOverride
      ? new Date(startDateOverride)
      : (() => {
          const d = new Date();
          d.setMonth(d.getMonth() - 12);
          return d;
        })();

    const scraperOptions = {
      companyId,
      startDate,
      combineInstallments: false,
      showBrowser: true,
    };

    if (needsSmsPrompt) {
      scraperOptions.timeout = SCRAPER_NAVIGATION_TIMEOUT_MS;
      scraperOptions.defaultTimeout = SCRAPER_SELECTOR_TIMEOUT_MS;
    }

    const scraper = createScraper(scraperOptions);

    if (needsSmsPrompt) {
      console.log('Waiting for manual SMS entry... Check the browser window when it opens.');
      await delay(SMS_MANUAL_WAIT_MS);
    }

    const result = await scraper.scrape(credentials);

    if (!result.success) {
      console.error(
        `Scraping failed for ${label}: ${result.errorType} - ${result.errorMessage}`
      );
      return rows;
    }

    for (const account of result.accounts || []) {
      for (const txn of account.txns || []) {
        if (typeof filterTxn === 'function') {
          const keep = filterTxn({ account, txn });
          if (!keep) continue;
        }
        const row = mapTransactionToRow(label, providerKey, account, txn, ownerLabel);
        rows.push(row);
      }
    }

    const accountCount = (result.accounts || []).length;
    console.log(
      `Scraped ${rows.length} transactions from ${label} (${accountCount} account(s), Owner: ${ownerLabel})`
    );
  } catch (err) {
    console.error(`Error scraping ${label}:`, err.message || err);
  }

  return rows;
}

// -------------------------
// Leumi credit cards (UI)
// -------------------------
async function clickByText(page, text, timeoutMs = 45000) {
  const xpath = `//*[self::a or self::button or self::span or self::div][contains(normalize-space(.), "${text}")]`;
  await page.waitForSelector(`xpath/${xpath}`, { timeout: timeoutMs });
  const handles = await page.$$( `xpath/${xpath}` );
  if (!handles.length) throw new Error(`Could not find element with text: ${text}`);
  await handles[0].click();
}

async function scrapeLeumiCardUI({ username, password, monthsBack = 12, last4, headless = false }) {
  const browser = await puppeteer.launch({
    headless: !!headless,
    defaultViewport: null,
  });
  const page = await browser.newPage();

  try {
    // Login (based on israeli-bank-scrapers Leumi flow)
    await page.goto('https://www.leumi.co.il/he', { waitUntil: 'networkidle2' });
    await page.waitForSelector('.enter_account', { timeout: 60000 });
    const loginUrl = await page.$eval('.enter_account', (el) => el.href);
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });

    // The Leumi login flow changes often. Sometimes you must click "כניסה"
    // to reveal/continue the login screen, then submit again after filling fields.
    await Promise.race([
      page.waitForSelector('input[placeholder="שם משתמש"]', { timeout: 60000 }),
      (async () => {
        // best-effort: if there's a "כניסה" button/link shown first, click it
        try {
          await clickByText(page, 'כניסה', 15000);
        } catch {
          // ignore
        }
      })(),
    ]);

    await page.waitForSelector('input[placeholder="שם משתמש"]', { timeout: 60000 });
    await page.click('input[placeholder="שם משתמש"]', { clickCount: 3 });
    await page.type('input[placeholder="שם משתמש"]', username, { delay: 10 });
    await page.click('input[placeholder="סיסמה"]', { clickCount: 3 });
    await page.type('input[placeholder="סיסמה"]', password, { delay: 10 });

    // Submit: prefer explicit "כניסה" button, fallback to type=submit
    const submitted = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const loginBtn = buttons.find((b) => (b.textContent || '').trim() === 'כניסה');
      if (loginBtn) {
        (loginBtn).click();
        return true;
      }
      const submit = document.querySelector("button[type='submit']");
      if (submit) {
        submit.click();
        return true;
      }
      return false;
    });

    if (!submitted) {
      // last resort attempt
      await clickByText(page, 'כניסה', 20000);
    }

    // Wait for post-login SPA to load
    await page.waitForSelector('div.main-content, a[title="דלג לחשבון"]', { timeout: 90000 });

    // Navigate to cards area
    await clickByText(page, 'כרטיסי אשראי');
    await clickByText(page, 'הכרטיסים בחשבון שלי');

    // Select the card from the carousel (must click the card tile itself)
    await delay(1500);
    const cardFound = await page.evaluate((digits) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const clickables = Array.from(document.querySelectorAll('a, button, [role="button"]'));

      // Prefer the card name link like "לאומי ויזה 5585"
      const preferred = clickables.find((el) => {
        const t = norm(el.innerText || el.textContent);
        return t.includes('לאומי') && t.includes('ויזה') && t.includes(digits);
      });
      if (preferred) {
        preferred.click();
        return true;
      }

      // Fallback: any clickable that contains the last4 digits (shortest text wins)
      const candidates = clickables
        .map((el) => ({ el, t: norm(el.innerText || el.textContent) }))
        .filter((x) => x.t && x.t.includes(digits))
        .sort((a, b) => a.t.length - b.t.length);
      if (!candidates.length) return false;
      candidates[0].el.click();
      return true;
    }, last4);

    if (!cardFound) {
      return { found: false, txns: [] };
    }

    // Wait for the card page UI to update (table/tabs should appear)
    await page.waitForFunction(
      (digits) => {
        const txt = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return txt.includes(digits) && (txt.includes('חיובים בשקלים') || txt.includes('תאריך העסקה'));
      },
      { timeout: 30000 },
      last4,
    );
    await delay(1200);

    const parsed = [];

    function normalizeLeumiDateRawToIso(dateRaw) {
      if (!dateRaw) return '';
      const m = String(dateRaw)
        .trim()
        .match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
      if (!m) return String(dateRaw).trim();
      const day = Number(m[1]);
      const month = Number(m[2]);
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      const jsDate = new Date(year, month - 1, day);
      if (Number.isNaN(jsDate.getTime())) return String(dateRaw).trim();
      return format(jsDate, 'yyyy-MM-dd');
    }

    const HEB_MONTHS = [
      'ינואר',
      'פברואר',
      'מרץ',
      'אפריל',
      'מאי',
      'יוני',
      'יולי',
      'אוגוסט',
      'ספטמבר',
      'אוקטובר',
      'נובמבר',
      'דצמבר',
    ];

    async function openMonthDropdown() {
      // In the screenshots this is a dropdown that shows a month label like "אפריל 2026".
      // We prefer clicking the visible month trigger (regex match), then fallback to combobox/select.
      const clicked = await page.evaluate(() => {
        const monthRe =
          /(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s+20\d{2}/;
        const candidates = Array.from(
          document.querySelectorAll(
            '[role="combobox"], [aria-haspopup="listbox"], select, button, a, [role="button"]',
          ),
        );

        for (const el of candidates) {
          const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!raw) continue;
          if (!monthRe.test(raw)) continue;
          el.click();
          return true;
        }

        // Fallback: click the first combobox/select we can find
        const any =
          document.querySelector('[role="combobox"]') ||
          document.querySelector('[aria-haspopup="listbox"]') ||
          document.querySelector('select');
        if (!any) return false;
        (any).click();
        return true;
      });

      if (!clicked) {
        try {
          const debug = await page.evaluate(() => {
            const els = Array.from(
              document.querySelectorAll(
                '[role], [aria-haspopup], select, button, a, [class*="select"], [class*="dropdown"]',
              ),
            ).slice(0, 120);
            return els.map((el) => {
              const role = el.getAttribute('role') || '';
              const hasPopup = el.getAttribute('aria-haspopup') || '';
              const cls = (el.getAttribute('class') || '').split(/\s+/).slice(0, 6).join(' ');
              const txt = ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 60);
              return { role, hasPopup, cls, txt };
            });
          });
          console.log(`[Leumi ${last4}] Month dropdown debug candidates:`, debug.slice(0, 30));
        } catch {
          // ignore
        }
        await page.screenshot({
          path: path.resolve(__dirname, `leumi-${last4}-month-trigger-missing.png`),
          fullPage: true,
        });
        throw new Error('Could not locate month dropdown trigger.');
      }
    }

    async function selectMonthByLabel(monthLabel) {
      console.log(`[Leumi ${last4}] Selecting month: ${monthLabel}`);
      // open dropdown and select the option
      await openMonthDropdown();
      let optionClicked = false;
      try {
        // Prefer clicking inside the opened month menu (not the trigger)
        optionClicked = await page.evaluate((lbl) => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          const monthRe =
            /(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s+20\d{2}/;

          const nodes = Array.from(document.querySelectorAll('body *'))
            .map((el) => ({ el, t: norm(el.innerText || el.textContent) }))
            .filter((x) => x.t && monthRe.test(x.t) && x.t.length <= 30);

          // Find a parent container that contains many month options (opened dropdown list)
          const parentCount = new Map();
          for (const n of nodes) {
            const p = n.el.parentElement;
            if (!p) continue;
            parentCount.set(p, (parentCount.get(p) || 0) + 1);
          }
          const bestParent = Array.from(parentCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

          const scope = bestParent ? Array.from(bestParent.querySelectorAll('*')) : Array.from(document.querySelectorAll('body *'));
          const candidates = scope
            .map((el) => ({ el, t: norm(el.innerText || el.textContent) }))
            .filter((x) => x.t && x.t === lbl);
          const opt = candidates[0]?.el || null;
          if (!opt) return false;
          opt.click();
          return true;
        }, monthLabel);
      } catch {
        // ignore
      }

      if (!optionClicked) {
        // fallback: generic text click (works for some layouts)
        await clickByText(page, monthLabel, 20000);
      }
      // best-effort: ensure UI reflects the chosen month
      try {
        await page.waitForFunction(
          (lbl) => (document.body?.innerText || '').replace(/\s+/g, ' ').includes(lbl),
          { timeout: 15000 },
          monthLabel,
        );
      } catch {
        // ignore (some UIs don't echo the selected label in body text)
      }
    }

    async function extractTableRowsForSelectedMonth() {
      // Extract rows from the table shown in screenshot 3.
      // Map columns by headers:
      // "תאריך העסקה" -> Date
      // "שם בית העסק" -> Description
      // "סכום חיוב" -> Amount
      return await page.evaluate(() => {
        const headerNames = {
          date: 'תאריך העסקה',
          desc: 'שם בית העסק',
          amount: 'סכום חיוב',
        };

        function findTable() {
          const tables = Array.from(document.querySelectorAll('table'));
          for (const table of tables) {
            const ths = Array.from(table.querySelectorAll('th')).map((th) =>
              (th.textContent || '').trim(),
            );
            if (ths.includes(headerNames.date) && ths.includes(headerNames.desc) && ths.includes(headerNames.amount)) {
              return table;
            }
          }
          return null;
        }

        const table = findTable();
        if (table) {
          const ths = Array.from(table.querySelectorAll('th')).map((th) =>
            (th.textContent || '').trim(),
          );
          const dateIdx = ths.indexOf(headerNames.date);
          const descIdx = ths.indexOf(headerNames.desc);
          const amountIdx = ths.indexOf(headerNames.amount);
          if (dateIdx !== -1 && descIdx !== -1 && amountIdx !== -1) {
            const out = [];
            const trs = Array.from(table.querySelectorAll('tbody tr'));
            for (const tr of trs) {
              const tds = Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
              if (!tds.length) continue;
              const dateRaw = tds[dateIdx] || '';
              const description = tds[descIdx] || '';
              const amountRaw = tds[amountIdx] || '';
              if (!dateRaw || !description || !amountRaw) continue;
              out.push({ dateRaw, description, amountRaw });
            }
            if (out.length) return out;
          }
        }

        // Fallback #1: div-based grid (rows with role="row")
        const out = [];
        const rowEls = Array.from(document.querySelectorAll('[role="row"]')).slice(0, 1200);
        for (const rowEl of rowEls) {
          const raw = (rowEl.innerText || rowEl.textContent || '').replace(/\s+/g, ' ').trim();
          if (!raw) continue;
          const dateMatch = raw.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})/);
          if (!dateMatch) continue;
          const dateRaw = dateMatch[1];
          const afterDate = raw.slice(dateMatch.index + dateMatch[0].length);
          const amountMatch = afterDate.match(/([-−]?\s?\d[\d,]*\.\d{2}[-−]?)/);
          if (!amountMatch) continue;
          const amountRaw = amountMatch[1];
          let description = raw
            .replace(dateMatch[0], '')
            .replace(amountRaw, '')
            .replace(/₪/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!description || description.length < 2) continue;
          out.push({ dateRaw, description, amountRaw });
        }
        if (out.length) return out.slice(0, 900);

        // Fallback #2: parse full page text (last resort)
        const textLines = (document.body?.innerText || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const dateRe = /(\d{1,2}\.\d{1,2}\.\d{2,4})/;
        const amountRe = /([-−]?\s?\d[\d,]*\.\d{2}[-−]?)/;
        const out2 = [];
        for (const line of textLines) {
          const dm = line.match(dateRe);
          if (!dm) continue;
          const afterDate = line.slice(dm.index + dm[0].length);
          const am = afterDate.match(amountRe);
          if (!am) continue;
          const dateRaw = dm[1];
          const amountRaw = am[1];
          const description = line
            .replace(dateRe, '')
            .replace(amountRaw, '')
            .replace(/₪/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!description || description.length < 2) continue;
          out2.push({ dateRaw, description, amountRaw });
        }
        return out2.slice(0, 900);
      });
    }

    async function autoScrollForMoreRows() {
      // Many Leumi tables lazy-load rows on scroll. We scroll the main window and any
      // overflow containers to encourage loading.
      for (let i = 0; i < 12; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await page.evaluate(() => {
          const byScrollHeight = (el) => {
            try {
              const before = el.scrollTop;
              el.scrollTop = el.scrollHeight;
              return el.scrollTop !== before;
            } catch {
              return false;
            }
          };

          window.scrollBy(0, window.innerHeight * 0.9);

          const candidates = Array.from(document.querySelectorAll('div, section'))
            .filter((el) => {
              const st = getComputedStyle(el);
              const canScroll =
                (st.overflowY === 'auto' || st.overflowY === 'scroll') &&
                el.scrollHeight > el.clientHeight + 50;
              if (!canScroll) return false;
              const t = (el.innerText || '').replace(/\s+/g, ' ');
              return t.includes('תאריך') && t.includes('סכום');
            })
            .slice(0, 6);
          for (const el of candidates) byScrollHeight(el);
        });
        // eslint-disable-next-line no-await-in-loop
        await delay(600);
      }
    }

    async function getRecentMonthLabels() {
      // Try native <select> first (fast), otherwise open dropdown and read role="option" labels.
      const fromSelect = await page.evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const selects = Array.from(document.querySelectorAll('select'));
        let best = null;
        for (const sel of selects) {
          const opts = Array.from(sel.querySelectorAll('option'))
            .map((o) => norm(o.textContent))
            .filter(Boolean);
          // Heuristic: month list includes a year and Hebrew text, and has enough options
          if (opts.length >= 6 && opts.some((t) => /20\d{2}/.test(t))) {
            best = opts;
            break;
          }
        }
        return best;
      });

      if (Array.isArray(fromSelect) && fromSelect.length) return fromSelect;

      // Custom dropdown: open and read options by text pattern
      await openMonthDropdown();
      await delay(400);
      const fromOptions = await page.evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const monthRe =
          /(ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)\s+20\d{2}/;
        const nodes = Array.from(document.querySelectorAll('body *'))
          .map((el) => ({ el, t: norm(el.innerText || el.textContent) }))
          .filter((x) => x.t && monthRe.test(x.t) && x.t.length <= 30);

        if (!nodes.length) return null;

        const parentCount = new Map();
        for (const n of nodes) {
          const p = n.el.parentElement;
          if (!p) continue;
          parentCount.set(p, (parentCount.get(p) || 0) + 1);
        }
        const bestParent = Array.from(parentCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        const scope = bestParent ? Array.from(bestParent.querySelectorAll('*')) : Array.from(document.querySelectorAll('body *'));
        const texts = scope
          .map((el) => norm(el.innerText || el.textContent))
          .filter((t) => t && monthRe.test(t) && t.length <= 30);
        const unique = [];
        const seen = new Set();
        for (const t of texts) {
          if (seen.has(t)) continue;
          seen.add(t);
          unique.push(t);
        }
        return unique.length ? unique : null;
      });
      return fromOptions || [];
    }

    function parseExpectedMonthFromLabel(label) {
      const yearMatch = String(label).match(/(20\d{2})/);
      const year = yearMatch ? Number(yearMatch[1]) : null;
      const monthIndex = HEB_MONTHS.findIndex((m) => String(label).includes(m));
      return { year, monthIndex: monthIndex === -1 ? null : monthIndex };
    }

    async function fetchMonthByLabel(label) {
      await selectMonthByLabel(label);

      // wait for table to update
      await delay(2000);

      await autoScrollForMoreRows();

      const rows = await extractTableRowsForSelectedMonth();
      const expected = parseExpectedMonthFromLabel(label);
      const inMonthCount = rows.filter((r) => {
        const m = String(r.dateRaw || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
        if (!m) return false;
        const mm = Number(m[2]) - 1;
        const yy = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
        if (expected.year == null || expected.monthIndex == null) return false;
        return yy === expected.year && mm === expected.monthIndex;
      }).length;

      const sample = rows.slice(0, 2).map((r) => `${r.dateRaw} | ${String(r.amountRaw || '').trim()}`).join(' ; ');
      console.log(
        `[Leumi ${last4}] Extracted ${rows.length} rows for ${label} (in-month: ${inMonthCount}) ${sample ? `| sample: ${sample}` : ''}`,
      );

      if (rows.length && expected.year != null && expected.monthIndex != null && inMonthCount === 0) {
        console.log(`[Leumi ${last4}] WARNING: Month switch may have failed for ${label}`);
      }

      for (const t of rows) {
        parsed.push({
          date: t.dateRaw,
          processedDate: normalizeLeumiDateRawToIso(t.dateRaw),
          description: t.description,
          chargedAmount: t.amountRaw,
          originalAmount: t.amountRaw,
        });
      }
    }

    const monthLabels = (await getRecentMonthLabels()).slice(0, monthsBack);
    if (!monthLabels.length) {
      await page.screenshot({
        path: path.resolve(__dirname, `leumi-${last4}-month-options-missing.png`),
        fullPage: true,
      });
      throw new Error('Could not read month options from dropdown.');
    }

    console.log(`[Leumi ${last4}] Month options (first ${monthsBack}):`, monthLabels);

    for (const label of monthLabels) {
      // eslint-disable-next-line no-await-in-loop
      await fetchMonthByLabel(label);
    }

    if (!parsed.length) {
      await page.screenshot({
        path: path.resolve(__dirname, `leumi-${last4}-debug.png`),
        fullPage: true,
      });
    }

    return { found: true, txns: parsed };
  } finally {
    // leave browser open only if debugging is needed
    await browser.close();
  }
}

async function scrapeLeumiCard5544({ username, password, monthsBack = 12, headless = false }) {
  return scrapeLeumiCardUI({ username, password, monthsBack, last4: '5544', headless });
}

async function scrapeLeumiCard5585({ username, password, monthsBack = 12, headless = false }) {
  return scrapeLeumiCardUI({ username, password, monthsBack, last4: '5585', headless });
}

let CURRENT_USER_RULES = [];

function applyUserRules(description) {
  if (!CURRENT_USER_RULES.length) return null;
  const text = normalizeDescriptionForRules(description).toLowerCase();
  if (!text) return null;
  for (const rule of CURRENT_USER_RULES) {
    const pat = normalizeDescriptionForRules(rule.pattern || '').toLowerCase();
    if (!pat) continue;
    if (text.includes(pat)) {
      return rule.category || null;
    }
  }
  return null;
}

function parseDaysArg() {
  const idx = process.argv.findIndex((a) => a === '--days');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  const n = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(n) ? n : null;
}

async function runSync(options = {}) {
  const { clearFirst = false, daysBack = null, headless = false } = options;

  const syncMonthsBack = daysBack != null && daysBack <= 31 ? 1 : 12;
  const bankStartDate =
    daysBack != null && daysBack <= 31
      ? (() => {
          const d = new Date();
          d.setDate(d.getDate() - Math.min(daysBack, 31));
          return d;
        })()
      : null;

  console.log('Starting sync...');
  if (daysBack != null) {
    console.log(`Short sync: last ${daysBack} days (Leumi cards: ${syncMonthsBack} month(s), bank: ${bankStartDate ? daysBack + ' days' : '12 months'})`);
  }
  if (headless) console.log('Running in headless mode (no browser window).');

  const doc = await getGoogleDoc();
  const sheet = await getOrCreateTransactionsSheet(doc);
  CURRENT_USER_RULES = await loadUserRules(doc);
  console.log(
    `Loaded ${CURRENT_USER_RULES.length} user rules from sheet "${USER_RULES_SHEET_TITLE}"`,
  );

  // Tell user exactly where we're writing
  console.log('');
  console.log('--- Sheet location ---');
  console.log('Spreadsheet ID:', GOOGLE_SHEETS_SPREADSHEET_ID);
  console.log('Tab name:', TRANSACTIONS_SHEET_TITLE);
  console.log('------------------------');
  console.log('');

  if (clearFirst) {
    console.log('Clearing sheet (--clear): clearing values in all data rows...');
    // Clear cell values in bulk (avoids per-row delete quota)
    await sheet.clearRows();
    await sheet.setHeaderRow(TRANSACTIONS_HEADERS);
    console.log('Sheet cleared. Header row set.');
  }

  const existingHashes = await getExistingTransactionHashes(sheet);
  const existingBaseKeys = await getExistingBaseTransactionKeys(sheet);

  console.log(
    `Loaded ${existingHashes.size} existing transaction hashes from sheet`
  );

  const allNewRows = [];
  let cardRowsCount = 0;
  let bankRowsCount = 0;

  // Leumi cards (via Leumi website UI)
  if (LEUMI_USERNAME && LEUMI_PASSWORD) {
    for (const last4 of ['5585', '5544']) {
      try {
        console.log(`Scraping Leumi card ${last4} (UI) for last ${syncMonthsBack} month(s)...`);
        const cardResult =
          last4 === '5585'
            ? await scrapeLeumiCard5585({
                username: LEUMI_USERNAME,
                password: LEUMI_PASSWORD,
                monthsBack: syncMonthsBack,
                headless,
              })
            : await scrapeLeumiCard5544({
                username: LEUMI_USERNAME,
                password: LEUMI_PASSWORD,
                monthsBack: syncMonthsBack,
                headless,
              });

        if (cardResult.found && cardResult.txns.length) {
          const account = { accountNumber: last4 };
          const cardRows = cardResult.txns.map((txn) =>
            mapTransactionToRow('Leumi', 'leumi', account, txn, 'Mine'),
          );
          allNewRows.push(...cardRows);
          cardRowsCount += cardRows.length;
          console.log(`Leumi card ${last4} (UI) scraped: ${cardRows.length} txns`);
        } else {
          console.warn(`Leumi card ${last4} (UI): card not found or no transactions extracted.`);
        }
      } catch (err) {
        console.warn(`Leumi card ${last4} (UI) scrape failed:`, err?.message || err);
      }
    }
  } else {
    console.warn('Skipping Leumi cards – credentials not set in .env');
  }

  // Leumi current account (עובר ושב) – general bank movements
  if (LEUMI_USERNAME && LEUMI_PASSWORD) {
    console.log(
      bankStartDate
        ? `Scraping Leumi current account (bank movements) for last ${daysBack} days...`
        : 'Scraping Leumi current account (bank movements) for last 12 months...',
    );
    const leumiBankRows = await scrapeBank({
      label: 'Leumi',
      providerKey: 'leumi',
      companyId: CompanyTypes.leumi,
      credentials: { username: LEUMI_USERNAME, password: LEUMI_PASSWORD },
      needsSmsPrompt: false,
      ownerLabel: 'Joint Bank',
      startDateOverride: bankStartDate || undefined,
      filterTxn: ({ txn }) => {
        const desc = `${txn.description || ''} ${txn.memo || ''}`;
        const normalized = desc.replace(/\s+/g, ' ').trim();
        const lower = normalized.toLowerCase();

        // Skip generic credit-card bill lines
        if (lower.includes('חיוב כרטיס') || lower.includes('חיוב אשראי')) {
          return false;
        }

        // Skip Leumi Visa consolidated charge on the 10th ("לאומי ויזה(כא)")
        // This is the monthly total that already sums all card transactions.
        if (/לאומי\s*ויזה.*\(כא\)/.test(normalized)) {
          return false;
        }

        return true;
      },
    });
    allNewRows.push(...leumiBankRows);
    bankRowsCount += leumiBankRows.length;
    console.log(`Leumi current account scraped: ${leumiBankRows.length} txns (after filtering card bills)`);
  }

  // Max – Mine
  if (MAX_USERNAME && MAX_PASSWORD) {
    const maxRows = await scrapeBank({
      label: 'Max',
      providerKey: 'max',
      companyId: CompanyTypes.max,
      credentials: { username: MAX_USERNAME, password: MAX_PASSWORD },
      needsSmsPrompt: true,
      ownerLabel: 'Mine',
      startDateOverride: bankStartDate || undefined,
    });
    allNewRows.push(...maxRows);
    cardRowsCount += maxRows.length;
  } else {
    console.warn('Skipping Max (Mine) – credentials not set in .env');
  }

  // Max – Hers
  if (MAX_WIFE_USERNAME && MAX_WIFE_PASSWORD) {
    const maxWifeRows = await scrapeBank({
      label: 'Max',
      providerKey: 'max',
      companyId: CompanyTypes.max,
      credentials: { username: MAX_WIFE_USERNAME, password: MAX_WIFE_PASSWORD },
      needsSmsPrompt: true,
      ownerLabel: 'Hers',
      startDateOverride: bankStartDate || undefined,
    });
    allNewRows.push(...maxWifeRows);
    cardRowsCount += maxWifeRows.length;
  }

  console.log(
    `Total scraped rows (before de-dup): ${allNewRows.length}`
  );
  console.log(
    `Breakdown before de-dup – Cards: ${cardRowsCount}, General bank: ${bankRowsCount}`
  );

  // Totals per user (useful even before dedup)
  const totalsByUser = new Map();
  for (const row of allNewRows) {
    const user = row.User_Name || 'חשבון משותף';
    const amount = typeof row.Amount === 'number' ? row.Amount : Number(row.Amount) || 0;
    const current = totalsByUser.get(user) || { count: 0, spent: 0, income: 0, net: 0 };
    current.count += 1;
    if (amount < 0) current.spent += Math.abs(amount);
    if (amount > 0) current.income += amount;
    current.net += amount;
    totalsByUser.set(user, current);
  }

  let added = 0;
  let skipped = 0;
  const rowsToInsert = [];

  for (const row of allNewRows) {
    const hash = row.Bank_Transaction_ID; // Transaction Hash = Date|Description|Amount
    if (!hash) continue;

    if (existingHashes.has(hash)) {
      skipped += 1;
      continue;
    }
    const baseKey = buildUniqueTransactionKey(row.Date, row.Description, row.Amount);
    existingHashes.add(hash);
    existingBaseKeys.add(baseKey);
    rowsToInsert.push(row);
    added += 1;
  }

  if (rowsToInsert.length > 0) {
    await sheet.addRows(rowsToInsert);
  }

  console.log('');
  console.log('--- Totals per user (scraped) ---');
  for (const [user, t] of Array.from(totalsByUser.entries()).sort((a, b) =>
    a[0].localeCompare(b[0], 'he'),
  )) {
    console.log(
      `${user}: ${t.count} tx | spent ₪${t.spent.toFixed(2)} | income ₪${t.income.toFixed(2)} | net ₪${t.net.toFixed(2)}`,
    );
  }
  console.log('--------------------------------');
  console.log('');
  console.log('--- Sync summary ---');
  console.log(`Added ${added} new transactions, Skipped ${skipped} duplicates.`);
  console.log('--------------------');
  console.log('Sync completed.');
}

module.exports = {
  getGoogleDoc,
  getOrCreateTransactionsSheet,
  getOrCreateUserRulesSheet,
  loadUserRules,
  CATEGORY_LABELS,
  USER_RULES_SHEET_TITLE,
};

/**
 * One-off cleanup helper: re-apply CATEGORY_MAP to all existing rows in the sheet.
 * This is safe to run multiple times – it only updates the Category column.
 */
async function forceRecategorizeSheet() {
  console.log('Starting forceRecategorizeSheet – recategorizing all rows...');

  const doc = await getGoogleDoc();
  const sheet = await getOrCreateTransactionsSheet(doc);
  const rows = await sheet.getRows();

  console.log(`Loaded ${rows.length} rows from sheet for recategorization.`);

  let updated = 0;

  for (const row of rows) {
    const description = row.Description || '';
    const newCategory = categorizeDescription(description);

    if (row.Category !== newCategory) {
      row.Category = newCategory;
      // eslint-disable-next-line no-await-in-loop
      await row.save();
      updated += 1;
    }
  }

  console.log(`forceRecategorizeSheet complete. Updated ${updated} rows.`);
}

if (require.main === module) {
  const clearFirst = process.argv.includes('--clear');
  const leumiCardArgIndex = process.argv.findIndex((a) => a === '--leumi-card');
  const leumiCardLast4 =
    leumiCardArgIndex !== -1 ? process.argv[leumiCardArgIndex + 1] : null;

  if (leumiCardLast4 === '5544' || leumiCardLast4 === '5585') {
    (async () => {
      console.log(`Running Leumi card sync for ${leumiCardLast4} (6 months)...`);
      if (!LEUMI_USERNAME || !LEUMI_PASSWORD) {
        throw new Error('Missing LEUMI_USERNAME/LEUMI_PASSWORD in .env');
      }
      const doc = await getGoogleDoc();
      const sheet = await getOrCreateTransactionsSheet(doc);
      const existingHashes = await getExistingTransactionHashes(sheet);
      const existingBaseKeys = await getExistingBaseTransactionKeys(sheet);

      const result =
        leumiCardLast4 === '5585'
          ? await scrapeLeumiCard5585({
              username: LEUMI_USERNAME,
              password: LEUMI_PASSWORD,
              monthsBack: 6,
            })
          : await scrapeLeumiCard5544({
              username: LEUMI_USERNAME,
              password: LEUMI_PASSWORD,
              monthsBack: 6,
            });

      if (!result.found) {
        console.log(`Card ${leumiCardLast4} not found under "הכרטיסים בחשבון שלי".`);
        return;
      }

      console.log(`Found ${result.txns.length} raw transactions for card ${leumiCardLast4} (UI).`);

      const account = { accountNumber: leumiCardLast4 };
      const rows = result.txns.map((txn) =>
        mapTransactionToRow('Leumi', 'leumi', account, txn, 'Mine'),
      );

      let added = 0;
      let skipped = 0;
      const toInsert = [];
      for (const row of rows) {
        const baseKey = buildUniqueTransactionKey(row.Date, row.Description, row.Amount);
        if (existingBaseKeys.has(baseKey)) {
          skipped += 1;
          continue;
        }
        if (existingHashes.has(row.Bank_Transaction_ID)) {
          skipped += 1;
          continue;
        }
        existingBaseKeys.add(baseKey);
        existingHashes.add(row.Bank_Transaction_ID);
        toInsert.push(row);
        added += 1;
      }

      if (toInsert.length) await sheet.addRows(toInsert);
      console.log(`Leumi ${leumiCardLast4} summary: Added ${added}, Skipped ${skipped}.`);
    })().catch((err) => {
      console.error('Fatal error during Leumi card sync:', err);
      process.exit(1);
    });
  } else {
    const daysBack = parseDaysArg();
    const headless = process.argv.includes('--headless');
    runSync({ clearFirst, daysBack: daysBack ?? undefined, headless })
    .then(() => {
      if (clearFirst) {
        console.log('Re-sync after clear finished. Each transaction should appear exactly once.');
      }
    })
    .catch((err) => {
      console.error('Fatal error during sync:', err);
      process.exit(1);
    });
  }
}

module.exports = {
  runSync,
  getGoogleDoc,
  getOrCreateTransactionsSheet,
  getExistingTransactionHashes,
  getTransactionHash,
  categorizeDescription,
  forceRecategorizeSheet,
  normalizeAmountValue,
  buildUniqueTransactionKey,
  normalizeDescriptionForRules,
};

