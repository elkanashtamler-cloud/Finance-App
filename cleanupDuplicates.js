require('dotenv').config();

const {
  getGoogleDoc,
  getOrCreateTransactionsSheet,
} = require('./sync');

const {
  normalizeAmountValue,
  buildUniqueTransactionKey,
} = require('./sync');

async function cleanupDuplicates() {
  console.log('Starting duplicate cleanup...');

  const doc = await getGoogleDoc();
  const sheet = await getOrCreateTransactionsSheet(doc);
  const rows = await sheet.getRows();

  console.log(`Loaded ${rows.length} rows from sheet.`);

  const seen = new Set();
  let deleted = 0;

  // Iterate from oldest to newest so we keep the first occurrence
  for (const row of rows) {
    const key = buildUniqueTransactionKey(
      row.Date,
      row.Description,
      normalizeAmountValue(row.Amount),
    );

    if (seen.has(key)) {
      // exact duplicate (including bank vs credit with same date/amount/description)
      // eslint-disable-next-line no-await-in-loop
      await row.delete();
      deleted += 1;
    } else {
      seen.add(key);
    }
  }

  console.log(`Duplicate cleanup complete. Deleted ${deleted} rows.`);
}

cleanupDuplicates().catch((err) => {
  console.error('Error during duplicate cleanup:', err);
  process.exit(1);
});

