# Sync & Google Sheet – Environment Variables

## Where the sync writes

- **Spreadsheet ID:** Set in `.env` as `GOOGLE_SHEETS_SPREADSHEET_ID`
- **Tab name:** `Transactions`

## Credentials in `.env` (project root)

Use the **project root** `.env` file (same folder as `sync.js`). Do not commit this file; add it to `.gitignore` if the repo is shared.

### Your credentials (Mine)

- `LEUMI_USERNAME` / `LEUMI_PASSWORD`
- `CAL_USERNAME` / `CAL_PASSWORD`
- `MAX_USERNAME` / `MAX_PASSWORD`

### Wife's credentials (Hers) – separate login = her cards/accounts

If her cards are on a **separate bank/credit login**, add these in the **same `.env` file**:

```env
# Wife's credentials (optional – for syncing her cards)
LEUMI_WIFE_USERNAME=...
LEUMI_WIFE_PASSWORD=...
CAL_WIFE_USERNAME=...
CAL_WIFE_PASSWORD=...
MAX_WIFE_USERNAME=...
MAX_WIFE_PASSWORD=...
```

- Sync runs **both** “Mine” and “Hers” when these are set.
- Each scraped row gets **Owner** = `Mine` or `Hers` and **Account_Name** (e.g. `Cal ****1234`) in the Google Sheet.
- Leave any pair unset if that provider is not used (e.g. no wife Leumi → omit `LEUMI_WIFE_*`).

### Keeping `.env` safe

- Never commit `.env` to git.
- Restrict file permissions if possible (e.g. `chmod 600 .env` on Unix).
- Use one `.env` only; avoid duplicating secrets in other files.
