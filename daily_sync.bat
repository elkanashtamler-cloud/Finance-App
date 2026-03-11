@echo off
REM Daily sync: last 7 days, headless, log to sync_log.txt
cd /d "%~dp0"

echo Run at %date% %time% > sync_log.txt
node sync.js --days 7 --headless >> sync_log.txt 2>&1

echo Done. Check sync_log.txt for output.
