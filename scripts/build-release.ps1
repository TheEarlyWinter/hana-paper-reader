[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$OutputDir = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ManifestPath = Join-Path $RepoRoot "manifest.json"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = [string]$Manifest.version }
if ($Version -ne [string]$Manifest.version) {
  throw "Requested version $Version does not match manifest version $($Manifest.version)."
}
if (-not $OutputDir) { $OutputDir = Split-Path $RepoRoot -Parent }
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$BaseName = "hana-paper-reader-$Version"
$ZipPath = Join-Path $OutputDir "$BaseName.zip"
$HashPath = Join-Path $OutputDir "$BaseName.sha256"
$QaPath = Join-Path $OutputDir "$BaseName-QA.md"
$ReleaseNotesPath = Join-Path $RepoRoot "RELEASE_NOTES_$Version.md"
foreach ($target in @($ZipPath, $HashPath, $QaPath)) {
  if (Test-Path -LiteralPath $target) {
    if (-not $Force) { throw "Release artifact already exists: $target (pass -Force to replace it)." }
    Remove-Item -LiteralPath $target -Force
  }
}
if (-not (Test-Path -LiteralPath $ReleaseNotesPath)) {
  throw "Missing UTF-8 release notes file: $ReleaseNotesPath"
}

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$WorkRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("hpr-release-" + [guid]::NewGuid().ToString("N"))
$StageRoot = Join-Path $WorkRoot $BaseName
$ExtractRoot = Join-Path $WorkRoot "reverse-unpack"
New-Item -ItemType Directory -Force -Path $StageRoot, $ExtractRoot | Out-Null

function Invoke-Node {
  param([string[]]$Arguments, [string]$WorkingDirectory)
  Push-Location $WorkingDirectory
  try {
    & node @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "node $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Get-PackageFiles {
  param([string]$Root)
  $rootFiles = @(
    "index.js", "LICENSE", "manifest.json", "README.md", "ROADMAP.md",
    "THIRD_PARTY_NOTICES.md", "RELEASE_NOTES_$Version.md"
  )
  $relative = [System.Collections.Generic.List[string]]::new()
  foreach ($file in $rootFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $file))) { throw "Missing package file: $file" }
    $relative.Add($file)
  }
  foreach ($directory in @("assets", "lib", "licenses", "routes", "tests")) {
    Get-ChildItem -LiteralPath (Join-Path $Root $directory) -Recurse -File | Sort-Object FullName | ForEach-Object {
      $relative.Add([System.IO.Path]::GetRelativePath($Root, $_.FullName))
    }
  }
  return @($relative | Sort-Object -Unique)
}

