@echo off
rem Removes what install.bat put in place: the venv, downloaded platform-tools, the Start-menu
rem shortcut and the Task Scheduler task. Keeps your config and recordings; their paths are printed.

setlocal EnableExtensions
set "HERE=%~dp0"
pushd "%HERE%"

echo === R1CORD server uninstall ===
schtasks /Query /TN r1cord-server >NUL 2>&1 && (
    schtasks /Delete /TN r1cord-server /F >NUL 2>&1 && echo Removed scheduled task r1cord-server.
)
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\R1CORD Server.lnk"
if exist "%LNK%" del "%LNK%" && echo Removed Start-menu shortcut.

set "DATA="
if exist ".venv\Scripts\python.exe" (
    for /f "usebackq delims=" %%D in (`.venv\Scripts\python.exe -c "from r1cord_server.config import load; print(load().datastore)" 2^>NUL`) do set "DATA=%%D"
)
if exist ".venv" rmdir /s /q ".venv" && echo Removed .venv.
if exist "tools\platform-tools" rmdir /s /q "tools\platform-tools" && echo Removed tools\platform-tools.

echo.
echo Kept (delete yourself if you want them gone):
echo   Config:     %LOCALAPPDATA%\R1CORD\config.toml
if defined DATA echo   Recordings: %DATA%
echo.
popd
endlocal
pause
