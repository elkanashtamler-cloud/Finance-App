require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { JWT } = require('google-auth-library');

const {
  getGoogleDoc,
  getOrCreateTransactionsSheet,
  categorizeDescription,
  normalizeDescriptionForRules,
} = require('./sync');

const USER_RULES_SHEET_TITLE = 'User_Rules';
const { GOOGLE_SHEETS_SPREADSHEET_ID } = process.env;

async function loadUserRules(doc) {
  const sheet = doc.sheetsByTitle[USER_RULES_SHEET_TITLE];
  if (!sheet) return [];
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

function getCategoryFromUserRules(description, rules) {
  if (!description || !rules.length) return null;
  const text = normalizeDescriptionForRules(description).toLowerCase();
  for (const rule of rules) {
    const pat = normalizeDescriptionForRules(rule.pattern || '').toLowerCase();
    if (!pat) continue;
    if (text.includes(pat)) {
      return rule.category || null;
    }
  }
  return null;
}

async function createSheetsAuth() {
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
  await auth.authorize();
  return auth;
}

async function updateExistingCategories() {
  console.log('Starting category backfill for existing rows (batched)...');

  const doc = await getGoogleDoc();
  const sheet = await getOrCreateTransactionsSheet(doc);
  const userRules = await loadUserRules(doc);
  console.log(
    `Loaded ${userRules.length} user rules from "${USER_RULES_SHEET_TITLE}"`,
  );
  const rows = await sheet.getRows();

  console.log(`Loaded ${rows.length} rows from sheet.`);

  const changes = [];

  for (const row of rows) {
    const description = row.Description || '';
    const amount = Number(row.Amount) || 0;
    const userCategory = getCategoryFromUserRules(description, userRules);
    let newCategory;
    if (userCategory) {
      newCategory = userCategory;
    } else if (amount > 0) {
      newCategory = 'הכנסות';
    } else {
      newCategory = categorizeDescription(description);
    }

    if (row.Category !== newCategory) {
      changes.push({
        rowNumber: row._rowNumber,
        Date: row.Date,
        Amount: row.Amount,
        Description: row.Description,
        Category: newCategory,
        Provider: row.Provider,
        Bank_Transaction_ID: row.Bank_Transaction_ID,
        Owner: row.Owner,
        Account_Name: row.Account_Name,
        User_Name: row.User_Name,
      });
    }
  }

  if (!changes.length) {
    console.log('No category changes needed.');
    return;
  }

  console.log(`Preparing batch update for ${changes.length} rows...`);

  const auth = await createSheetsAuth();
  const batchSize = 100;

  for (let i = 0; i < changes.length; i += batchSize) {
    const chunk = changes.slice(i, i + batchSize);
    const data = chunk.map((ch) => ({
      range: `'Transactions'!A${ch.rowNumber}:I${ch.rowNumber}`,
      majorDimension: 'ROWS',
      values: [
        [
          ch.Date || '',
          ch.Amount ?? '',
          ch.Description || '',
          ch.Category || '',
          ch.Provider || '',
          ch.Bank_Transaction_ID || '',
          ch.Owner || '',
          ch.Account_Name || '',
          ch.User_Name || '',
        ],
      ],
    }));

    // eslint-disable-next-line no-await-in-loop
    await auth.request({
      url: `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEETS_SPREADSHEET_ID}/values:batchUpdate`,
      method: 'POST',
      data: {
        valueInputOption: 'USER_ENTERED',
        data,
      },
    });

    console.log(
      `Batch ${i / batchSize + 1} – updated ${chunk.length} rows (total so far: ${
        i + chunk.length
      }/${changes.length})`,
    );
  }

  console.log('Category backfill completed with batch updates.');
}

updateExistingCategories().catch((err) => {
  console.error('Error while updating categories:', err);
  process.exit(1);
});

