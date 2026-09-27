# Release-channel helpers shared by build.ps1 and scripts\mirror-tailscale.ps1. Dot-source it:
#
#   . (Join-Path $PSScriptRoot "scripts\write-manifest.ps1")
#
# It pins the three APK signers, reads package/version from real APK bytes (aapt2) and signer
# certificates (apksigner), writes the per-folder SHA256SUMS.txt and the signed manifest.json
# that R1CORD Desktop reads from the auto-update folder:
#
#   manifest.json       UTF-8, LF, every entry re-verified against the real file before writing
#   manifest.json.sig   base64 Ed25519 signature over the exact manifest bytes (scripts\sign-manifest.mjs)
#
# The manifest signing key and the platform key stay in %USERPROFILE%\.android-keystores; only
# their paths ever pass through here.

# Signer certificate SHA-256 (lowercase hex of the DER certificate) each APK must carry. R1CORD
# Desktop pins the same values and re-checks them from the APK bytes; a manifest value alone is
# never trusted.
$R1ApkPins = [ordered]@{
    r1cord    = @{ package = "com.chippwalters.r1cord";          cert = "4e92be8e9853f7473f5fe9ed85fde56e2a8dac1280f279b2800861cd5265b7dc" }
    controls  = @{ package = "com.chippwalters.r1cord.controls"; cert = "c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8" }
    tailscale = @{ package = "com.tailscale.ipn";                cert = "5cdb295551bfe1a087fed6acda07141c6c929fa7c29bd273a7092813acc434bf" }
}
$R1ApkFileName = '^[A-Za-z0-9._-]+\.apk$'
$R1SignScript = Join-Path $PSScriptRoot "sign-manifest.mjs"
$R1DefaultManifestKey = Join-Path $env:USERPROFILE ".android-keystores\r1cord-manifest-ed25519.pem"

# Newest Android SDK build-tools with every tool this release needs; throws when none qualifies,
# because an unverified APK must never be published.
function Get-R1BuildTools {
    $root = Join-Path $env:LOCALAPPDATA "Android\Sdk\build-tools"
    $dirs = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+(\.\d+)*$' } | Sort-Object { [version]$_.Name } -Descending
    foreach ($dir in $dirs) {
        $tools = [ordered]@{
            apksigner = Join-Path $dir.FullName "apksigner.bat"
            zipalign  = Join-Path $dir.FullName "zipalign.exe"
            aapt2     = Join-Path $dir.FullName "aapt2.exe"
        }
        if (@($tools.Values | Where-Object { -not (Test-Path $_) }).Count -eq 0) { return $tools }
    }
    throw "no Android build-tools with apksigner, zipalign and aapt2 under $root - install them with the SDK manager"
}

# Runs a native tool with stderr folded into the output. Windows PowerShell turns native stderr
# into terminating errors under $ErrorActionPreference = "Stop"; apksigner warnings must not.
function Invoke-R1Native([string]$Exe, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $lines = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    return [pscustomobject]@{ ExitCode = $code; Output = (@($lines) -join "`n") }
}

# package / versionCode / versionName / minSdk as the package manager will read them.
function Get-R1ApkBadging($Tools, [string]$Apk) {
    $run = Invoke-R1Native $Tools.aapt2 @("dump", "badging", $Apk)
    if ($run.Output -notmatch "(?m)^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'") {
        throw "aapt2 could not read the manifest of $Apk (exit $($run.ExitCode)):`n$($run.Output)"
    }
    $info = [ordered]@{ package = $Matches[1]; versionCode = [long]$Matches[2]; versionName = $Matches[3]; minSdk = $null }
    if ($run.Output -match "(?m)^(?:minSdkVersion|sdkVersion):'(\d+)'") { $info.minSdk = [int]$Matches[1] }
    return $info
}

