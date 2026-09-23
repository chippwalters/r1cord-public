# Removes the r1cord-server at-logon task registered by install-task.ps1.
# Does not stop a server that is already running; close its process or window yourself.
#
#   powershell -ExecutionPolicy Bypass -File uninstall-task.ps1

$ErrorActionPreference = "Stop"
$taskName = "r1cord-server"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed task '$taskName'."
} else {
    Write-Host "Task '$taskName' is not registered."
}
