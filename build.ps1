# Builds the release APK, the desktop-companion zip and SHA-256 checksums into dist\release\.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1            # app + server + checksums
#   powershell -ExecutionPolicy Bypass -File build.ps1 -AppOnly
#   powershell -ExecutionPolicy Bypass -File build.ps1 -ServerOnly
#
# Release signing comes from four properties in %USERPROFILE%\.gradle\gradle.properties
# (R1CORD_STORE_FILE, R1CORD_STORE_PASSWORD, R1CORD_KEY_ALIAS, R1CORD_KEY_PASSWORD).
# Without them the build is unsigned and this script stops rather than producing an APK
# that cannot be installed. See README.md.

param(
    [switch]$AppOnly,
    [switch]$ServerOnly
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $here "server"
$out = Join-Path $here "dist\release"
New-Item -ItemType Directory -Path $out -Force | Out-Null

if (-not $ServerOnly) {
    $gradle = Get-Content (Join-Path $here "app\build.gradle.kts") -Raw
    if ($gradle -notmatch 'versionName\s*=\s*"([^"]+)"') { throw "no versionName in app\build.gradle.kts" }
    $version = $Matches[1]
    Write-Host "== R1CORD app $version =="

    $props = Join-Path $env:USERPROFILE ".gradle\gradle.properties"
    if (-not (Test-Path $props) -or -not (Select-String -Path $props -Pattern "^R1CORD_STORE_FILE" -Quiet)) {
        throw "release signing is not configured: add R1CORD_STORE_FILE / _STORE_PASSWORD / _KEY_ALIAS / _KEY_PASSWORD to $props"
    }

    Push-Location $here
    try {
        & .\gradlew.bat assembleRelease --console=plain -q
        if ($LASTEXITCODE -ne 0) { throw "gradle assembleRelease failed ($LASTEXITCODE)" }
    } finally { Pop-Location }

    $apk = Join-Path $here "app\build\outputs\apk\release\app-release.apk"
    if (-not (Test-Path $apk)) { throw "no APK at $apk" }

    # Prove it is signed before anyone downloads it.
    $buildTools = Get-ChildItem (Join-Path $env:LOCALAPPDATA "Android\Sdk\build-tools") -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($buildTools) {
        $verify = & (Join-Path $buildTools.FullName "apksigner.bat") verify --print-certs $apk 2>&1 | Out-String
        if ($verify -notmatch "Signer #1 certificate DN") { throw "APK is not signed:`n$verify" }
        Write-Host "Signature verified."
    } else {
        Write-Warning "apksigner not found - signature not verified."
    }

    Copy-Item $apk (Join-Path $out "R1CORD-$version.apk") -Force
    Write-Host ("App:    R1CORD-{0}.apk ({1:N1} MB)" -f $version, ((Get-Item $apk).Length / 1MB))
}

if (-not $AppOnly) {
    Write-Host "== desktop companion =="
    $zip = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $serverDir "package.ps1") -OutDir $out |
        Select-Object -Last 1
    if (-not (Test-Path $zip)) { throw "server package.ps1 did not produce a zip" }
    Write-Host ("Server: {0} ({1:N0} KB)" -f (Split-Path -Leaf $zip), ((Get-Item $zip).Length / 1KB))
}

# Keep one build of each artifact.
foreach ($pattern in @("R1CORD-*.apk", "r1cord-server-*.zip")) {
    Get-ChildItem $out -Filter $pattern | Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 1 | ForEach-Object { Remove-Item $_.FullName -Force }
}

# Checksums: UTF-8, no BOM, LF endings, so sha256sum-style tools read them correctly.
$lines = Get-ChildItem $out -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" } | Sort-Object Name | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
}
$header = @(
    "# R1CORD downloads - SHA-256 checksums",
    "# Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
    "#",
    "# Verify on Windows:  Get-FileHash .\<file> -Algorithm SHA256"
)
[System.IO.File]::WriteAllText((Join-Path $out "SHA256SUMS.txt"), (($header + $lines) -join "`n") + "`n")

Write-Host ""
Write-Host "Ready in $out"
Get-ChildItem $out -File | ForEach-Object { Write-Host ("  {0,-34} {1,10:N0} KB" -f $_.Name, ($_.Length / 1KB)) }
