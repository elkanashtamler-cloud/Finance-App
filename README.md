## Family Finance Dashboard (RiseUp-style)

Personal finance dashboard for Israeli bank accounts and credit cards, built as a RiseUp-style alternative.  
The backend syncs transactions from Leumi (credit cards + current account) and Max into a Google Sheet, and the React frontend shows monthly and category-based insights.

---

## Project Structure

- **Backend (Node)** – root folder
  - `sync.js` – main sync engine (scrapes banks, normalizes transactions, writes to Google Sheets).
  - `updateCategories.js` – retroactive categorization for all existing sheet rows using your rules.
  - `cleanupDuplicates.js` – helper script for removing old duplicates if needed.
  - `rulesServer.js` – small Express server that the UI calls to change categories / split transactions and update Google Sheets + `User_Rules`.
- **Frontend (React + Vite)** – `client/`
  - `src/pages/Dashboard.jsx` – main dashboard screen (months, categories, drill-down, edit/split UI).
  - Other standard Vite/React/Tailwind files.

---

## Requirements

- **Node.js** `>= 22.12.0` (matches the `engines` field in `package.json`)
- A **Google Cloud service account** with access to the target Google Sheet.
- A **Google Sheet** with at least:
  - `Transactions` tab – main data store for all transactions.
  - `User_Rules` tab – vendor → category mapping learned from your manual edits.
- Credentials for:
  - Leumi (username/password for online banking).
  - Max (your and your wife's logins, if you want both cards).

---

## Environment Configuration (`.env`)

> **Important:** `.env` is intentionally gitignored. Do **not** commit it.

At the project root, create a `.env` file (based on your existing one) with at least:

```bash
GOOGLE_SHEETS_SPREADSHEET_ID=...        # ID of the Spreadsheet that contains the Transactions tab
GOOGLE_SERVICE_ACCOUNT_EMAIL=...        # Service account email
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="..." # Private key (escaped as a single line)

LEUMI_USERNAME=...
LEUMI_PASSWORD=...

MAX_USERNAME=...          # Your Max login (optional)
MAX_PASSWORD=...
MAX_WIFE_USERNAME=...     # Wife's Max login (optional)
MAX_WIFE_PASSWORD=...
```

If you ever need to share this project, create a **sanitized** `.env.example` (without real secrets) and keep your real `.env` local only.

---

## Installing Dependencies

From the project root:

```bash
# Backend deps (root)
npm install

# Frontend deps
cd client
npm install
```

---

## Running the Sync Engine

From the project root:

```bash
# Using the npm script
npm run sync

# Or directly
node sync.js
```

What it does (high level):

- Logs into **Leumi** and scrapes:
  - Credit cards `5585` and `5544` via Puppeteer (UI scraping).
  - The **current account (עובר ושב)** via `israeli-bank-scrapers`, while:
    - Skipping `חיוב כרטיס` / `חיוב אשראי` rows.
    - Skipping the consolidated `לאומי ויזה(כא)` debit on the 10th (to avoid double counting).
- Logs into **Max** (yours + wife’s) via `israeli-bank-scrapers`.
- Normalizes and categorizes each transaction, assigns:
  - `Owner`, `Account_Name`, `User_Name` (based on card last 4 / source).
  - `Category` using `User_Rules` first, then keyword/category rules.
- Deduplicates using `Date + Description + Amount + User_Name` hash.
- Writes everything into the `Transactions` sheet and prints a summary:
  - `Added X new transactions, Skipped Y duplicates`.

You can add the `--clear` flag to completely clear the `Transactions` tab first if you want a full clean resync (be careful with this in production).

---

## Retroactive Categorization

To re-categorize **all existing rows** in the sheet based on the latest rules:

```bash
node updateCategories.js
```

This script:

- Loads the current `User_Rules` from the sheet.
- Applies your rules to all rows.
- Applies default category logic (including automatic `הכנסות` for positive amounts).
- Uses **batch updates** (`values:batchUpdate`) to avoid Google Sheets quota issues.

---

## Rules & Transactions API (for the Dashboard)

The frontend talks to a small API layer implemented in `rulesServer.js`.

Start it from the root (for example with `node rulesServer.js` or your own script/PM2 profile – adjust as needed based on your local setup):

```bash
node rulesServer.js
```

Endpoints (high level):

- `POST /api/rules/change-category`
  - Body: `{ bankTransactionId, newCategory, vendorPattern }`
  - Updates **all** transactions with the same (normalized) description to the new category.
  - Persists a rule in `User_Rules` for future syncs.
- `POST /api/transactions/split`
  - Body: `{ bankTransactionId, splits: [{ amount, category, note }, ...] }`
  - Sets the original transaction amount to 0 and marks it as `(SPLIT_SOURCE)`.
  - Adds new rows for each split with adjusted amount/category/description.

Adjust ports / CORS in `rulesServer.js` and the frontend service layer if you change any defaults.

---

## Frontend (React Dashboard)

From the `client` folder:

```bash
cd client
npm run dev
```

Then open the printed `http://localhost:5173` URL in your browser.

Key behaviour:

- **Financial months** are defined from the **10th to the 9th**.
- You can select a month from the dropdown / pills at the top.
- Summary cards show:
  - Total expenses, income, etc. for that financial month.
  - `Income (month)` is clickable and opens an inline panel with income details.
- Category boxes:
  - Ordered in the custom Hebrew order you defined.
  - Show:
    - Total spend per category (for the selected month).
    - A progress bar vs. the 6‑month average.
    - Weekly breakdown (Week 1–4; 10th–9th logic).
  - Clicking a category:
    - Expands an inline panel under that category.
    - Lets you choose **Week 1/2/3/4** and then see only that week’s transactions.
- Each transaction has a pencil icon:
  - Clicking it opens an inline editor directly under the row:
    - **Change Category** – saves a rule and optionally updates all similar rows.
    - **Split Transaction** – break one transaction into multiple categorized parts.

---

## What Should Stay Local (Not in Git)

Already covered by `.gitignore`, but important to remember:

- `.env` and any real credentials or keys.
- Any `credentials/` folder or `*service-account*.json`, `*credentials*.json`, `*.secret.json`, `*.key`, etc.
- Logs, screenshots, and Puppeteer debug images (`*.log`, `*.png`, `*.jpg`, etc.).

When in doubt, **do not commit** anything that looks like:

- Passwords / tokens / API keys.
- Raw bank statements or exports.
- Private screenshots of your banking UI.

---

## First-Time Git Init (Optional)

When you are ready to put this on GitHub:

```bash
git init
git add .
git commit -m "Initial commit: family finance dashboard"
git remote add origin <your-repo-url>
git push -u origin main
```

Make sure you have **pushed only safe files** (no `.env`, no credentials) before making the repo public.

