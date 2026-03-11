const express = require('express');
const bodyParser = require('body-parser');
const {
  getGoogleDoc,
  getOrCreateTransactionsSheet,
  getOrCreateUserRulesSheet,
} = require('./sync');

const app = express();
const PORT = process.env.RULES_PORT || 4001;

app.use(bodyParser.json());

app.post('/api/rules/change-category', async (req, res) => {
  try {
    const { bankTransactionId, newCategory, vendorPattern } = req.body || {};
    if (!bankTransactionId || !newCategory) {
      return res.status(400).json({ error: 'bankTransactionId and newCategory are required' });
    }

    const doc = await getGoogleDoc();
    const txSheet = await getOrCreateTransactionsSheet(doc);
    const rulesSheet = await getOrCreateUserRulesSheet(doc);

    const [txRows, ruleRows] = await Promise.all([
      txSheet.getRows(),
      rulesSheet.getRows(),
    ]);

    const target = txRows.find(
      (r) => String(r.Bank_Transaction_ID || '').trim() === String(bankTransactionId).trim(),
    );
    const { normalizeDescriptionForRules } = require('./sync');
    const baseDescription = target ? target.Description || '' : '';
    const rawPattern = (vendorPattern || baseDescription) || '';
    const pattern = normalizeDescriptionForRules(rawPattern);

    let affected = 0;

    if (pattern) {
      // Bulk-update all rows with the same description
      // eslint-disable-next-line no-restricted-syntax
      for (const row of txRows) {
        const desc = normalizeDescriptionForRules(row.Description || '');
        if (!desc) continue;
        if (desc.toLowerCase() !== pattern.toLowerCase()) continue;
        if (row.Category === newCategory) continue;
        // eslint-disable-next-line no-await-in-loop
        row.Category = newCategory;
        // eslint-disable-next-line no-await-in-loop
        await row.save();
        affected += 1;
      }
    } else if (target) {
      target.Category = newCategory;
      // eslint-disable-next-line no-await-in-loop
      await target.save();
      affected = 1;
    }

    if (pattern) {
      const existing = ruleRows.find(
        (r) =>
          normalizeDescriptionForRules(r.Vendor_Pattern || '')
            .toLowerCase()
            === pattern.toLowerCase(),
      );
      if (existing) {
        existing.Category = newCategory;
        // eslint-disable-next-line no-await-in-loop
        await existing.save();
      } else {
        await rulesSheet.addRow({
          Vendor_Pattern: pattern,
          Category: newCategory,
          Disabled: '',
          Created_At: new Date().toISOString(),
        });
      }
    }

    return res.json({ ok: true, affected });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('change-category failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/api/transactions/split', async (req, res) => {
  try {
    const { bankTransactionId, splits } = req.body || {};
    if (!bankTransactionId || !Array.isArray(splits) || !splits.length) {
      return res.status(400).json({ error: 'bankTransactionId and splits[] are required' });
    }

    const doc = await getGoogleDoc();
    const txSheet = await getOrCreateTransactionsSheet(doc);
    const rows = await txSheet.getRows();

    const source = rows.find(
      (r) => String(r.Bank_Transaction_ID || '').trim() === String(bankTransactionId).trim(),
    );
    if (!source) {
      return res.status(404).json({ error: 'transaction_not_found' });
    }

    const originalAmount = Number(source.Amount) || 0;
    if (!originalAmount) {
      return res.status(400).json({ error: 'source_amount_zero' });
    }

    const sign = originalAmount < 0 ? -1 : 1;

    const rowsToAdd = [];
    splits.forEach((s, idx) => {
      const part = Number(s.amount) || 0;
      if (!part) return;
      const cat = s.category || source.Category || '';
      const note = s.note || '';

      rowsToAdd.push({
        Date: source.Date,
        Amount: sign * Math.abs(part),
        Description: note ? `${source.Description} (${note})` : source.Description,
        Category: cat,
        Provider: source.Provider,
        Bank_Transaction_ID: `${source.Bank_Transaction_ID || bankTransactionId}#${idx + 1}`,
        Owner: source.Owner,
        Account_Name: source.Account_Name,
        User_Name: source.User_Name,
      });
    });

    if (!rowsToAdd.length) {
      return res.status(400).json({ error: 'no_valid_splits' });
    }

    await txSheet.addRows(rowsToAdd);

    source.Amount = 0;
    source.Category = `${source.Category || ''} (SPLIT_SOURCE)`;
    await source.save();

    return res.json({ ok: true, created: rowsToAdd.length });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('split failed', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Rules server listening on http://localhost:${PORT}`);
});

