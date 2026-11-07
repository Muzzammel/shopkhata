# e2e-run.ps1 -Name <gate> -PwArgs "<playwright args>"
# One E2E gate: fresh DB (supabase db reset), a fresh `pnpm dev` on :3000 with its log captured, ONE Playwright run
# (one worker), then the dev server process tree is stopped. Writes <gate>.log (Playwright) and <gate>.server.log.
param([string]$Name, [string]$PwArgs)
$ErrorActionPreference = "Continue"
$repo = "C:\Users\Reem\Desktop\shopkhata"
$ev = "$repo\docs\release\evidence\ops-01b-slice1-final-invariants\logs"
$sp = "C:\Users\Reem\AppData\Local\Temp\claude\86599d7da4cda383\d46ec58f-b8ba-4f13-93e7-53968403f4a0\scratchpad"
Set-Location $repo
if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { throw "port 3000 already in use: stop the stale server first" }
$tree = (& "C:\Program Files\Git\bin\bash.exe" "$sp/tree.sh").Trim()
$log = "$ev\$Name.log"; $serverLog = "$ev\$Name.server.log"
$started = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
"# gate: $Name`n# command: pnpm exec supabase db reset --local; pnpm dev (server log: $Name.server.log); pnpm exec playwright test -c <scratch>/pw.config.ts $PwArgs`n# wrapper config: repo playwright.config.ts with webServer removed (dev server started by this script)`n# tree: $tree`n# started: $started`n" | Out-File -Encoding utf8 $log
cmd /c "pnpm.cmd exec supabase --agent no db reset --local >> `"$log`" 2>&1"
$reset = $LASTEXITCODE
"# db reset exit: $reset`n" | Out-File -Encoding utf8 -Append $log
if ($reset -ne 0) { "# exit: $reset (db reset failed)" | Out-File -Encoding utf8 -Append $log; exit $reset }
# `db reset` recreates the database under PostgREST, which reconnects with exponential back-off (seen: 503 PGRST002 for
# ~35 s). Wait until the Data API answers 200 three times in a row before any test runs.
$envText = (cmd /c "pnpm.cmd exec supabase --agent no status -o env 2>nul") -join "`n"
$api = [regex]::Match($envText, 'API_URL="?([^"\r\n]+)').Groups[1].Value
$key = [regex]::Match($envText, '(?:PUBLISHABLE_KEY|ANON_KEY)="?([^"\r\n]+)').Groups[1].Value
$okRuns = 0; $deadline = (Get-Date).AddMinutes(3); $t0 = Get-Date
while ($okRuns -lt 3 -and (Get-Date) -lt $deadline) {
  # Ready = PostgREST answers from a loaded schema cache: 200, or anon's 42501 "permission denied for table shops"
  # (it knows the table). Not ready = 503 PGRST002 (schema cache) / PGRST001 (no connection) / no answer.
  $ready = $false
  try { $ready = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Headers @{ apikey = $key } "$api/rest/v1/shops?select=id&limit=1").StatusCode -eq 200 }
  catch { $ready = ($_.Exception.Response.StatusCode.value__ -eq 401) -and ("$($_.ErrorDetails.Message)" -match '"code":"42501"') }
  if ($ready) { $okRuns++ } else { $okRuns = 0 }
  Start-Sleep -Milliseconds 500
}
"# data API ready after db reset: $($okRuns -ge 3) (waited $([int]((Get-Date) - $t0).TotalSeconds) s)`n" | Out-File -Encoding utf8 -Append $log
if ($okRuns -lt 3) { "# exit: 1 (data API not ready)" | Out-File -Encoding utf8 -Append $log; exit 1 }
$dev = Start-Process -FilePath cmd.exe -ArgumentList "/c pnpm.cmd dev > `"$serverLog`" 2>&1" -WorkingDirectory $repo -WindowStyle Hidden -PassThru
try {
  $deadline = (Get-Date).AddMinutes(3)
  do { Start-Sleep -Milliseconds 500; try { $ok = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 http://localhost:3000/login).StatusCode -eq 200 } catch { $ok = $false } } until ($ok -or (Get-Date) -gt $deadline)
  if (-not $ok) { "# exit: 1 (dev server not ready)" | Out-File -Encoding utf8 -Append $log; exit 1 }
  cmd /c "pnpm.cmd exec playwright test -c `"$sp\pw.config.ts`" $PwArgs >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
} finally {
  taskkill /PID $dev.Id /T /F | Out-Null
  Start-Sleep -Seconds 2
  git checkout -- AGENTS.md  # next dev rewrites it; never part of the tested tree
}
$finished = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
"`n# finished: $finished`n# exit: $code" | Out-File -Encoding utf8 -Append $log
"$Name|$started|$finished|$code|playwright test $PwArgs (db reset $reset; fresh pnpm dev)" | Out-File -Encoding utf8 -Append "$ev\gates.tsv"
"gate $Name exit $code"
exit $code
