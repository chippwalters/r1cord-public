# Sets up the r1cord-server lifecycle for the current user. Explicit, user-run; the server never
# registers itself. Reverse with uninstall-task.ps1.
#
#   powershell -ExecutionPolicy Bypass -File install-task.ps1              # mode from config.toml (default: plug)
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -Mode always
#
#   plug   — no autostart. Double-click start-server.bat after plugging the device in (it opens the
#            admin page); the server exits itself after `idle_exit_min` with no adopted device
#            connected, no admin activity and an idle queue. For USB-only users.
#            (Windows logs no on-by-default event for re-plugging an already-installed device, so
#            "start on plug" would need a permanent WMI subscription — admin-only and flagged by
#            security tools. Not worth it: the resident server idles at ~55 MB and ~0 CPU.)
#   always — Task Scheduler at-logon task, restart on failure, stays resident. For Wi-Fi / tunnel users.
#
# The task runs pythonw (no console window); console output goes to <datastore>\logs\console.log.

param(
    [ValidateSet("plug", "always", "")]
    [string]$Mode = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonw = Join-Path $here ".venv\Scripts\pythonw.exe"
$python = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonw)) {
    throw "venv python not found: $pythonw  (create it: py -3.12 -m venv .venv; .venv\Scripts\python -m pip install -e .)"
}

if ($Mode -eq "") {
    Push-Location $here
    try {
        $Mode = & $python -c "from r1cord_server.config import load; print(load().run_mode)"
    } finally { Pop-Location }
    if ($Mode -notin @("plug", "always")) { throw "could not read run_mode from config.toml (got '$Mode')" }
}

$taskName = "r1cord-server"

if ($Mode -eq "plug") {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed the at-logon task '$taskName'."
    }
    Write-Host "Mode 'plug': no autostart. Plug the device in, then double-click start-server.bat."
    Write-Host "The server exits by itself when nothing has needed it for idle_exit_min minutes."
    exit 0
}

$action = New-ScheduledTaskAction -Execute $pythonw -Argument "-m r1cord_server" -WorkingDirectory $here
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT15S"
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered task '$taskName' (mode 'always') for ${env:USERNAME}: starts at logon, stays resident."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName $taskName"
Write-Host "Admin UI: http://127.0.0.1:<listen_port>/admin  (user admin; password: admin_password in <datastore>\config.toml)"
