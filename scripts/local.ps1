#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'status', 'stop')]
    [string]$Action = 'status',
    [switch]$Json
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskRuntime = Join-Path $taskRoot '.copage-local'
$taskStatePath = Join-Path $taskRuntime 'session.json'
$taskState = [ordered]@{ version = 1; root = $taskRoot; backend = $null; frontend = $null }
$taskPorts = @{ backend = 8080; frontend = 5173 }
$taskLock = $null
$taskStarted = @()
$taskPreviousLocation = Get-Location

function Assert-RuntimePath {
    foreach ($taskPath in @($taskRuntime, $taskStatePath, (Join-Path $taskRuntime 'control.lock'))) {
        if (Test-Path -LiteralPath $taskPath) {
            if ((Get-Item -LiteralPath $taskPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw '运行记录目录或文件是链接，已停止操作；请核对 .copage-local。'
            }
        }
    }
}

function Read-RunState {
    Assert-RuntimePath
    if (Test-Path -LiteralPath $taskStatePath) {
        $taskSaved = Get-Content -LiteralPath $taskStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($taskSaved.version -ne 1 -or $taskSaved.root -ne $taskRoot) {
            throw '运行记录与当前项目不一致，未接管或停止任何进程。'
        }
        $taskState.backend = $taskSaved.backend
        $taskState.frontend = $taskSaved.frontend
    }
}

function Save-RunState {
    Assert-RuntimePath
    $taskTemporary = Join-Path $taskRuntime ('session-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($taskTemporary, ($taskState | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $taskTemporary -Destination $taskStatePath -Force
}

function Get-Tool([string]$Name) {
    $taskCommand = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $taskCommand) { throw "未找到 $Name，请按 README 安装并加入 PATH 后重试。" }
    return $taskCommand.Source
}

function Get-ProcessInfo([int]$ProcessId) {
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-ProjectProcess($ProcessInfo, [string]$Role) {
    if (-not $ProcessInfo -or -not $ProcessInfo.CommandLine) { return $false }
    $taskExpectedName = if ($Role -eq 'backend') { 'java.exe' } else { 'node.exe' }
    $taskDirectory = ($taskRoot.Replace('\', '/') + '/' + $Role + '/').ToLowerInvariant()
    return $ProcessInfo.Name -eq $taskExpectedName -and
        $ProcessInfo.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($taskDirectory)
}

function Test-OwnedProcess($Record, $ProcessInfo, [string]$Role) {
    if (-not $Record -or $Record.owned -isnot [bool] -or -not $Record.owned -or -not $ProcessInfo) { return $false }
    foreach ($taskField in @('pid', 'creationUtc', 'startedUtcTicks', 'commandLine', 'executable')) {
        if (-not $Record.PSObject.Properties[$taskField]) { return $false }
    }
    # PowerShell 7 会将 JSON 的 ISO 时间自动转成 DateTime；5.1 保留字符串。
    # 比较同一 UTC 时刻，避免 JSON 往返后的类型或小数位变化误判身份。
    try {
        $taskCreation = if ($Record.creationUtc -is [DateTime]) { $Record.creationUtc } else {
            [DateTime]::Parse([string]$Record.creationUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        }
        $taskSameCreation = $taskCreation.ToUniversalTime().Ticks -eq $ProcessInfo.CreationDate.ToUniversalTime().Ticks
    } catch { return $false }
    return (Test-ProjectProcess $ProcessInfo $Role) -and $Record.pid -eq $ProcessInfo.ProcessId -and
        $taskSameCreation -and
        $Record.commandLine -ceq $ProcessInfo.CommandLine -and $Record.executable -eq $ProcessInfo.ExecutablePath
}

function Get-HttpStatus([string]$Role) {
    $taskUrl = if ($Role -eq 'backend') { 'http://localhost:8080/api/doc/list' } else { 'http://localhost:5173/login' }
    $taskClient = [Net.Http.HttpClient]::new()
    $taskClient.Timeout = [TimeSpan]::FromSeconds(2)
    try {
        $taskResponse = $taskClient.GetAsync($taskUrl).GetAwaiter().GetResult()
        try { return [int]$taskResponse.StatusCode } finally { $taskResponse.Dispose() }
    } catch { return 0 } finally { $taskClient.Dispose() }
}

function Get-InfrastructureSnapshot {
    $taskDockerCommand = Get-Command 'docker.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $taskRows = @()
    $taskAvailable = $false
    if ($taskDockerCommand) {
        $ErrorActionPreference = 'Continue'
        $taskOutput = & $taskDockerCommand.Source compose ps --all --format json 2> $null
        $taskCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($taskCode -eq 0) {
            $taskAvailable = $true
            $taskRows = @($taskOutput | ForEach-Object { $_ | ConvertFrom-Json })
        }
    }
    $taskServices = @()
    foreach ($taskService in @('mysql', 'redis', 'rabbitmq', 'elasticsearch', 'minio', 'minio-init')) {
        $taskRow = @($taskRows | Where-Object { $_.Service -eq $taskService })
        $taskReady = $taskAvailable -and $taskRow.Count -eq 1
        if ($taskReady) {
            if ($taskService -eq 'minio-init') { $taskReady = $taskRow[0].State -eq 'exited' -and $taskRow[0].ExitCode -eq 0 }
            elseif ($taskService -eq 'minio') { $taskReady = $taskRow[0].State -eq 'running' }
            else { $taskReady = $taskRow[0].State -eq 'running' -and $taskRow[0].Health -eq 'healthy' }
        }
        $taskServices += [pscustomobject]@{ name = $taskService; ready = $taskReady }
    }
    return [pscustomobject]@{ dockerAvailable = $taskAvailable; ready = @($taskServices | Where-Object { -not $_.ready }).Count -eq 0; services = $taskServices }
}

function Get-RoleSnapshot([string]$Role) {
    $taskListeners = @(Get-NetTCPConnection -LocalPort $taskPorts[$Role] -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    $taskRecord = $taskState[$Role]
    $taskInfo = $null
    if ($taskListeners.Count -eq 1) { $taskInfo = Get-ProcessInfo $taskListeners[0] }
    elseif ($taskListeners.Count -eq 0 -and $taskRecord -and $taskRecord.owned) { $taskInfo = Get-ProcessInfo $taskRecord.pid }
    $taskProject = $taskListeners.Count -le 1 -and (Test-ProjectProcess $taskInfo $Role)
    $taskCode = if ($taskListeners.Count -eq 1 -and $taskProject) { Get-HttpStatus $Role } else { 0 }
    $taskExpectedCode = if ($Role -eq 'backend') { 401 } else { 200 }
    return [pscustomobject]@{
        role = $Role; port = $taskPorts[$Role]; pid = if ($taskInfo) { $taskInfo.ProcessId } else { $null }
        occupied = $taskListeners.Count -gt 0; projectProcess = $taskProject
        owned = Test-OwnedProcess $taskRecord $taskInfo $Role
        httpStatus = $taskCode; ready = $taskCode -eq $taskExpectedCode
    }
}

function Show-Status {
    $taskBackendStatus = Get-RoleSnapshot 'backend'
    $taskFrontendStatus = Get-RoleSnapshot 'frontend'
    $taskInfrastructure = Get-InfrastructureSnapshot
    $taskStatus = [pscustomobject]@{
        root = $taskRoot; url = 'http://localhost:5173'; backend = $taskBackendStatus; frontend = $taskFrontendStatus
        infrastructure = $taskInfrastructure; ready = $taskBackendStatus.ready -and $taskFrontendStatus.ready -and $taskInfrastructure.ready
    }
    if ($Json) { $taskStatus | ConvertTo-Json -Depth 5; return }
    $taskInfrastructureMessage = if ($taskInfrastructure.ready) { '已就绪' } else { '未就绪：' + ((@($taskInfrastructure.services | Where-Object { -not $_.ready }).name) -join ', ') }
    Write-Output "Docker 基础服务：$taskInfrastructureMessage"
    foreach ($taskRole in @('backend', 'frontend')) {
        $taskItem = $taskStatus.$taskRole
        $taskMessage = if ($taskItem.ready) { '可用' } elseif ($taskItem.occupied) { '端口占用或服务未就绪' } else { '未运行' }
        $taskOwner = if ($taskItem.owned) { '本入口管理' } else { '未接管；stop 不会停止' }
        Write-Output "$taskRole : $taskMessage；端口 $($taskItem.port)；PID $($taskItem.pid)；$taskOwner"
    }
    Write-Output '访问：http://localhost:5173；Docker 基础服务不会由 stop 停止。'
}

function Invoke-LoggedCommand([string]$Executable, [string[]]$Arguments, [string]$LogName) {
    $ErrorActionPreference = 'Continue'
    $taskLog = Join-Path $taskRuntime $LogName
    & $Executable @Arguments *> $taskLog
    if ($LASTEXITCODE -ne 0) { throw "命令未成功，查看本地日志：$taskLog；未删除或重新初始化数据。" }
}

function Invoke-WithEnvironment($Environment, [scriptblock]$Operation) {
    $taskOld = @{}
    try {
        foreach ($taskKey in $Environment.Keys) {
            $taskOld[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process')
            [Environment]::SetEnvironmentVariable($taskKey, [string]$Environment[$taskKey], 'Process')
        }
        & $Operation
    } finally {
        foreach ($taskKey in $taskOld.Keys) { [Environment]::SetEnvironmentVariable($taskKey, $taskOld[$taskKey], 'Process') }
    }
}

function Get-PublishedPort($Config, [string]$Service, [int]$Target) {
    $taskBinding = @($Config.services.$Service.ports | Where-Object { $_.target -eq $Target })
    if ($taskBinding.Count -ne 1 -or [int]$taskBinding[0].published -le 0) { throw "无法确定 $Service 的本机端口，请按 README 手动启动。" }
    return [int]$taskBinding[0].published
}

function Wait-RoleReady([string]$Role) {
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        $taskSnapshot = Get-RoleSnapshot $Role
        if ($taskSnapshot.ready) { return }
        if (-not $taskSnapshot.projectProcess) { throw "$Role 启动失败或进程身份已变化，查看 .copage-local 中的日志。" }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    throw "$Role 在90秒内未就绪，查看 .copage-local 中的日志。"
}

function Start-Role([string]$Role, [string]$Executable, [string[]]$Arguments, $Environment) {
    $taskArgumentLine = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $taskWorkingDirectory = if ($Role -eq 'frontend') { Join-Path $taskRoot 'frontend' } else { $taskRoot }
    $taskProcess = Invoke-WithEnvironment $Environment {
        Start-Process -FilePath $Executable -ArgumentList $taskArgumentLine -WorkingDirectory $taskWorkingDirectory -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $taskRuntime "$Role.out.log") -RedirectStandardError (Join-Path $taskRuntime "$Role.err.log")
    }
    $taskInfo = Get-ProcessInfo $taskProcess.Id
    if (-not $taskInfo -or -not (Test-ProjectProcess $taskInfo $Role)) { throw "$Role 没有建立可核对的进程，查看本地日志。" }
    $taskState[$Role] = [pscustomobject]@{
        owned = $true; pid = $taskInfo.ProcessId; creationUtc = $taskInfo.CreationDate.ToUniversalTime().ToString('o')
        startedUtcTicks = [string]$taskProcess.StartTime.ToUniversalTime().Ticks; commandLine = $taskInfo.CommandLine; executable = $taskInfo.ExecutablePath
    }
    $script:taskStarted += $Role
    Save-RunState
    Wait-RoleReady $Role
}

function Stop-OwnedRole([string]$Role) {
    $taskRecord = $taskState[$Role]
    if (-not $taskRecord -or -not $taskRecord.owned) { Write-Output "$Role 未由本入口启动，保持原样。"; return }
    $taskInfo = Get-ProcessInfo $taskRecord.pid
    if (-not $taskInfo) { $taskState[$Role] = $null; Save-RunState; Write-Output "$Role 已退出。"; return }
    if (-not (Test-OwnedProcess $taskRecord $taskInfo $Role)) { throw "$Role 的PID/启动时间/命令/路径与记录不符，未停止该进程。" }
    $taskProcess = Get-Process -Id $taskRecord.pid -ErrorAction Stop
    try {
        # 访问句柄并再次核对精确启动时间；使用进程对象停止，避免仅凭旧PID。
        $null = $taskProcess.Handle
        if ($taskProcess.StartTime.ToUniversalTime().Ticks -ne [long]$taskRecord.startedUtcTicks) {
            throw "$Role 的进程启动时间已变化，未停止该进程。"
        }
        if (-not $taskProcess.HasExited) {
            $taskProcess.Kill()
            if (-not $taskProcess.WaitForExit(10000)) { throw "$Role 在10秒内未确认退出，已保留记录，请用 status 核对。" }
        }
    } finally { $taskProcess.Dispose() }
    $taskState[$Role] = $null
    Save-RunState
    Write-Output "$Role 已停止；日志和数据保留。"
}

try {
    Add-Type -AssemblyName System.Net.Http
    if ($Json -and $Action -ne 'status') { throw '-Json 仅用于 status。' }
    Set-Location -LiteralPath $taskRoot
    Assert-RuntimePath
    if ($Action -ne 'status') {
        $null = New-Item -ItemType Directory -Path $taskRuntime -Force
        $taskLock = [IO.File]::Open((Join-Path $taskRuntime 'control.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    Read-RunState
    if ($Action -eq 'status') { Show-Status; return }
    if ($Action -eq 'stop') {
        foreach ($taskRole in @('frontend', 'backend')) { Stop-OwnedRole $taskRole }
        Show-Status
        return
    }

    foreach ($taskRole in @('backend', 'frontend')) {
        $taskSnapshot = Get-RoleSnapshot $taskRole
        if ($taskSnapshot.occupied -and -not $taskSnapshot.projectProcess) { throw "端口 $($taskSnapshot.port) 由无法核对的进程占用，未停止或替换它。" }
        if ($taskSnapshot.projectProcess) {
            Wait-RoleReady $taskRole
            Write-Output "$taskRole 已有可用的本项目服务，复用；不会接管其它启动方式的进程。"
        }
    }
    if ((Get-RoleSnapshot 'backend').ready -and (Get-RoleSnapshot 'frontend').ready -and (Get-InfrastructureSnapshot).ready) { Show-Status; return }

    $taskDocker = Get-Tool 'docker.exe'
    $ErrorActionPreference = 'Continue'
    & $taskDocker info --format '{{.ServerVersion}}' *> (Join-Path $taskRuntime 'docker-check.log')
    $taskDockerCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($taskDockerCode -ne 0) { throw 'Docker 引擎不可用。请先启动 Docker Desktop，再执行 start；当前数据未改动。' }
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot '.env'))) { Copy-Item -LiteralPath (Join-Path $taskRoot '.env.example') -Destination (Join-Path $taskRoot '.env') }
    $ErrorActionPreference = 'Continue'
    $taskConfigText = & $taskDocker compose --profile app config --format json 2> (Join-Path $taskRuntime 'compose-config.err.log')
    $taskConfigCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($taskConfigCode -ne 0) { throw 'Compose 配置无法解析，请核对 .env；错误记录在 .copage-local，未打印凭据。' }
    $taskConfig = ($taskConfigText -join "`n") | ConvertFrom-Json
    $taskBackendEnvironment = @{}
    foreach ($taskProperty in $taskConfig.services.backend.environment.PSObject.Properties) { $taskBackendEnvironment[$taskProperty.Name] = [string]$taskProperty.Value }
    if ($taskBackendEnvironment.SPRING_PROFILES_ACTIVE -ne 'default' -or $taskBackendEnvironment.FRONTEND_ORIGIN -ne 'http://localhost:5173') {
        throw '本入口只用于 default profile 和 http://localhost:5173；其它环境请按部署说明启动，未覆盖现有配置。'
    }
    $taskMysqlPort = Get-PublishedPort $taskConfig 'mysql' 3306
    $taskBackendEnvironment.MYSQL_URL = "jdbc:mysql://127.0.0.1:$taskMysqlPort/$($taskConfig.services.mysql.environment.MYSQL_DATABASE)?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&useSSL=false"
    $taskBackendEnvironment.REDIS_HOST = '127.0.0.1'; $taskBackendEnvironment.REDIS_PORT = Get-PublishedPort $taskConfig 'redis' 6379
    $taskBackendEnvironment.REDIS_PASSWORD = ''
    $taskBackendEnvironment.RABBITMQ_HOST = '127.0.0.1'; $taskBackendEnvironment.RABBITMQ_PORT = Get-PublishedPort $taskConfig 'rabbitmq' 5672
    $taskBackendEnvironment.ELASTICSEARCH_URIS = 'http://127.0.0.1:' + (Get-PublishedPort $taskConfig 'elasticsearch' 9200)
    $taskBackendEnvironment.MINIO_ENDPOINT = 'http://127.0.0.1:' + (Get-PublishedPort $taskConfig 'minio' 9000)
    Write-Output '检查并启动本项目基础服务；保留已有容器和数据卷。'
    Invoke-LoggedCommand $taskDocker @('compose', 'up', '-d', '--no-recreate', 'mysql', 'redis', 'rabbitmq', 'elasticsearch', 'minio', 'minio-init') 'compose-start.log'
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(180)
    do {
        $taskPending = @((Get-InfrastructureSnapshot).services | Where-Object { -not $_.ready } | Select-Object -ExpandProperty name)
        if ($taskPending.Count -eq 0) { break }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $taskDeadline)
    if ($taskPending.Count -gt 0) { throw ('基础服务未就绪：' + ($taskPending -join ', ') + '；未删除数据卷。') }

    if (-not (Get-RoleSnapshot 'backend').ready) {
        Write-Output '构建当前 Java 后端；构建失败时保留日志，不启动旧产物。'
        Invoke-LoggedCommand (Get-Tool 'mvn.cmd') @('-f', 'backend/pom.xml', '-DskipTests', 'package', '-q') 'build-backend.log'
        $taskJar = Join-Path $taskRoot 'backend/target/collab-docs-backend-0.0.1-SNAPSHOT-exec.jar'
        Start-Role 'backend' (Get-Tool 'java.exe') @('-jar', $taskJar, '--server.address=127.0.0.1') $taskBackendEnvironment
    }
    if (-not (Get-RoleSnapshot 'frontend').ready) {
        $taskNode = Get-Tool 'node.exe'
        $taskNodeVersion = (& $taskNode --version).Trim().TrimStart('v')
        if ([version]$taskNodeVersion -lt [version]'22.12.0') { throw 'Node.js 需为22.12或更新版本，未更改已安装的工具。' }
        Write-Output '安装锁文件中的前端依赖并构建本地生产预览。'
        $taskNpmCache = Join-Path $taskRuntime 'npm-cache'
        $taskNodeModules = Join-Path $taskRoot 'frontend/node_modules'
        foreach ($taskDirectory in @($taskNpmCache, $taskNodeModules)) {
            if ((Test-Path -LiteralPath $taskDirectory) -and ((Get-Item -LiteralPath $taskDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'npm缓存或node_modules是链接，未删除或修改其目标；请按README手动安装。'
            }
        }
        Invoke-LoggedCommand (Get-Tool 'npm.cmd') @('--cache', $taskNpmCache, '--prefix', 'frontend', 'ci', '--prefer-offline', '--no-audit', '--no-fund') 'install-frontend.log'
        $taskFrontendEnvironment = @{ VITE_BACKEND_HTTP_ORIGIN = 'http://localhost:8080'; VITE_BACKEND_WS_ORIGIN = 'ws://localhost:8080' }
        Invoke-WithEnvironment $taskFrontendEnvironment { Invoke-LoggedCommand (Get-Tool 'npm.cmd') @('--cache', $taskNpmCache, '--prefix', 'frontend', 'run', 'build') 'build-frontend.log' }
        Start-Role 'frontend' $taskNode @((Join-Path $taskRoot 'frontend/node_modules/vite/bin/vite.js'), 'preview', '--host', 'localhost', '--port', '5173', '--strictPort') @{}
    }
    Show-Status
} catch {
    $taskFailureMessage = $_.Exception.Message
    foreach ($taskRole in @('frontend', 'backend')) {
        if ($taskStarted -contains $taskRole) {
            try { Stop-OwnedRole $taskRole } catch { Write-Warning "$taskRole 身份核对失败，未强行停止。请用 status 核对。" }
        }
    }
    Write-Error $taskFailureMessage -ErrorAction Continue
    exit 1
} finally {
    if ($taskLock) { $taskLock.Dispose() }
    Set-Location -LiteralPath $taskPreviousLocation.Path
}
