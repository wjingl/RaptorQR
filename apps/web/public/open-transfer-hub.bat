@echo off
setlocal
cd /d "%~dp0"

rem 首选 Windows 自带 PowerShell（无需安装任何东西），随机端口、自动打开浏览器。
where powershell >nul 2>nul
if %errorlevel%==0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
  exit /b %errorlevel%
)

rem 备选：Python 3（与 Linux/macOS 版同一 server.py），随机端口。
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0server.py"
  exit /b %errorlevel%
)

echo Transfer Hub needs PowerShell or Python 3 to start.
echo Please install any one of them, then run this file again.
pause
exit /b 1
