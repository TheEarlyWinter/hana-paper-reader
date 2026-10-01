param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$StagingDirectory
)
$ErrorActionPreference = 'Stop'
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOut = [IO.Path]::GetFullPath($OutputDirectory)
$taskStage = [IO.Path]::GetFullPath($StagingDirectory)
New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
New-Item -ItemType Directory -Path $taskStage -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskResults = @()
foreach ($taskPilot in @($false, $true)) {
    $taskArgs = @((Join-Path $taskRepo 'tools\stage-release.mjs'), '--out', $taskStage)
    if (-not $taskPilot) { $taskArgs += '--reader-only' }
    $taskResultText = & node @taskArgs
    if ($LASTEXITCODE -ne 0) { throw 'Candidate staging failed. This command does not perform validation.' }
    $taskResult = $taskResultText | ConvertFrom-Json
    $taskVariant = if ($taskPilot) { 'full-feature-candidate' } else { 'reader-only-candidate' }
    $taskZip = Join-Path $taskOut "app-hana-paper-reader-$($taskResult.version)-$taskVariant.zip"
    if (Test-Path -LiteralPath $taskZip) { throw "Candidate archive already exists: $taskZip" }
    [IO.Compression.ZipFile]::CreateFromDirectory($taskResult.staging, $taskZip, [IO.Compression.CompressionLevel]::Optimal, $false)
    $taskResults += [PSCustomObject]@{
        archive = $taskZip
        version = $taskResult.version
        variant = $taskResult.variant
        verification = $taskResult.verification
        installed = $false
    }
}
$taskResults | ConvertTo-Json -Depth 4