function Copy-PackageFiles {
  param([string]$SourceRoot, [string]$DestinationRoot, [string[]]$Files)
  foreach ($relative in $Files) {
    $source = Join-Path $SourceRoot $relative
    $destination = Join-Path $DestinationRoot $relative
    $parent = Split-Path $destination -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
}

function Invoke-SyntaxChecks {
  param([string]$Root)
  $sources = Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object { $_.Extension -in @(".js", ".mjs") }
  foreach ($source in $sources) {
    Invoke-Node -Arguments @("--check", $source.FullName) -WorkingDirectory $Root
  }
}

function Invoke-TestSuite {
  param([string]$Root)
  $tests = Get-ChildItem -LiteralPath (Join-Path $Root "tests") -Filter "*.test.mjs" -File |
    Sort-Object Name | ForEach-Object { $_.FullName }
  if ($tests.Count -eq 0) { throw "No test files found." }
  Invoke-Node -Arguments (@("--test") + @($tests)) -WorkingDirectory $Root
}

function Assert-ReversePackage {
  param([string]$ExpectedRoot, [string]$ActualRoot)
  $expected = Get-ChildItem -LiteralPath $ExpectedRoot -Recurse -File | ForEach-Object {
    [pscustomobject]@{
      Relative = [System.IO.Path]::GetRelativePath($ExpectedRoot, $_.FullName)
      Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  } | Sort-Object Relative
  $actual = Get-ChildItem -LiteralPath $ActualRoot -Recurse -File | ForEach-Object {
    [pscustomobject]@{
      Relative = [System.IO.Path]::GetRelativePath($ActualRoot, $_.FullName)
      Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  } | Sort-Object Relative
  if ($expected.Count -ne $actual.Count) {
    throw "Reverse package file count mismatch: expected $($expected.Count), actual $($actual.Count)."
  }
  for ($index = 0; $index -lt $expected.Count; $index += 1) {
    if ($expected[$index].Relative -ne $actual[$index].Relative -or $expected[$index].Hash -ne $actual[$index].Hash) {
      throw "Reverse package mismatch at $($expected[$index].Relative)."
    }
  }
  return $expected.Count
}

function Assert-NoSensitiveMaterial {
  param([string]$Root)
  $forbiddenNames = @("main(2).pdf", "paper-workspace.json", "service-ticket.json", ".env")
  $textExtensions = @(".js", ".mjs", ".json", ".md", ".css", ".html", ".txt", ".yml", ".yaml")
  $patterns = @(
    '(?i)pluginIframeTicket\s*[:=]\s*["''][^"'']{8,}',
    '(?i)authorization\s*[:=]\s*["'']Bearer\s+[A-Za-z0-9._-]{20,}',
    '(?i)\bsk-[A-Za-z0-9_-]{20,}\b',
    '(?i)\bgh[pousr]_[A-Za-z0-9]{30,}\b',
    '(?i)\bgithub_pat_[A-Za-z0-9_]{30,}\b',
    '(?i)\bAKIA[A-Z0-9]{16}\b',
    '(?i)[A-Z]:\\Users\\[^\\\s]+',
    '(?i)/Users/[^/\s]+'
  )
  foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File) {
    if ($forbiddenNames -contains $file.Name) { throw "Forbidden release file: $($file.FullName)" }
    if ($textExtensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
    $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
    foreach ($pattern in $patterns) {
      if ($content -match $pattern) {
        throw "Sensitive material pattern matched in $([System.IO.Path]::GetRelativePath($Root, $file.FullName)): $pattern"
      }
    }
  }
}

try {
  Write-Host "[1/8] Syntax checks"
  Invoke-SyntaxChecks -Root $RepoRoot

  Write-Host "[2/8] Source test suite"
  Invoke-TestSuite -Root $RepoRoot

  Write-Host "[3/8] Build clean package tree"
  $packageFiles = Get-PackageFiles -Root $RepoRoot
  Copy-PackageFiles -SourceRoot $RepoRoot -DestinationRoot $StageRoot -Files $packageFiles
  Assert-NoSensitiveMaterial -Root $StageRoot

  Write-Host "[4/8] Build ZIP"
  Compress-Archive -Path (Join-Path $StageRoot "*") -DestinationPath $ZipPath -CompressionLevel Optimal
  if (-not (Test-Path -LiteralPath $ZipPath) -or (Get-Item -LiteralPath $ZipPath).Length -le 0) {
    throw "ZIP was not created correctly."
  }

  Write-Host "[5/8] Reverse unpack and compare"
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractRoot
  $fileCount = Assert-ReversePackage -ExpectedRoot $StageRoot -ActualRoot $ExtractRoot

  Write-Host "[6/8] Reverse-unpacked syntax and tests"
  Invoke-SyntaxChecks -Root $ExtractRoot
  Invoke-TestSuite -Root $ExtractRoot

  Write-Host "[7/8] Sensitive scan"
  Assert-NoSensitiveMaterial -Root $ExtractRoot

  Write-Host "[8/8] SHA-256 and QA report"
  $zipInfo = Get-Item -LiteralPath $ZipPath
  $zipHash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText($HashPath, "$zipHash  $($zipInfo.Name)`n", $Utf8NoBom)
  $qa = @(
    "# Hana Paper Reader $Version · Release QA",
    "",
    "- 构建时间：$([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz'))",
    "- 源码版本：$Version",
    "- ZIP：$($zipInfo.Name)",
    "- 文件数：$fileCount",
    "- 大小：$($zipInfo.Length) bytes",
    "- SHA-256：$zipHash",
    "",
    "## 自动门禁",
    "",
    "- [x] 全部 JavaScript / MJS 语法检查",
    "- [x] 源码目录全部测试",
    "- [x] 净目录打包，ZIP 根目录无多余顶层文件夹",
    "- [x] 反向解包并逐文件 SHA-256 比对",
    "- [x] 解包目录再次语法检查与全部测试",
    "- [x] 常见凭据、Hana 服务票据、本机用户路径与真实 QA 论文名扫描",
    "- [x] 固定合成 PDF 回归夹具哈希验证",
    "- [x] UTF-8 Release Notes 文件存在：RELEASE_NOTES_$Version.md",
    "",
    "## 固定回归样本",
    "",
    "- 英文双栏",
    "- 中文论文",
    "- 扫描页（无文本层）",
    "- 公式密集",
    "- 图表 / 表格密集",
    "- OCR fallback 协议：普通模式失败后自动重试 OCR",
    "",
    "> 此报告只记录自动门禁；真实 MinerU、真实翻译模型和 Hana 内置浏览器验收需在发布前另行完成。",
    ""
  ) -join "`n"
  [System.IO.File]::WriteAllText($QaPath, $qa, $Utf8NoBom)

  Write-Host "Release package ready: $ZipPath"
  Write-Host "SHA-256: $zipHash"
  Write-Host "QA: $QaPath"
} finally {
  if (Test-Path -LiteralPath $WorkRoot) { Remove-Item -LiteralPath $WorkRoot -Recurse -Force }
}
