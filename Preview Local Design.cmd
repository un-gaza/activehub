@echo off
setlocal
cd /d "%~dp0"
set DATABASE_URL=
set DB_DRIVER=
set DATA_DIR=%~dp0.local\design-preview
set PORT=3004
node scripts/prepare-design-preview.mjs
if errorlevel 1 goto end
echo Local design preview: http://localhost:3004
node server.mjs
:end
pause
endlocal
