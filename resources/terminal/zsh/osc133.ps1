# ── SoC Verify Shell Integration: OSC 133 序列（PowerShell）────────
#
# 通过 -NoProfile -NoExit -ExecutionPolicy Bypass -File <path>/osc133.ps1 启动。
# 先加载用户 profile（若存在），再注入 OSC 钩子。
#
# 兼容性：必须兼容 Windows PowerShell 5.1 —— 不要使用 `e 转义符
# （PowerShell 6+ 才支持），PS 5.1 会原样输出字面量 "e"，导致终端
# 出现 "e]133;A" 之类的乱码。统一使用 [char]27（ESC）/ [char]7（BEL）。
#
# ⚠ 重要实现约束（VS Code shell integration 同款模式）：
#   OSC 序列必须作为 prompt 函数【返回字符串的前缀】输出，禁止在
#   prompt 内用 [Console]::Write 直接写 stdout —— PSReadLine 会在
#   conPTY 下跟踪光标位置，绕过它直接写 console 会导致渲染状态
#   错乱（表现为 prompt 永远不出现、光标空闪、无法输入）。
#
# OSC 133 协议：
#   OSC 133;A    — 命令行开始（Prompt 渲染完成后）
#   OSC 133;C    — 命令输出前（用户按下 Enter 后）
#   OSC 133;D;<exit_code> — 命令完成（携带退出码）

# ── 加载用户 PowerShell profile ────────────────────────────────────
if (Test-Path $PROFILE) {
    . $PROFILE
}

# ── 转义字符（PS 5.1 兼容）─────────────────────────────────────────
$global:__socverify_esc = [char]27  # ESC — OSC 序列开始
$global:__socverify_bel = [char]7   # BEL — OSC 序列结束

# ── preexec 标记：记录"命令已开始执行"──────────────────────────────
# 与 osc133.zsh 的 __socverify_preexec_done 同款机制：
# ReadLine 包装置位 → 下一次 prompt 渲染时先补发 D 标记（携带退出码）。
$global:__socverify_preexec_done = $false

# ── 保存原始 prompt 函数 ──────────────────────────────────────────
# 必须在覆盖 global:prompt 之前捕获，否则捕获到的是本脚本定义的
# prompt，调用时会无限递归。
$global:__socverify_OriginalPrompt = Get-Command prompt -ErrorAction SilentlyContinue
if ($global:__socverify_OriginalPrompt) {
    $global:__socverify_OriginalPrompt = $global:__socverify_OriginalPrompt.ScriptBlock
}

# ── 覆盖 prompt 函数：OSC 序列作为返回字符串前缀 ──────────────────
function global:prompt {
    $oscPrefix = ''

    # D 标记：上一条命令完成（携带退出码）——仅当 preexec 已置位
    if ($global:__socverify_preexec_done) {
        $exitCode = if ($null -ne $global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
        $oscPrefix += "$__socverify_esc]133;D;$exitCode$__socverify_bel"
        $global:__socverify_preexec_done = $false
    }

    # A 标记（命令行开始）
    $oscPrefix += "$__socverify_esc]133;A$__socverify_bel"

    # 调用原始 prompt 或使用默认 prompt；异常时回退到路径提示，
    # 保证 prompt 永远有返回值（返回 $null 会让终端没有任何输出）
    $promptText = try {
        if ($global:__socverify_OriginalPrompt) {
            $rendered = & $global:__socverify_OriginalPrompt
            if ($null -eq $rendered) {
                "PS $($executionContext.SessionState.Path.CurrentLocation.Path)> "
            } else {
                $rendered
            }
        } else {
            "PS $($executionContext.SessionState.Path.CurrentLocation.Path)> "
        }
    } catch {
        "PS $($executionContext.SessionState.Path.CurrentLocation.Path)> "
    }

    return "$oscPrefix$promptText"
}

# ── C 标记（preexec）：包装 PSConsoleHostReadLine ─────────────────
# 与 VS Code shell integration 同款思路：包装读取行函数而非替换
# Enter 键处理 —— 替换 Enter 一旦 handler 出错会导致所有键盘输入失效。
# 注意：-File 启动时 PSReadLine 通常尚未加载，这里显式 Import 一次，
# 让 PSConsoleHostReadLine 函数在脚本阶段即可被包装。
if (-not (Get-Command 'PSConsoleHostReadLine' -ErrorAction SilentlyContinue)) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
}
if (Get-Command 'PSConsoleHostReadLine' -ErrorAction SilentlyContinue) {
    $global:__socverify_OriginalReadLine = (Get-Command PSConsoleHostReadLine).ScriptBlock
    function global:PSConsoleHostReadLine {
        $line = & $global:__socverify_OriginalReadLine
        if ($null -ne $line -and $line.Trim().Length -gt 0) {
            # C 标记直接写 console 是安全的：此时上一轮 ReadLine 已结束、
            # 新一轮 prompt 尚未开始，不存在 PSReadLine 光标状态冲突。
            [Console]::Write("$__socverify_esc]133;C$__socverify_bel")
            $global:__socverify_preexec_done = $true
        }
        return $line
    }
}
