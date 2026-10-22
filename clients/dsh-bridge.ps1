<#
.SYNOPSIS
  Drive DeepSeek Harness through the Agent Bridge plugin (127.0.0.1 control API).
.DESCRIPTION
  Enable the plugin first: DSH → Plugins → Agent Bridge.
  The plugin writes <DSH data dir>\dsh-agent-bridge.json {bind, port, token, pid, startedAt, version}.
  The data directory is -DshHome, else $env:DSH_HOME, else ~/.dsh.
  ask prints the reply text. Pass -Json for the full JSON object.
  Every other action prints one JSON object. Exit code 1 on failure.
  Selecting a model may change DSH's default. Pass -RestoreDefault to put the previous default back.
  Provider and model ids come from the "models" action. This script has none built in.
  "delete" needs the dsh-session-delete plugin installed and enabled.
.EXAMPLE
  ./dsh-bridge.ps1 ping
  ./dsh-bridge.ps1 ask -Text 'Say hello to the agent that sent you this message. Reply with a short greeting only.'
  ./dsh-bridge.ps1 ask -Text 'Summarize this workspace' -Provider '<provider>' -Model '<model>' -RestoreDefault -Json
  ./dsh-bridge.ps1 new -Title 'Example task' -ApprovalMode remote
  ./dsh-bridge.ps1 prompt -SessionId '<session-id>' -Text 'Continue' [-NoWait] [-TimeoutSec 600]
  ./dsh-bridge.ps1 model -SessionId '<session-id>' -Provider '<provider>' -Model '<model>' -RestoreDefault
  ./dsh-bridge.ps1 delete -SessionId '<id>[,<id2>...]'
  ./dsh-bridge.ps1 approvals
  ./dsh-bridge.ps1 approve -ApprovalId '<id>'
  ./dsh-bridge.ps1 call -Method POST -Path '/sessions/<id>/rename' -Body '{"title":"Example"}'
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('ping','doctor','status','models','workspaces','sessions','new','ask','prompt','messages','raw','model','cancel','rename',
               'delete','permissions','permission','approvals','approve','reject','cancel-approval','approval-mode','default-approval-mode','default-model','set-default-model','call')]
  [string]$Action = 'ping',
  [string]$SessionId,
  [string]$Text,
  [string]$TextFile,
  [string]$Provider,
  [string]$Model,
  [string]$Reasoning,
  [string]$WorkspaceId,
  [string]$Cwd,
  [string]$Title,
  [ValidateSet('','ui','remote','auto-allow')][string]$ApprovalMode = '',
  [string]$ApprovalId,
  [string]$Preset,
  [switch]$NoWait,
  [switch]$Steer,
  [switch]$RestoreDefault,
  [switch]$IgnorePid,
  [switch]$Full,
  [switch]$Json,
  [int]$TimeoutSec = 300,
  [int]$Limit = 50,
  [switch]$WithEvents,
  [switch]$All,
  [string]$Method = 'GET',
  [string]$Path = '/ping',
  [string]$Body = '',
  [string]$TimeZone = '',
  [string]$InfoFile = '',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' })
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Fail($code, $msg) {
  if ($Action -eq 'ask' -and -not $Json) {
    [Console]::Error.WriteLine($msg)
    exit 1
  }
  @{ ok = $false; code = $code; error = $msg } | ConvertTo-Json -Compress | Write-Output
  exit 1
}
function Need($name, $value) {
  if ([string]::IsNullOrWhiteSpace([string]$value)) { Fail 'bad-args' "-$name is required for '$Action'" }
}
function ConvertTo-Body($value) {
  return ($value | ConvertTo-Json -Depth 10 -Compress)
}
function ConvertTo-JsonArray($items) {
  $json = ConvertTo-Json -InputObject @($items) -Compress -Depth 5
  if (-not $json.StartsWith('[')) { $json = '[' + $json + ']' }
  return $json
}
function Encode-Segment([string]$value) {
  return [System.Uri]::EscapeDataString($value)
}
function ModelBody([switch]$WithRestore) {
  $h = [ordered]@{}
  if ($Provider) { $h.provider = $Provider }
  if ($Model) { $h.model = $Model }
  if ($Reasoning) { $h.reasoningEffort = $Reasoning }
  if ($WithRestore -and $RestoreDefault -and $Provider -and $Model) { $h.restoreDefault = $true }
  return $h
}
function Note-Model($jsonText) {
  try {
    $obj = $jsonText | ConvertFrom-Json
    $value = $obj.value
    if ($null -eq $value) { return }
    if ($value.defaultRestored -eq $true) {
      [Console]::Error.WriteLine('Previous default model was restored.')
      return
    }
    if ($value.defaultMayHaveChanged -eq $true) {
      $who = ''
      if ($value.previousDefault -and $value.previousDefault.provider -and $value.previousDefault.model) {
        $who = " Previous default: $($value.previousDefault.provider)/$($value.previousDefault.model)."
      }
      [Console]::Error.WriteLine("Selecting a model may change DSH's default model.$who Re-run with -RestoreDefault to restore it.")
    }
  } catch {}
}

