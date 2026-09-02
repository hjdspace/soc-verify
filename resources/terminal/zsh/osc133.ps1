# ── SoC Verify Shell Integration: OSC 133 序列（PowerShell）────────
#
# 通过 -NoProfile -ExecutionPolicy Bypass -File <path>/osc133.ps1 启动。
# 先加载用户 profile（若存在），再注入 OSC 钩子。
#
# OSC 133 协议：
#   OSC 133;A    — 命令行开始（Prompt 渲染完成后）
#   OSC 133;C    — 命令输出前（用户按下 Enter 后）
#   OSC 133;D;<exit_code> — 命令完成（携带退出码）

# ── 加载用户 PowerShell profile ────────────────────────────────────
if (Test-Path $PROFILE) {
    . $PROFILE
}

# ── OSC 133 序列发送函数 ──────────────────────────────────────────
function __socverify_Osc133Send([string]$sequence) {
    [Console]::Write("`e]$sequence`a")
}

# ── preprompt 钩子：Prompt 显示前发送 A 标记 ──────────────────────
function __socverify_Osc133PrePrompt([string]$color) {
    __socverify_Osc133Send "133;A"
}

# ── preexec 钩子：命令执行前发送 C 标记 ───────────────────────────
function __socverify_Osc133PreExec([string]$command) {
    __socverify_Osc133Send "133;C"
}

# ── postexec 钩子：命令完成后发送 D 标记 ──────────────────────────
function __socverify_Osc133PostExec([string]$command, [string]$output, [int]$exitCode) {
    __socverify_Osc133Send "133;D;$exitCode"
}

# ── 注册 PowerShell 钩子 ───────────────────────────────────────────
# 通过覆盖 prompt 函数，在 prompt 渲染前发送 A 标记
# 保存原始 prompt 函数（如果存在）
$__socverify_OriginalPrompt = Get-Command prompt -ErrorAction SilentlyContinue

function global:prompt {
    # 发送 A 标记（命令行开始）
    __socverify_Osc133Send "133;A"

    # 调用原始 prompt 或使用默认 prompt
    if ($__socverify_OriginalPrompt) {
        & $__socverify_OriginalPrompt.ScriptBlock
    } else {
        # 默认 PowerShell prompt：显示当前位置
        $path = $executionContext.SessionState.Path.CurrentLocation.Path
        "$path> "
    }
}

# 通过 Out-Default 钩子发送 C/D 标记
# 使用 PowerShell 事件：在命令执行前后发送序列
# 使用 PSReadLine 钩子（若可用）发送 preexec/postexec
if (Get-Module -ListAvailable PSReadLine) {
    # preexec：在用户按下 Enter 后、命令执行前发送 C 标记
    Set-PSReadLineKeyHandler -Key Enter -BriefDescription 'socverify-osc133-preexec' -LongDescription 'Send OSC 133;C before command execution' -ScriptBlock {
        # 获取当前命令行
        $line = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$null)
        if ($line.Trim().Length -gt 0) {
            [Console]::Write("`e]133;C`a")
        }
        # 执行原始 Enter 行为
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}

# postexec：在命令完成后发送 D 标记
# 通过覆盖 Out-Default 实现（每次命令输出后触发）
$__socverify_LastExitCode = 0

function global:Out-Default {
    begin {
        # 保存上一次的 $LASTEXITCODE
        $__socverify_LastExitCode = $global:LASTEXITCODE
    }
    process {
        # 正常输出
        $input | & $realCmd
    }
    end {
        # 发送 D 标记（命令完成，携带退出码）
        $exitCode = if ($__socverify_LastExitCode) { $__socverify_LastExitCode } else { 0 }
        [Console]::Write("`e]133;D;$exitCode`a")
    }
}

# 首次加载时发送 A 标记
__socverify_Osc133Send "133;A"
