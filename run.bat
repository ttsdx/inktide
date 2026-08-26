@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>&1
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 https://nodejs.org/ 后再双击本脚本。
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo 未检测到 npm，请重新安装 Node.js 并勾选 npm。
  pause
  exit /b 1
)

echo 正在安装依赖...
call npm install
if errorlevel 1 (
  echo 依赖安装失败。
  pause
  exit /b 1
)

echo 正在启动开发服务器 http://127.0.0.1:43117
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://127.0.0.1:43117"
call npm run dev
if errorlevel 1 (
  echo 启动失败。
  pause
  exit /b 1
)

pause
endlocal