# Every signer certificate SHA-256 apksigner reports, after a full signature verification.
function Get-R1ApkSignerCerts($Tools, [string]$Apk) {
    $run = Invoke-R1Native $Tools.apksigner @("verify", "--print-certs", $Apk)
    if ($run.ExitCode -ne 0) { throw "apksigner verify failed for $Apk (exit $($run.ExitCode)):`n$($run.Output)" }
    $certs = @([regex]::Matches($run.Output, "(?m)^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})\s*$") |
        ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() } | Select-Object -Unique)
    if ($certs.Count -eq 0) { throw "apksigner printed no signer certificate for $Apk" }
    return $certs
}

# Verifies $Apk is the pinned package signed by exactly the pinned certificate; returns what a
# manifest entry needs. $Key is r1cord, controls or tailscale.
function Assert-R1ApkPinned($Tools, [string]$Key, [string]$Apk) {
    $pin = $R1ApkPins[$Key]
    if (-not $pin) { throw "no signer pin for '$Key'" }
    $badging = Get-R1ApkBadging $Tools $Apk
    if ($badging.package -ne $pin.package) { throw "$Apk is package $($badging.package), expected $($pin.package)" }
    $certs = @(Get-R1ApkSignerCerts $Tools $Apk)
    if ($certs.Count -ne 1 -or $certs[0] -ne $pin.cert) {
        throw "$Apk is signed by $($certs -join ', '), expected the pinned $Key certificate $($pin.cert)"
    }
    $item = Get-Item -LiteralPath $Apk
    return [ordered]@{
        package     = $badging.package
        versionName = $badging.versionName
        versionCode = $badging.versionCode
        minSdk      = $badging.minSdk
        certSha256  = $certs[0]
        size        = [long]$item.Length
        sha256      = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

# A manifest android entry for an APK already inside the auto-update folder.
function New-R1ApkEntry($Tools, [string]$Key, [string]$Apk, [string]$MinDesktop) {
    $name = Split-Path -Leaf $Apk
    if ($name -notmatch $R1ApkFileName) { throw "APK file name '$name' is not a bare [A-Za-z0-9._-]+.apk name" }
    $info = Assert-R1ApkPinned $Tools $Key $Apk
    $entry = [ordered]@{
        package     = $info.package
        versionName = $info.versionName
        versionCode = $info.versionCode
        file        = $name
        size        = $info.size
        sha256      = $info.sha256
        certSha256  = $info.certSha256
    }
    if ($MinDesktop) { $entry.minDesktop = $MinDesktop }
    return $entry
}

# A manifest desktop entry for the R1CORD Desktop zip at $Zip, published at "$PublicBase/<zip name>".
function New-R1DesktopEntry([string]$Version, [string]$Zip, [string]$PublicBase) {
    $name = Split-Path -Leaf $Zip
    return [ordered]@{
        version = $Version
        url     = "$PublicBase/$name"
        size    = [long](Get-Item -LiteralPath $Zip).Length
        sha256  = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
        notes   = "$PublicBase/user-guide.html"
    }
}

# Parsed manifest.json, or $null when the file does not exist. Unreadable JSON throws.
function Read-R1Manifest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

function ConvertTo-R1Ordered($Object) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object }
    $map = [ordered]@{}
    foreach ($p in $Object.PSObject.Properties) { $map[$p.Name] = $p.Value }
    return $map
}

