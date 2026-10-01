param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOut = [IO.Path]::GetFullPath($OutputDirectory)
$taskSourceManifest = Get-Content -LiteralPath (Join-Path $taskRepo 'apps\hana-paper-reader\manifest.json') -Raw | ConvertFrom-Json
if ($taskSourceManifest.manifestVersion -ne 2 -or $taskSourceManifest.id -ne 'hana-paper-reader') {
    throw 'Expected the V2 App source manifest'
}
$taskVersion = [string]$taskSourceManifest.version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid App version' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskResults = @()
$taskChecksumLines = @()
foreach ($taskVariant in @('full-feature', 'reader-only')) {
    $taskName = "app-hana-paper-reader-$taskVersion-$taskVariant-candidate.zip"
    $taskPath = Join-Path $taskOut $taskName
    if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { throw "Missing candidate: $taskName" }
    $taskZip = [IO.Compression.ZipFile]::OpenRead($taskPath)
    try {
        foreach ($taskRequired in @('manifest.json', 'index.js', 'README.md', 'RELEASE-CANDIDATE.json',
            'sdk/app-contract/server-client.js', 'sdk/LICENSE', 'assets/licenses/PDFJS-APACHE-2.0.txt',
            'ui/reader.html', 'ui/assets/build-info.js', 'ui/assets/pdfjs.mjs',
            'ui/assets/cmaps/LICENSE', 'ui/assets/standard_fonts/LICENSE_FOXIT', 'ui/assets/standard_fonts/LICENSE_LIBERATION')) {
            if (-not $taskZip.GetEntry($taskRequired)) { throw "$taskName is missing $taskRequired" }
        }
        $taskReader = [IO.StreamReader]::new($taskZip.GetEntry('manifest.json').Open())
        try { $taskManifest = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
        if ($taskManifest.manifestVersion -ne 2 -or $taskManifest.id -ne 'hana-paper-reader' -or $taskManifest.version -ne $taskVersion) {
            throw "$taskName has an unexpected root manifest"
        }
        $taskReader = [IO.StreamReader]::new($taskZip.GetEntry('RELEASE-CANDIDATE.json').Open())
        try { $taskEnvelope = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
        if ($taskEnvelope.app -ne 'hana-paper-reader' -or $taskEnvelope.version -ne $taskVersion -or
            $taskEnvelope.variant -ne $taskVariant -or $taskEnvelope.verification -ne 'pending-release-acceptance' -or
            $taskEnvelope.installed -ne $false) {
            throw "$taskName has an unexpected candidate envelope"
        }
        $taskReader = [IO.StreamReader]::new($taskZip.GetEntry('ui/assets/build-info.js').Open())
        try { $taskBuildInfo = $taskReader.ReadToEnd() } finally { $taskReader.Dispose() }
        if (-not $taskBuildInfo.Contains('UI_VERSION = "' + $taskVersion + '"')) {
            throw "$taskName has an unexpected UI version"
        }
        $taskPreviewCards = @($taskManifest.contributes.cards | Where-Object { $_.id -eq 'pdf-preview' })
        if ($taskVariant -eq 'full-feature') {
            $taskPreviewers = @($taskManifest.contributes.previewers)
            if ($taskPreviewers.Count -ne 1 -or $taskPreviewers[0].id -ne 'pdf' -or
                $taskPreviewers[0].mode -ne 'read' -or $taskPreviewers[0].route -ne '/pdf-preview.html' -or
                $taskPreviewCards.Count -ne 1 -or -not $taskZip.GetEntry('ui/pdf-preview.html') -or
                -not $taskBuildInfo.Contains('PDF_PREVIEWER_ENABLED = true')) {
                throw "$taskName is missing its read-only PDF pilot contribution"
            }
        } elseif ($taskManifest.contributes.previewers -or $taskPreviewCards.Count -ne 0 -or
            -not $taskBuildInfo.Contains('PDF_PREVIEWER_ENABLED = false')) {
            throw "$taskName unexpectedly declares the PDF pilot"
        }
        $taskCmaps = @($taskZip.Entries | Where-Object { $_.FullName -like 'ui/assets/cmaps/*.bcmap' })
        $taskFonts = @($taskZip.Entries | Where-Object { $_.FullName -match '^ui/assets/standard_fonts/[^/]+\.(pfb|ttf)$' })
        if ($taskCmaps.Count -eq 0 -or $taskFonts.Count -eq 0) { throw "$taskName is missing PDF font resources" }
        $taskEntryCount = @($taskZip.Entries | Where-Object { -not $_.FullName.EndsWith('/') }).Count
    } finally {
        $taskZip.Dispose()
    }
    $taskHash = (Get-FileHash -LiteralPath $taskPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $taskChecksumLines += "$taskHash  $taskName"
    $taskResults += [pscustomobject]@{
        file = $taskName
        variant = $taskVariant
        bytes = (Get-Item -LiteralPath $taskPath).Length
        sha256 = $taskHash
        files = $taskEntryCount
        cMapFiles = $taskCmaps.Count
        standardFontFiles = $taskFonts.Count
        structure = 'passed'
    }
}
$taskReport = [ordered]@{
    app = 'hana-paper-reader'
    version = $taskVersion
    sourceCommit = $env:HANA_SOURCE_COMMIT
    releaseAcceptance = 'pending'
    applicationTests = 'not-run-by-this-workflow'
    nativeAcceptance = 'not-run-by-this-workflow'
    verificationScope = 'V2 ZIP root, declared variant, required assets and licenses, SHA256'
    candidates = $taskResults
}
$taskUtf8 = [Text.UTF8Encoding]::new($false)
$taskNewline = [Environment]::NewLine
[IO.File]::WriteAllText((Join-Path $taskOut 'SHA256SUMS.txt'), ($taskChecksumLines -join $taskNewline) + $taskNewline, $taskUtf8)
[IO.File]::WriteAllText((Join-Path $taskOut 'CANDIDATE-PACKAGE-REPORT.json'), ($taskReport | ConvertTo-Json -Depth 6) + $taskNewline, $taskUtf8)
$taskReport | ConvertTo-Json -Depth 6
