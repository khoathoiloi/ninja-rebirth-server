@echo off
title Push Ninja Rebirth Server to GitHub
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\Programs\Git\cmd;%LOCALAPPDATA%\Programs\nodejs;%PATH%"

echo ========================================================
echo       DANG DAY SOURCE CODE LEN GITHUB
echo ========================================================
git status
echo.
echo Dang thuc hien git push origin main...
git push origin main
if %ERRORLEVEL% equ 0 (
    echo.
    echo ========================================================
    echo [THANH CONG] Da day code len GitHub thanh cong!
    echo ========================================================
) else (
    echo.
    echo ========================================================
    echo [LUU Y] Neu can dang nhap hoac nhap Token GitHub:
    echo Hay nhap Personal Access Token hoac dang nhap tai khoan!
    echo ========================================================
)
echo.
pause