if ($TextFile) { $Text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8) }
$q = "?limit=$Limit" + $(if ($WithEvents) { '&events=1' } else { '' }) + $(if ($All) { '&all=1' } else { '' })
$m = 'GET'
$p = '/ping'
$b = $null
switch ($Action) {
  'ping' { $p = '/ping' }
  'doctor' { $p = '/ping' }
  'status' { $p = '/ping' }
  'models' { $p = '/models' }
  'workspaces' { $p = '/workspaces' }
  'sessions' {
    $full = $(if ($Full) { '&full=1' } else { '' })
    $p = "/sessions?limit=$Limit$full"
  }
  'new' {
    $m = 'POST'; $p = '/sessions'; $h = ModelBody -WithRestore
    if ($WorkspaceId) { $h.workspaceId = $WorkspaceId }
    if ($Cwd) { $h.cwd = $Cwd }
    if ($Title) { $h.title = $Title }
    if ($ApprovalMode) { $h.approvalMode = $ApprovalMode }
    if ($Preset) { $h.permission = $Preset }
    $b = ConvertTo-Body $h
  }
  'ask' {
    Need 'Text' $Text
    $m = 'POST'; $p = '/ask'; $h = ModelBody -WithRestore
    $h.text = $Text
    $h.timeoutSec = $TimeoutSec
    $h.wait = -not $NoWait
    if ($Steer) { $h.mode = 'steer' }
    if ($WorkspaceId) { $h.workspaceId = $WorkspaceId }
    if ($Cwd) { $h.cwd = $Cwd }
    if ($Title) { $h.title = $Title }
    if ($ApprovalMode) { $h.approvalMode = $ApprovalMode }
    if ($Preset) { $h.permission = $Preset }
    if ($TimeZone) { $h.timeZone = $TimeZone }
    $b = ConvertTo-Body $h
  }
  'prompt' {
    Need 'SessionId' $SessionId
    Need 'Text' $Text
    $m = 'POST'; $p = "/sessions/$(Encode-Segment $SessionId)/prompt"
    $h = [ordered]@{
      text = $Text
      wait = -not $NoWait
      timeoutSec = $TimeoutSec
      mode = $(if ($Steer) { 'steer' } else { 'queue' })
    }
    if ($TimeZone) { $h.timeZone = $TimeZone }
    $b = ConvertTo-Body $h
  }
  'messages' { Need 'SessionId' $SessionId; $p = "/sessions/$(Encode-Segment $SessionId)/messages$q" }
  'raw' { Need 'SessionId' $SessionId; $p = "/sessions/$(Encode-Segment $SessionId)/raw?limit=$Limit" }
  'model' {
    Need 'SessionId' $SessionId
    Need 'Provider' $Provider
    Need 'Model' $Model
    $m = 'POST'; $p = "/sessions/$(Encode-Segment $SessionId)/model"; $b = ConvertTo-Body (ModelBody -WithRestore)
  }
  'cancel' { Need 'SessionId' $SessionId; $m = 'POST'; $p = "/sessions/$(Encode-Segment $SessionId)/cancel"; $b = '{}' }
  'rename' { Need 'SessionId' $SessionId; Need 'Title' $Title; $m = 'POST'; $p = "/sessions/$(Encode-Segment $SessionId)/rename"; $b = ConvertTo-Body @{ title = $Title } }
  'delete' {
    Need 'SessionId' $SessionId
    $ids = @($SessionId -split '[,;\s]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $m = 'POST'; $p = '/delete'; $b = '{"sessionIds":' + (ConvertTo-JsonArray $ids) + '}'
  }
  'permissions' { $p = '/permissions' }
  'permission' { Need 'SessionId' $SessionId; Need 'Preset' $Preset; $m = 'POST'; $p = "/sessions/$(Encode-Segment $SessionId)/permission"; $b = ConvertTo-Body @{ preset = $Preset } }
  'approvals' { $p = '/approvals' }
  'approve' { Need 'ApprovalId' $ApprovalId; $m = 'POST'; $p = "/approvals/$(Encode-Segment $ApprovalId)"; $b = ConvertTo-Body @{ decision = 'allow' } }
  'reject' { Need 'ApprovalId' $ApprovalId; $m = 'POST'; $p = "/approvals/$(Encode-Segment $ApprovalId)"; $b = ConvertTo-Body @{ decision = 'reject' } }
  'cancel-approval' { Need 'ApprovalId' $ApprovalId; $m = 'POST'; $p = "/approvals/$(Encode-Segment $ApprovalId)"; $b = ConvertTo-Body @{ decision = 'cancel' } }
  'approval-mode' {
    Need 'SessionId' $SessionId
    Need 'ApprovalMode' $ApprovalMode
    $m = 'POST'; $p = "/sessions/$(Encode-Segment $SessionId)/approval-mode"; $b = ConvertTo-Body @{ mode = $ApprovalMode }
  }
  'default-approval-mode' {
    if ($ApprovalMode) { $m = 'POST'; $b = ConvertTo-Body @{ mode = $ApprovalMode } }
    $p = '/approval-mode'
  }
  'default-model' { $p = '/default-model' }
  'set-default-model' { Need 'Provider' $Provider; Need 'Model' $Model; $m = 'POST'; $p = '/default-model'; $b = ConvertTo-Body (ModelBody) }
  'call' { $m = $Method.ToUpper(); $p = $Path; if ($Body) { $b = $Body } }
}

if (-not $InfoFile) { $InfoFile = Join-Path $DshHome 'dsh-agent-bridge.json' }
if (-not (Test-Path -LiteralPath $InfoFile)) {
  Fail 'disabled' "Agent Bridge is off or DSH is not running (no discovery file at $InfoFile). In DSH open Plugins and enable Agent Bridge. If DSH uses a custom data directory, set DSH_HOME or pass -DshHome."
}
try { $info = [IO.File]::ReadAllText($InfoFile, [Text.Encoding]::UTF8) | ConvertFrom-Json }
catch { Fail 'bad-token-file' "Could not read the discovery file at $InfoFile." }
if (-not $info.port -or -not $info.token) { Fail 'bad-token-file' 'Discovery file is missing port or token.' }
if (-not $IgnorePid) {
  $alive = $false
  try { $alive = $null -ne (Get-Process -Id $info.pid -ErrorAction SilentlyContinue) } catch { $alive = $false }
  if (-not $alive) { Fail 'stale' "Discovery file points at pid $($info.pid), which is not running. Start DSH and enable Agent Bridge." }
}

Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds([Math]::Max($TimeoutSec + 60, 90))
$req = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::new($m)), ("http://127.0.0.1:{0}{1}" -f $info.port, $p)
$req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', [string]$info.token)
if ($m -ne 'GET') {
  if (-not $b) { $b = '{}' }
  $req.Content = New-Object System.Net.Http.StringContent($b, [Text.Encoding]::UTF8, 'application/json')
}
try {
  $resp = $client.SendAsync($req).GetAwaiter().GetResult()
  $bytes = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  $text = [Text.Encoding]::UTF8.GetString($bytes)
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  Fail 'unreachable' ("Could not reach Agent Bridge at 127.0.0.1:{0}: {1}" -f $info.port, $e.Message)
} finally {
  $client.Dispose()
}
if ($Action -eq 'ask' -and -not $Json) {
  try { $obj = $text | ConvertFrom-Json } catch {
    [Console]::Error.WriteLine('Bridge returned non-JSON.')
    exit 1
  }
  if (-not $resp.IsSuccessStatusCode -or $obj.ok -eq $false) {
    $msg = [string]$obj.error
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "Request failed (HTTP $([int]$resp.StatusCode))." }
    [Console]::Error.WriteLine($msg)
    exit 1
  }
  Note-Model $text
  $reply = $obj.value.reply
  $status = [string]$obj.value.status
  if ($null -eq $reply -and [string]::IsNullOrEmpty($status)) {
    Write-Output ("accepted " + $obj.value.requestId)
    exit 0
  }
  $replyText = [string]$reply
  if (-not [string]::IsNullOrEmpty($status) -and $status -ne 'turn-ended') {
    [Console]::Error.WriteLine("Turn status: $status")
    if (-not [string]::IsNullOrEmpty($replyText)) { Write-Output $replyText }
    exit 1
  }
  if ([string]::IsNullOrEmpty($replyText)) { [Console]::Error.WriteLine('DSH returned an empty reply.') }
  Write-Output $replyText
  exit 0
}
Write-Output $text
Note-Model $text
if (-not $resp.IsSuccessStatusCode) { exit 1 }
exit 0
