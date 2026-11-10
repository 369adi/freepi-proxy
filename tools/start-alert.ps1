# Start the alert listener as a process the DSH tree cannot reach.
# Win32_Process.Create makes the parent WmiPrvSE.exe, so a taskkill /T on the
# app never takes the alert channel down with it.
$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\liket\Documents\freepi-proxy'
$node = (Get-Command node).Source
$script = Join-Path $repo 'tools\alert.mjs'

$commandLine = '"' + $node + '" "' + $script + '" --serve'

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $commandLine
  CurrentDirectory = $repo
}

Write-Output ("pid=" + $result.ProcessId + " return=" + $result.ReturnValue)
