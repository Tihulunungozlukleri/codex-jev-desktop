param(
  [ValidateSet('preview', 'status', 'install', 'start', 'restart', 'uninstall')]
  [string]$Action = 'status'
)
$ErrorActionPreference = 'Stop'
$taskName = 'CodexJevDesktopRelay'
$entry = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'jev-desktop.mjs')).Path
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nodeExe = if ($nodeCommand) { $nodeCommand.Source } else { $null }
$dataDirectory = if ($env:JEV_DESKTOP_DATA_DIR) { $env:JEV_DESKTOP_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'CodexJevDesktop' }
$supervisorSource = Join-Path $PSScriptRoot 'jev-supervisor.cs'
$hasher = [Security.Cryptography.SHA256]::Create()
try { $sourceHash = ([BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($supervisorSource))) -replace '-', '').Substring(0, 16).ToLowerInvariant() }
finally { $hasher.Dispose() }
$runtimeDirectory = Join-Path $projectRoot '.runtime'
$supervisorExe = Join-Path $runtimeDirectory ('jev-supervisor-' + $sourceHash + '.exe')
$expectedArgument = '"' + $nodeExe + '" "' + $entry + '" "' + $dataDirectory + '"'
$ownedArgumentPattern = '^"[^"]+" "' + [regex]::Escape($entry) + '" "[^"]+"$'
$legacyArgument = '"' + $entry + '" serve'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$owned = $false
$compliant = $false
if ($task) {
  $legacyOwned = @($task.Actions).Count -eq 1 -and
    $task.Actions[0].Execute -match '(?i)(^|\\)node\.exe$' -and
    $task.Actions[0].Arguments -eq $legacyArgument
  $supervisorOwned = @($task.Actions).Count -eq 1 -and
    (Split-Path -Parent $task.Actions[0].Execute) -eq $runtimeDirectory -and
    (Split-Path -Leaf $task.Actions[0].Execute) -match '^jev-supervisor-[a-f0-9]{16}\.exe$' -and
    $task.Actions[0].Arguments -match $ownedArgumentPattern
  $owned = $legacyOwned -or $supervisorOwned
  $compliant = $supervisorOwned -and $task.Actions[0].Execute -eq $supervisorExe -and
    $task.Settings.StartWhenAvailable -and $task.Settings.RestartCount -ge 3 -and @($task.Triggers).Count -eq 2
}
if ($Action -eq 'preview' -or $Action -eq 'status') {
  [pscustomobject]@{
    taskName = $taskName
    exists = [bool]$task
    owned = $owned
    state = if ($task) { [string]$task.State } else { 'Absent' }
    trigger = 'Current user logon and once per minute (IgnoreNew while running)'
    runLevel = 'Limited'
    executable = if ($task) { $task.Actions[0].Execute } else { $supervisorExe }
    background = [bool]$supervisorOwned
    entry = $entry
  } | ConvertTo-Json -Compress
  exit 0
}
if ($task -and -not $owned) { throw "Task name $taskName is already used by another action" }
if ($Action -eq 'install') {
  if ($compliant) { '{"alreadyInstalled":true}' ; exit 0 }
  if (-not $nodeExe) { throw 'Node.js executable was not found' }
  if (-not (Test-Path -LiteralPath $supervisorExe)) {
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    Add-Type -TypeDefinition (Get-Content -LiteralPath $supervisorSource -Raw) -OutputAssembly $supervisorExe -OutputType WindowsApplication
  }
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $identity),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
  )
  $taskAction = New-ScheduledTaskAction -Execute $supervisorExe -Argument $expectedArgument -WorkingDirectory $projectRoot
  if ($owned) {
    Set-ScheduledTask -TaskName $taskName -Settings $settings -Action $taskAction -Trigger $triggers | Out-Null
    '{"updated":true}'
    exit 0
  }
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Trigger $triggers -Principal $principal -Action $taskAction -Settings $settings -Description 'Runs the local Codex JEV relay without a console, restarts exited relays, and recovers a stopped task every minute.' | Out-Null
  '{"installed":true}'
} elseif ($Action -eq 'restart') {
  if (-not $owned) { throw 'Owned startup task is not installed' }
  try {
    Stop-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddSeconds(10)
    do {
      Start-Sleep -Milliseconds 100
      $currentTask = Get-ScheduledTask -TaskName $taskName
    } while ($currentTask.State -eq 'Running' -and (Get-Date) -lt $deadline)
  } finally {
    Start-ScheduledTask -TaskName $taskName
  }
  '{"restartRequested":true}'
} elseif ($Action -eq 'start') {
  if (-not $owned) { throw 'Owned startup task is not installed' }
  Start-ScheduledTask -TaskName $taskName
  '{"startRequested":true}'
} elseif ($Action -eq 'uninstall') {
  if (-not $task) { '{"alreadyUninstalled":true}'; exit 0 }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  '{"uninstalled":true}'
}
