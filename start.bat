@echo off
title Masala Mafia Billing
cd /d "%~dp0"
echo.
echo  ==== MASALA MAFIA BILLING ====
echo.
echo  Checking files (first time can take a minute)...
call npm install --omit=dev --no-audit --no-fund >nul 2>&1
echo.
echo  On this computer open:   http://localhost:3000
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo  Phones on same WiFi open: http://%%a:3000
echo.
echo  KEEP THIS WINDOW OPEN while the shop is using the software.
echo  To stop it, close this window.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
node --no-warnings server.js
echo.
echo  The software stopped. If you see an error above, take a photo and send it.
pause
