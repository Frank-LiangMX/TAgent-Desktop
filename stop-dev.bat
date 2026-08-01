@echo off
title TAgent-Desktop Dev stop-all
echo ============================================
echo   TAgent-Desktop Dev stop-all
echo ============================================

rem 1) Free Vite dev server port 5174
echo [1/3] Freeing Vite dev server port 5174 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5174 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%p >nul 2>&1
)

rem 2) Close TAgent Electron windows (match command line to avoid killing other apps)
echo [2/3] Closing TAgent Electron windows ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*TAgent-Desktop*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

rem 3) Clean leftover node / bun processes of TAgent
echo [3/3] Cleaning TAgent node / bun leftovers ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','bun.exe') -and $_.CommandLine -like '*TAgent-Desktop*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

timeout /t 1 /nobreak >nul
echo.
echo Done. Port 5174 released, TAgent dev processes cleaned.
pause
