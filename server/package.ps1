# Packages the r1cord server into a distributable zip: the source tree a customer needs,
# plus install.bat. Excludes the venv, downloaded tools, git history, caches and tests.
#
#   powershell -ExecutionPolicy Bypass -File package.ps1 [-OutDir <folder>]
#
# Output: <OutDir>\r1cord-server-<version>.zip  (version read from pyproject.toml)
# Default OutDir is <repo>\dist.

param([string]$OutDir = "")

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path $here "dist" }

$pyproject = Get-Content (Join-Path $here "pyproject.toml") -Raw
if ($pyproject -notmatch '(?m)^version\s*=\s*"([^"]+)"') { throw "no version in pyproject.toml" }
$version = $Matches[1]

$include = @("r1cord_server", "pyproject.toml", "install.bat", "uninstall.bat",
             "start-server.bat", "install-task.ps1", "uninstall-task.ps1", "README.md")
foreach ($item in $include) {
    if (-not (Test-Path (Join-Path $here $item))) { throw "missing from the package list: $item" }
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("r1cord-server-" + [guid]::NewGuid().ToString("N"))
$root = Join-Path $stage "r1cord-server"
New-Item -ItemType Directory -Path $root -Force | Out-Null
try {
    foreach ($item in $include) {
        $src = Join-Path $here $item
        if (Test-Path $src -PathType Container) {
            # /XD and /XF strip caches; robocopy exit codes 0-7 are success.
            robocopy $src (Join-Path $root $item) /E /XD "__pycache__" ".pytest_cache" /XF "*.pyc" /NFL /NDL /NJH /NJS | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $item (exit $LASTEXITCODE)" }
        } else {
            Copy-Item $src (Join-Path $root $item)
        }
    }
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $zip = Join-Path $OutDir "r1cord-server-$version.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path $root -DestinationPath $zip -CompressionLevel Optimal
    $size = [math]::Round((Get-Item $zip).Length / 1KB)
    Write-Host "Packaged r1cord-server $version -> $zip ($size KB)"
    Write-Output $zip
} finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
