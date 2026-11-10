param(
    [int]$PollSeconds = 5,
    [int]$ReconnectSeconds = 60,
    [int]$RestartCooldownSeconds = 300,
    [string]$ProxyDirectory = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$proxyDirectory = (Resolve-Path -LiteralPath $ProxyDirectory).Path
$logDirectory = Join-Path $proxyDirectory 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logFile = Join-Path $logDirectory 'harness-watchdog.log'
$restartScript = Join-Path $proxyDirectory 'tools\restart-dsh.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$reconnectingSince = $null
$lastRestart = [DateTime]::MinValue

function Write-WatchEvent([string]$Message) {
    if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 2MB) {
        Move-Item -LiteralPath $logFile -Destination ($logFile + '.previous') -Force
    }
    Add-Content -LiteralPath $logFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message)
}

function Test-HarnessReconnecting {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' })
    if ($processes.Count -eq 0) { return $false }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($proc in $processes) {
        try {
            $processCondition = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
                [int]$proc.ProcessId
            )
            $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $processCondition)
            if ($null -eq $window) { continue }
            $buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::Button
            )
            $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
            foreach ($button in $buttons) {
                $name = $button.Current.Name
                if ($name -match '^Reconnecting,\s*reconnect now$') { return $true }
            }
        } catch {
            # The UI can replace an element while it is being read; retry next poll.
        }
    }
    return $false
}

function Test-RestartInProgress {
    foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        if ($proc.CommandLine -and $proc.CommandLine -match 'tools[\\/]restart-dsh\.mjs') { return $true }
    }
    return $false
}

try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
} catch {
    Write-WatchEvent ('UI Automation could not start: ' + $_.Exception.Message)
    exit 1
}

Write-WatchEvent ("Watcher started; restart after {0}s of continuous Reconnecting." -f $ReconnectSeconds)
while ($true) {
    try {
        if (Test-HarnessReconnecting) {
            if ($null -eq $reconnectingSince) {
                $reconnectingSince = [DateTime]::UtcNow
                Write-WatchEvent 'Harness entered Reconnecting state.'
            }
            $duration = ([DateTime]::UtcNow - $reconnectingSince).TotalSeconds
            $cooldownReady = ([DateTime]::UtcNow - $lastRestart).TotalSeconds -ge $RestartCooldownSeconds
            if ($duration -ge $ReconnectSeconds -and $cooldownReady -and -not (Test-RestartInProgress)) {
                Write-WatchEvent ("Reconnecting persisted for {0}s; requesting the safe DSH restart and session continuation." -f [int]$duration)
                $arguments = '"{0}" --delay 2' -f $restartScript
                Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $proxyDirectory -WindowStyle Hidden
                $lastRestart = [DateTime]::UtcNow
                $reconnectingSince = $null
            }
        } elseif ($null -ne $reconnectingSince) {
            Write-WatchEvent 'Harness connection recovered before the restart threshold.'
            $reconnectingSince = $null
        }
    } catch {
        Write-WatchEvent ('Watcher check failed: ' + $_.Exception.Message)
    }
    Start-Sleep -Seconds $PollSeconds
}
