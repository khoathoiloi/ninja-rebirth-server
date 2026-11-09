@echo off
title "Private Game Server - GM Admin Panel"
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"

echo Dang giai phong cac cong mang (80, 8080, 9001)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 80,8080,9001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":80 :8080 :9001"') do (
    if not "%%a"=="0" taskkill /F /PID %%a >nul 2>&1
)

echo =======================================================
echo          KHOI CHAY PRIVATE GAME SERVER
echo =======================================================
echo [1] Bang Dieu Khien GM: http://localhost:8080/admin
echo [2] HTTP Game Gateway : http://localhost:80
echo [3] WebSocket Game RPC: ws://localhost:9001/rpc
echo =======================================================
node server.js
pause
