@echo off
rem R1CORD server installer (Windows). Run from the unzipped folder. Safe to re-run.
rem
rem   install.bat            CPU transcription (default; nothing else to install)
rem   install.bat --gpu      also install the NVIDIA CUDA runtime (~2 GB) for faster transcription
rem   install.bat --no-start do not start the server at the end
rem
rem What it does: finds (or offers to install) Python 3.12+, creates .venv, installs this package,
rem fetches Google's platform-tools (adb) into tools\ if adb is not already on this PC, writes the
rem first-run config under %LOCALAPPDATA%\R1CORD, adds a Start-menu shortcut, and starts the server.
rem Nothing is installed system-wide except Python (only if you say yes) and the shortcut.

setlocal EnableExtensions
set "HERE=%~dp0"
set "GPU=0"
set "START=1"
for %%A in (%*) do (
    if /I "%%~A"=="--gpu" set "GPU=1"
    if /I "%%~A"=="--no-start" set "START=0"
)
pushd "%HERE%"

echo.
echo === R1CORD server install ===
echo Folder: %HERE%
echo.

rem ---------------------------------------------------------------- Python
set "PY="
py -3.12 -c "import sys" >NUL 2>&1 && set "PY=py -3.12"
if not defined PY py -3.13 -c "import sys" >NUL 2>&1 && set "PY=py -3.13"
if not defined PY python -c "import sys; raise SystemExit(0 if sys.version_info >= (3,12) else 1)" >NUL 2>&1 && set "PY=python"
if defined PY goto have_python

echo Python 3.12 or newer was not found.
set /p "ANSWER=Download and install Python 3.12 from python.org now? [Y/n] "
if /I "%ANSWER%"=="n" (
    echo Install Python 3.12+ from https://www.python.org/downloads/windows/ and run install.bat again.
    goto fail
)
set "PYEXE=%TEMP%\python-3.12.10-amd64.exe"
echo Downloading Python 3.12.10 ...
curl -L -# -o "%PYEXE%" "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" || goto fail
echo Installing Python for the current user (no admin needed) ...
"%PYEXE%" /passive InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0 || goto fail
del "%PYEXE%" >NUL 2>&1
py -3.12 -c "import sys" >NUL 2>&1 && set "PY=py -3.12"
if not defined PY (
    echo Python installed but is not on PATH yet. Close this window, open a new one, run install.bat again.
    goto fail
)

:have_python
for /f "delims=" %%V in ('%PY% -c "import sys; print(sys.version.split()[0])"') do set "PYVER=%%V"
echo Python: %PYVER% (%PY%)

rem ---------------------------------------------------------------- venv + package
if not exist ".venv\Scripts\python.exe" (
    echo Creating .venv ...
    %PY% -m venv .venv || goto fail
)
set "VENV_PY=%HERE%.venv\Scripts\python.exe"
echo Installing the server and its dependencies (faster-whisper etc.) ...
"%VENV_PY%" -m pip install --disable-pip-version-check -q --upgrade pip || goto fail
if "%GPU%"=="1" (
    "%VENV_PY%" -m pip install --disable-pip-version-check -q -e ".[gpu]" || goto fail
    echo GPU runtime installed. Transcription uses CUDA when an NVIDIA GPU is present, CPU otherwise.
) else (
    "%VENV_PY%" -m pip install --disable-pip-version-check -q -e . || goto fail
    echo CPU transcription. Re-run with --gpu for CUDA on an NVIDIA card.
)

rem ---------------------------------------------------------------- adb
set "ADB="
where adb >NUL 2>&1 && set "ADB=adb (on PATH)"
if not defined ADB if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not defined ADB if exist "%HERE%tools\platform-tools\adb.exe" set "ADB=%HERE%tools\platform-tools\adb.exe"
if defined ADB goto have_adb

echo adb (Android platform-tools) not found; downloading from Google ...
if not exist "%HERE%tools" mkdir "%HERE%tools"
set "PTZIP=%TEMP%\platform-tools-latest-windows.zip"
curl -L -# -o "%PTZIP%" "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" || goto fail
tar -xf "%PTZIP%" -C "%HERE%tools" || goto fail
del "%PTZIP%" >NUL 2>&1
if not exist "%HERE%tools\platform-tools\adb.exe" (
    echo platform-tools download did not produce tools\platform-tools\adb.exe
    goto fail
)
set "ADB=%HERE%tools\platform-tools\adb.exe"

:have_adb
echo adb: %ADB%

rem ---------------------------------------------------------------- first-run config
echo Writing first-run config ...
for /f "usebackq delims=" %%C in (`.venv\Scripts\python.exe -c "from r1cord_server.config import load, default_config_path; load(); print(default_config_path())"`) do set "CFG=%%C"
for /f "usebackq delims=" %%D in (`.venv\Scripts\python.exe -c "from r1cord_server.config import load; print(load().datastore)"`) do set "DATA=%%D"
echo Config: %CFG%
echo Data:   %DATA%

rem ---------------------------------------------------------------- Start-menu shortcut
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\R1CORD Server.lnk"
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath = '%HERE%start-server.bat'; $s.WorkingDirectory = '%HERE%'; $s.Description = 'Start the R1CORD server and open its admin page'; $s.Save()" >NUL 2>&1
if exist "%LNK%" echo Start menu: "R1CORD Server"

echo.
echo === Installed ===
echo.
echo Next:
echo   1. On the R1: Settings ^> System ^> Developer options ^> USB debugging ON.
echo   2. Plug the R1 into this PC. Accept "Allow USB debugging" on the device.
echo   3. Start "R1CORD Server" (Start menu) or double-click start-server.bat. The admin page opens.
echo   4. Devices page ^> Adopt. Recordings are pulled and transcribed automatically from then on.
echo.
echo The server exits by itself when idle (run_mode = plug). For a resident server, see README.md.
echo.
if "%START%"=="1" (
    echo Starting the server now ...
    call "%HERE%start-server.bat"
)
popd
endlocal
exit /b 0

:fail
echo.
echo Install failed. See the messages above.
popd
endlocal
pause
exit /b 1
