# Builds the release APK, the device-controls helper, the R1CORD Desktop zip and SHA-256 checksums
# into dist\release\.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1            # app + R1CORD Desktop + checksums
#   powershell -ExecutionPolicy Bypass -File build.ps1 -AppOnly
#   powershell -ExecutionPolicy Bypass -File build.ps1 -ServerOnly  # R1CORD Desktop only
#   powershell -ExecutionPolicy Bypass -File build.ps1 -PlatformKey C:\keys\platform.pk8 -PlatformCert C:\keys\platform.x509.pem
#                                                                   # ...and the device-controls helper
#
# Release signing comes from four properties in %USERPROFILE%\.gradle\gradle.properties
# (R1CORD_STORE_FILE, R1CORD_STORE_PASSWORD, R1CORD_KEY_ALIAS, R1CORD_KEY_PASSWORD).
# Without them the build is unsigned and this script stops rather than producing an APK
# that cannot be installed. R1CORD Desktop needs Node.js 24, desktop\binaries\win32\ffmpeg.exe and
# the published R1CORD and helper APKs in desktop\resources\apk\.
#
# The device-controls helper (R1CORD controls) is built only when both -PlatformKey and
# -PlatformCert are given. They are the PUBLIC AOSP platform test keys, platform.pk8 and
# platform.x509.pem from build/target/product/security in the AOSP source (android13-release:
# https://android.googlesource.com/platform/build/+/refs/heads/android13-release/target/product/security/).
# The helper only works on an Android image signed with those same test keys (a userdebug or
# eng "test-keys" build); on any other image Android refuses its privileges. Keep the key files
# outside the repo. The signed helper must carry the certificate SHA-256 below, or this script
# stops. Needs the Android SDK build-tools (zipalign, apksigner, aapt2). See README.md.

