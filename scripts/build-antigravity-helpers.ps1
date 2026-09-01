$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "scripts\agy-profile-launcher.cpp"
$vaultSource = Join-Path $repoRoot "scripts\agy-account-vault.cpp"
$output = Join-Path $repoRoot "dist-native\antigravity"
$vcvars = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat'

if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Launcher source is missing: $source" }
if (-not (Test-Path -LiteralPath $vaultSource -PathType Leaf)) { throw "Vault source is missing: $vaultSource" }
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw "MSVC environment is missing: $vcvars" }
New-Item -ItemType Directory -Force -Path $output | Out-Null

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("openmaus-antigravity-build-{0}-{1}" -f $PID, ([guid]::NewGuid().ToString("N")))
New-Item -ItemType Directory -Force -Path $temporary | Out-Null

try {
  foreach ($profile in @("a", "b")) {
    $name = "agy-worker-$profile"
    $object = Join-Path $temporary "$name.obj"
    $binary = Join-Path $output "$name.exe"
    $compileCommand = "call `"$vcvars`" >nul && cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /WX /DPROFILE_NAME=L\`"worker-$profile\`" `"$source`" /Fo:`"$object`" /Fe:`"$binary`" /link /SUBSYSTEM:CONSOLE"
    & cmd.exe /d /c $compileCommand
    if ($LASTEXITCODE -ne 0) { throw "Antigravity $name compilation failed" }
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Compiled helper is missing: $binary" }
  }
  $vaultObject = Join-Path $temporary "agy-account-vault.obj"
  $vaultBinary = Join-Path $output "agy-account-vault.exe"
  $vaultCompileCommand = "call `"$vcvars`" >nul && cl.exe /nologo /std:c++17 /O2 /EHsc /W4 /WX `"$vaultSource`" /Fo:`"$vaultObject`" /Fe:`"$vaultBinary`" /link /SUBSYSTEM:CONSOLE"
  & cmd.exe /d /c $vaultCompileCommand
  if ($LASTEXITCODE -ne 0) { throw "Antigravity account vault compilation failed" }
  if (-not (Test-Path -LiteralPath $vaultBinary -PathType Leaf)) { throw "Compiled helper is missing: $vaultBinary" }
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\provision-antigravity-helpers.ps1") -SourceRoot $output

Get-ChildItem -LiteralPath $output -Filter "*.exe" | Where-Object { $_.Name -in @("agy-worker-a.exe", "agy-worker-b.exe", "agy-account-vault.exe") } | ForEach-Object {
  Write-Output ("staged={0} bytes={1}" -f $_.Name, $_.Length)
}
