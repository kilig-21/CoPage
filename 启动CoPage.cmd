@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 (
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local.ps1" start
set "COPAGE_LAUNCH_EXIT=%errorlevel%"
popd
echo.
pause
exit /b %COPAGE_LAUNCH_EXIT%
