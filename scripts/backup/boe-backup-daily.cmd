@echo off
rem Daily BOE backup + owner reminders. Copies to the external drive too when it is plugged in.
if exist D:\BOE-Backups set BOE_BACKUP_COPY_TO=D:\BOE-Backups
node "%~dp0backup-all.mjs" >> "%~dp0..\daily-backup.log" 2>&1
node "%~dp0verify-backups.mjs" >> "%~dp0..\daily-backup.log" 2>&1
node "%~dp0owner-reminders.mjs" --notify >> "%~dp0..\daily-backup.log" 2>&1
