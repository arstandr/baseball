@echo off
:loop
title The Closer - Money Tree 2.0
cd /d "/Users/adamstandridge/Desktop/projects/baseball"
echo.
echo  THE CLOSER - Money Tree 2.0
echo.
node scripts/closer/launcher.js
echo.
echo  The Closer restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