param(
    [switch]$AppOnly,
    [switch]$ServerOnly,
    [string]$PlatformKey,
    [string]$PlatformCert
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = Join-Path $here "desktop"
$out = Join-Path $here "dist\release"
New-Item -ItemType Directory -Path $out -Force | Out-Null

# --- preflight: fail before a long build, not after it -------------------------------------
$buildHelper = $false
if (-not $ServerOnly) {
    if ([bool]$PlatformKey -ne [bool]$PlatformCert) {
        throw "the helper needs both -PlatformKey <platform.pk8> and -PlatformCert <platform.x509.pem>"
    }
    if ($PlatformKey) {
        foreach ($key in $PlatformKey, $PlatformCert) {
            if (-not (Test-Path -LiteralPath $key -PathType Leaf)) { throw "platform key file not found: $key" }
        }
        $PlatformKey = (Resolve-Path -LiteralPath $PlatformKey).Path
        $PlatformCert = (Resolve-Path -LiteralPath $PlatformCert).Path
        # Get-R1BuildTools, Invoke-R1Native and Assert-R1ApkPinned (with the helper's signer pin).
        . (Join-Path $here "scripts\write-manifest.ps1")
        $tools = Get-R1BuildTools
        $buildHelper = $true
    } else {
        Write-Host "Skipping the device-controls helper: pass -PlatformKey <platform.pk8> -PlatformCert <platform.x509.pem>"
        Write-Host "(the public AOSP platform test keys) to build it. See README.md."
    }
}
if (-not $AppOnly) {
    # R1CORD Desktop bundles the official R1CORD and helper APKs for offline USB setup; forge
    # checks their signatures against its pins, so a self-signed R1CORD is refused. See README.md.
    $apkDir = Join-Path $desktopDir "resources\apk"
    $bundled = @(Get-ChildItem $apkDir -File -Filter *.apk -ErrorAction SilentlyContinue | ForEach-Object Name)
    if (-not ($bundled -match '^R1CORD-\d') -or -not ($bundled -match '^R1CORD-controls-')) {
        throw "put the published R1CORD-<version>.apk and R1CORD-controls-<version>.apk in $apkDir (see README.md, Building / running R1CORD Desktop)"
    }
}

if (-not $ServerOnly) {
    $gradle = Get-Content (Join-Path $here "app\build.gradle.kts") -Raw
    if ($gradle -notmatch 'versionName\s*=\s*"([^"]+)"') { throw "no versionName in app\build.gradle.kts" }
    $version = $Matches[1]
    Write-Host "== R1CORD app $version =="

    $props = Join-Path $env:USERPROFILE ".gradle\gradle.properties"
    if (-not (Test-Path $props) -or -not (Select-String -Path $props -Pattern "^R1CORD_STORE_FILE" -Quiet)) {
        throw "release signing is not configured: add R1CORD_STORE_FILE / _STORE_PASSWORD / _KEY_ALIAS / _KEY_PASSWORD to $props"
    }

    $tasks = @(":app:assembleRelease")
    if ($buildHelper) { $tasks += ":device-controls:assembleRelease" }
    Push-Location $here
    try {
        & .\gradlew.bat @tasks --console=plain -q
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

    if ($buildHelper) {
        Write-Host "== R1CORD controls (device-controls helper) =="
        # Its Gradle release build is unsigned: align, then sign with the platform key (v2 + v3).
        $helperDir = Join-Path $here "device-controls\build\outputs\apk\release"
        $unsigned = Join-Path $helperDir "device-controls-release-unsigned.apk"
        if (-not (Test-Path $unsigned)) { throw "no unsigned helper APK at $unsigned" }
        $aligned = Join-Path $helperDir "device-controls-release-aligned.apk"
        $signed = Join-Path $helperDir "device-controls-release-signed.apk"
        $run = Invoke-R1Native $tools.zipalign @("-p", "-f", "4", $unsigned, $aligned)
        if ($run.ExitCode -ne 0) { throw "zipalign failed (exit $($run.ExitCode)):`n$($run.Output)" }
        $run = Invoke-R1Native $tools.apksigner @("sign", "--key", $PlatformKey, "--cert", $PlatformCert,
            "--v1-signing-enabled", "false", "--v2-signing-enabled", "true", "--v3-signing-enabled", "true",
            "--out", $signed, $aligned)
        if ($run.ExitCode -ne 0) { throw "apksigner sign failed for the helper (exit $($run.ExitCode)):`n$($run.Output)" }
        # Package com.chippwalters.r1cord.controls, one signer, certificate SHA-256
        # c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8 (AOSP android13 platform
        # test key). Any other key produces a helper that R1CORD Desktop refuses and the R1 cannot use.
        $helper = Assert-R1ApkPinned $tools "controls" $signed
        $helperName = "R1CORD-controls-$($helper.versionName).apk"
        Copy-Item $signed (Join-Path $out $helperName) -Force
        Write-Host ("Helper: {0} ({1:N1} MB), signer matches the AOSP platform test key" -f $helperName, ($helper.size / 1MB))
    }
}

if (-not $AppOnly) {
    $version = (Get-Content (Join-Path $desktopDir "package.json") -Raw | ConvertFrom-Json).version
    Write-Host "== R1CORD Desktop $version =="
    Push-Location $desktopDir
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)" }
        & npm.cmd run make
        if ($LASTEXITCODE -ne 0) { throw "npm run make failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
    $made = Join-Path $desktopDir "out\make\zip\win32\x64\R1CORD Desktop-win32-x64-$version.zip"
    if (-not (Test-Path $made)) { throw "forge did not produce $made" }
    $zip = Join-Path $out "R1CORD-Desktop-$version-win-x64.zip"
    Copy-Item $made $zip -Force
    Write-Host ("Desktop: {0} ({1:N1} MB)" -f (Split-Path -Leaf $zip), ((Get-Item $zip).Length / 1MB))
}

# Keep one build of each artifact (the app and the helper are told apart by name, not by filter).
foreach ($pattern in '^R1CORD-\d[^\\/]*\.apk$', '^R1CORD-controls-[^\\/]+\.apk$', '^R1CORD-Desktop-[^\\/]+-win-x64\.zip$') {
    Get-ChildItem $out -File | Where-Object { $_.Name -match $pattern } | Sort-Object LastWriteTime -Descending |
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
