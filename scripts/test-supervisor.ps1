$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$source = Join-Path $project 'bin\jev-supervisor.cs'
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.Substring(0,16).ToLowerInvariant()
$runtime = Join-Path $project '.runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$executable = Join-Path $runtime ('jev-supervisor-' + $hash + '.exe')
if (-not (Test-Path -LiteralPath $executable)) {
  Add-Type -TypeDefinition (Get-Content -LiteralPath $source -Raw) -OutputAssembly $executable -OutputType WindowsApplication
}
$bytes = [IO.File]::ReadAllBytes($executable)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
if ([BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68) -ne 2) { throw 'Supervisor is not a windowless GUI executable' }
$fixtureDirectory = Join-Path $runtime ('smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
$fixtureScript = Join-Path $fixtureDirectory 'fixture.mjs'
@'
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./data-dir.txt', import.meta.url), process.env.JEV_DESKTOP_DATA_DIR ?? '');
console.log('fixture_started');
setInterval(() => {}, 1000);
'@ | Set-Content -LiteralPath $fixtureScript -Encoding UTF8
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$arguments = '"' + $nodePath + '" "' + $fixtureScript + '" "' + $fixtureDirectory + '"'
$supervisor = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
$lastChild = $null
function Wait-FixtureChild([int]$Previous = 0) {
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $candidate = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisor.Id)" | Where-Object { $_.Name -eq 'node.exe' -and $_.ProcessId -ne $Previous -and $_.CommandLine.Contains($fixtureScript) } | Select-Object -First 1
    if ($candidate) { return $candidate }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  throw 'Supervisor did not start a replacement fixture'
}
try {
  $firstChild = Wait-FixtureChild
  $lastChild = $firstChild
  $dataDirEvidence = Join-Path $fixtureDirectory 'data-dir.txt'
  $deadline = (Get-Date).AddSeconds(5)
  while (-not (Test-Path -LiteralPath $dataDirEvidence) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $dataDirEvidence) -or (Get-Content -LiteralPath $dataDirEvidence -Raw) -ne $fixtureDirectory) { throw 'Supervisor did not forward the data directory to Node' }
  Start-Sleep -Milliseconds 500
  Stop-Process -Id $firstChild.ProcessId -Force
  $replacement = Wait-FixtureChild $firstChild.ProcessId
  $lastChild = $replacement
  Start-Sleep -Milliseconds 500
  Stop-Process -Id $supervisor.Id -Force
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Process -Id $replacement.ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (Get-Process -Id $replacement.ProcessId -ErrorAction SilentlyContinue) { throw 'Stopping supervisor left an orphan Node process' }
  [pscustomobject]@{ hiddenExecutable = $true; childRestarted = $true; childStoppedWithSupervisor = $true; dataDirForwarded = $true } | ConvertTo-Json -Compress
} finally {
  if (-not $supervisor.HasExited) { Stop-Process -Id $supervisor.Id -Force -ErrorAction SilentlyContinue }
  if ($lastChild) {
    $remaining = Get-CimInstance Win32_Process -Filter "ProcessId = $($lastChild.ProcessId)"
    if ($remaining -and $remaining.CommandLine.Contains($fixtureScript)) { Stop-Process -Id $remaining.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}
