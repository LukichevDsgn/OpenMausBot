param(
  [string]$SourceRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist-native\antigravity"),
  [string]$Destination = ""
)

$ErrorActionPreference = "Stop"
$required = @("agy-account-vault.exe", "agy-worker-a.exe", "agy-worker-b.exe")

if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
  throw "Antigravity helper staging directory is missing: $SourceRoot"
}

foreach ($name in $required) {
  $path = Join-Path $SourceRoot $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Antigravity helper is missing: $name"
  }
}

if ($Destination -ne "") {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  foreach ($name in $required) {
    Copy-Item -LiteralPath (Join-Path $SourceRoot $name) -Destination (Join-Path $Destination $name) -Force
  }
}

Write-Output ("validated={0} helpers={1}" -f $SourceRoot, ($required -join ","))
