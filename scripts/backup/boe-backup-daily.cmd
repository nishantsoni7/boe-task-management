@echo off
rem Daily BOE backup + owner reminders. Covers everything merged that day; the two pending-backups lines leave the record of it in the log. Copies to the external drive too when it is plugged in.
rem The exit code is the backup's own (then verify's), never the reminder pop-up's, so Task Scheduler's Last Run Result means something. The start and finish lines in the log carry both codes.
set "LOG=%~dp0..\daily-backup.log"
if exist D:\BOE-Backups set BOE_BACKUP_COPY_TO=D:\BOE-Backups
echo === %DATE% %TIME% BOE backup started >> "%LOG%"
node "%~dp0pending-backups.mjs" >> "%LOG%" 2>&1
node "%~dp0backup-all.mjs" >> "%LOG%" 2>&1
set BACKUP_RC=%ERRORLEVEL%
node "%~dp0verify-backups.mjs" >> "%LOG%" 2>&1
set VERIFY_RC=%ERRORLEVEL%
node "%~dp0pending-backups.mjs" >> "%LOG%" 2>&1
node "%~dp0owner-reminders.mjs" --notify >> "%LOG%" 2>&1
echo === %DATE% %TIME% BOE backup finished: backup-all exit %BACKUP_RC%, verify exit %VERIFY_RC% >> "%LOG%"
if not "%BACKUP_RC%"=="0" exit /b %BACKUP_RC%
exit /b %VERIFY_RC%
