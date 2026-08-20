param([string]$Out)
$deadline = (Get-Date).AddMinutes(28)
while ((Get-Date) -lt $deadline) {
  try {
    $stats = docker stats --no-stream --format "{{.Name}}`t{{.CPUPerc}}`t{{.MemUsage}}" 2>$null
    $line = (Get-Date -Format o) + "`n" + ($stats -join "`n")
    Add-Content -Path $Out -Value $line
  } catch {}
  Start-Sleep -Seconds 5
}