function ConvertTo-R1JsonString([string]$Text) {
    $escaped = $Text.Replace('\', '\\').Replace('"', '\"')
    $escaped = [regex]::Replace($escaped, '[\u0000-\u001f]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    return '"' + $escaped + '"'
}

# Deterministic 2-space JSON for the manifest's value types (maps, strings, integers, booleans).
function ConvertTo-R1Json($Value, [int]$Depth = 0) {
    if ($null -eq $Value) { return "null" }
    if ($Value -is [System.Collections.IDictionary] -or $Value -is [System.Management.Automation.PSCustomObject]) {
        $map = ConvertTo-R1Ordered $Value
        if ($map.Count -eq 0) { return "{}" }
        $pad = "  " * ($Depth + 1)
        $parts = foreach ($k in $map.Keys) { $pad + (ConvertTo-R1JsonString $k) + ": " + (ConvertTo-R1Json $map[$k] ($Depth + 1)) }
        return "{`n" + ($parts -join ",`n") + "`n" + ("  " * $Depth) + "}"
    }
    if ($Value -is [string]) { return ConvertTo-R1JsonString $Value }
    if ($Value -is [bool]) { return $(if ($Value) { "true" } else { "false" }) }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [decimal] -or $Value -is [double]) {
        if ([math]::Truncate([decimal]$Value) -ne [decimal]$Value) { throw "manifest numbers must be integers, got $Value" }
        return ([long]$Value).ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    throw "unsupported manifest value type $($Value.GetType().FullName)"
}

# Throws unless the android entry $Entry describes the pinned file in $Folder byte for byte.
function Assert-R1ApkEntry($Tools, [string]$Key, $Entry, [string]$Folder) {
    $e = ConvertTo-R1Ordered $Entry
    if ("$($e.file)" -notmatch $R1ApkFileName) { throw "manifest android.$Key.file '$($e.file)' is not a bare APK name" }
    $path = Join-Path $Folder $e.file
    if (-not (Test-Path -LiteralPath $path)) { throw "manifest android.$Key names $($e.file), which is not in $Folder" }
    $info = Assert-R1ApkPinned $Tools $Key $path
    foreach ($field in "package", "versionName", "versionCode", "size", "sha256", "certSha256") {
        if ("$($e[$field])" -ne "$($info[$field])") {
            throw "manifest android.$Key.$field is '$($e[$field])' but $($e.file) has '$($info[$field])'"
        }
    }
}

# Throws unless the desktop entry matches the zip of the same name in $Folder.
function Assert-R1DesktopEntry($Entry, [string]$Folder) {
    $e = ConvertTo-R1Ordered $Entry
    $name = ("$($e.url)" -split "/")[-1]
    if ($name -notmatch '^R1CORD-Desktop-[A-Za-z0-9._-]+-win-x64\.zip$') { throw "manifest desktop.url '$($e.url)' does not name a R1CORD Desktop zip" }
    if ($name -ne "R1CORD-Desktop-$($e.version)-win-x64.zip") { throw "manifest desktop.version $($e.version) does not match $name" }
    $path = Join-Path $Folder $name
    if (-not (Test-Path -LiteralPath $path)) { throw "manifest desktop entry names $name, which is not in $Folder - build R1CORD Desktop again" }
    $size = [long](Get-Item -LiteralPath $path).Length
    $sha = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([long]$e.size -ne $size -or "$($e.sha256)" -ne $sha) { throw "manifest desktop entry does not match $path" }
}

# Merges $Android (key -> entry) and $Desktop over the manifest in $Folder, re-verifies every
# entry against the real files, bumps `sequence` past both the previous manifest and
# $SequenceFloor (e.g. the live manifest's), writes manifest.json, signs it with $KeyPath and
# verifies the signature against the pinned public key. With -RequireComplete a manifest missing
# any of r1cord / controls / tailscale / desktop is refused before anything is written.
function Write-R1Manifest {
    param(
        [Parameter(Mandatory)] $Tools,
        [Parameter(Mandatory)] [string]$Folder,
        [Parameter(Mandatory)] [string]$DesktopFolder,
        [System.Collections.IDictionary]$Android = @{},
        $Desktop = $null,
        [long]$SequenceFloor = 0,
        [string]$KeyPath = $R1DefaultManifestKey,
        [switch]$RequireComplete
    )
    $manifestPath = Join-Path $Folder "manifest.json"
    $previous = Read-R1Manifest $manifestPath
    $prevAndroid = if ($previous -and $previous.android) { ConvertTo-R1Ordered $previous.android } else { [ordered]@{} }
    foreach ($k in $prevAndroid.Keys) { if (-not $R1ApkPins.Contains($k)) { throw "previous manifest has unknown android entry '$k'" } }
    foreach ($k in $Android.Keys) { if (-not $R1ApkPins.Contains($k)) { throw "unknown android entry '$k'" } }

    # PowerShell names are case-insensitive: $merged, never $android, or the parameter is clobbered.
    $merged = [ordered]@{}
    foreach ($k in $R1ApkPins.Keys) {
        if ($Android.Contains($k)) { $merged[$k] = ConvertTo-R1Ordered $Android[$k] }
        elseif ($prevAndroid.Contains($k)) { $merged[$k] = ConvertTo-R1Ordered $prevAndroid[$k] }
    }
    $desktopEntry = if ($Desktop) { ConvertTo-R1Ordered $Desktop } elseif ($previous -and $previous.desktop) { ConvertTo-R1Ordered $previous.desktop } else { $null }

    if ($RequireComplete) {
        $missing = @($R1ApkPins.Keys | Where-Object { -not $merged.Contains($_) })
        if (-not $desktopEntry) { $missing += "desktop" }
        if ($missing.Count) { throw "manifest would be missing: $($missing -join ', ')" }
    }
    foreach ($k in $merged.Keys) { Assert-R1ApkEntry $Tools $k $merged[$k] $Folder }
    if ($desktopEntry) { Assert-R1DesktopEntry $desktopEntry $DesktopFolder }

    $prevSequence = if ($previous -and $previous.sequence) { [long]$previous.sequence } else { 0 }
    $manifest = [ordered]@{
        schema      = 1
        sequence    = [math]::Max($prevSequence, $SequenceFloor) + 1
        publishedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($desktopEntry) { $manifest.desktop = $desktopEntry }
    $manifest.android = $merged

    $json = (ConvertTo-R1Json $manifest) + "`n"
    [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding $false))

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "node is not on PATH - it signs manifest.json" }
    $signed = Invoke-R1Native $node.Source @($R1SignScript, $manifestPath, $KeyPath)
    if ($signed.ExitCode -ne 0) { throw "signing manifest.json failed:`n$($signed.Output)" }
    $checked = Invoke-R1Native $node.Source @($R1SignScript, "--verify", $manifestPath)
    if ($checked.ExitCode -ne 0) { throw "manifest.json.sig does not verify:`n$($checked.Output)" }
    Write-Host ("Manifest: sequence {0}, signed and verified ({1})" -f $manifest.sequence, ((@($merged.Keys) + @(if ($desktopEntry) { "desktop" })) -join ", "))
}

# Writes $Folder\SHA256SUMS.txt (UTF-8, no BOM, LF) for every file in $Folder except the
# checksum file itself and the manifest pair, which is signed instead and published last.
# Lines from $CarryFrom files are kept for names not present locally - older APKs that are only
# in the live folder, which is never pruned.
function Write-R1Sha256Sums([string]$Folder, [string]$Title, [string[]]$Include = @("*"), [string[]]$CarryFrom = @()) {
    $skip = "SHA256SUMS.txt", "manifest.json", "manifest.json.sig"
    $entries = [ordered]@{}
    Get-ChildItem -Path (Join-Path $Folder "*") -File -Include $Include | Where-Object { $_.Name -notin $skip } | ForEach-Object {
        $entries[$_.Name] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    foreach ($carry in $CarryFrom) {
        if (-not $carry -or -not (Test-Path -LiteralPath $carry)) { continue }
        foreach ($line in [System.IO.File]::ReadAllLines($carry)) {
            if ($line -match '^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$' -and $Matches[2] -notin $skip -and -not $entries.Contains($Matches[2])) {
                $entries[$Matches[2]] = $Matches[1]
            }
        }
    }
    $lines = $entries.Keys | Sort-Object | ForEach-Object { "{0}  {1}" -f $entries[$_], $_ }
    $header = @(
        "# $Title - SHA-256 checksums",
        "# Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
        "#",
        "# Verify on Windows:  Get-FileHash .\<file> -Algorithm SHA256",
        "# and compare with the matching line below."
    )
    # LF endings: sha256sum-style tools read a stray CR as part of the filename.
    [System.IO.File]::WriteAllText((Join-Path $Folder "SHA256SUMS.txt"), (($header + @($lines)) -join "`n") + "`n")
}
