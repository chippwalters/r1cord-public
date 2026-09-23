@echo off
rem R1CORD server launcher.
rem Starts the server (hidden, no window) if it is not already running and opens the admin dashboard.
rem Direct access from this PC needs no login. Set R1CORD_NO_BROWSER=1 to start without opening a page.

setlocal
set "HERE=%~dp0"
set "VENV_PY=%HERE%.venv\Scripts\pythonw.exe"

if not exist "%VENV_PY%" (
    echo [r1cord] not installed yet: run install.bat first.
    pause
    exit /b 1
)

rem Use the same port the server itself uses (config.toml, default 8765).
set "PORT=8765"
pushd "%HERE%"
for /f "usebackq delims=" %%P in (`.venv\Scripts\python.exe -c "from r1cord_server.config import load; print(load().listen_port)" 2^>NUL`) do set "PORT=%%P"
popd
set "URL=http://127.0.0.1:%PORT%/admin"

rem Already running? Any HTTP response (even 401) counts.
curl -s -o NUL "%URL%"
if not errorlevel 1 goto open

start "" "%VENV_PY%" -m r1cord_server

set /a TRIES=30
:wait
curl -s -o NUL "%URL%"
if not errorlevel 1 goto open
set /a TRIES-=1
if %TRIES% leq 0 (
    echo [r1cord] server did not answer on port %PORT% within 30 seconds.
    echo [r1cord] check %%LOCALAPPDATA%%\R1CORD\data\logs\console.log for the error.
    pause
    exit /b 1
)
ping -n 2 127.0.0.1 >NUL
goto wait

:open
if not defined R1CORD_NO_BROWSER start "" "%URL%"
endlocal
