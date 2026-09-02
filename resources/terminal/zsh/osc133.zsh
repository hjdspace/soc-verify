# ── SoC Verify Shell Integration: OSC 133 序列（zsh）─────────────
#
# 参考 VS Code MIT 开源实现（shellIntegration.zsh）的核心 OSC 133 序列发送模式，
# 精简为本项目所需的 3 标记版本。
#
# OSC 133 协议：
#   OSC 133;A    — 命令行开始（Prompt 渲染完成后、用户输入前）
#   OSC 133;C    — 命令输出前（用户按下 Enter 后、命令输出前）
#   OSC 133;D;<exit_code> — 命令完成（命令结束后，携带退出码）
#
# TerminalView 通过 xterm.js parser.registerOscHandler(133, ...) 解析这些序列，
# 在命令边界渲染装饰器（退出码图标、执行时间等）。
#
# 仅对 Enhanced Terminal（交互式终端）生效。仿真终端不 source 此脚本。

# 发送 OSC 序列的辅助函数
# \e] = ESC ]（OSC 开始），\a = BEL（OSC 结束）
__socverify_osc133_send() {
  printf '\e]%s\a' "$1"
}

# precmd：在每次 Prompt 显示之前调用
# 发送 A 标记（命令行开始）和上一个命令的 D 标记（若未在 preexec 中发送）
__socverify_osc133_precmd() {
  local exit_code=$?
  # 发送 D 标记（命令完成，携带退出码）——仅当有 preexec 记录时
  if [ -n "${__socverify_preexec_done:-}" ]; then
    __socverify_osc133_send "133;D;${exit_code}"
    __socverify_preexec_done=""
  fi
  # 发送 A 标记（命令行开始）
  __socverify_osc133_send "133;A"
}

# preexec：在用户按下 Enter、命令开始执行之前调用
__socverify_osc133_preexec() {
  # 发送 C 标记（命令输出前）
  __socverify_osc133_send "133;C"
  __socverify_preexec_done=1
}

# 注册 zsh 钩子
# 使用 add-zsh-hook 确保与用户其他钩子兼容
if command -v add-zsh-hook &>/dev/null; then
  add-zsh-hook precmd __socverify_osc133_precmd
  add-zsh-hook preexec __socverify_osc133_preexec
else
  # 回退：直接追加到 precmd/preexec 数组
  precmd_functions+=(__socverify_osc133_precmd)
  preexec_functions+=(__socverify_osc133_preexec)
fi

# 首次加载时发送 A 标记（标记第一个 Prompt 的开始）
__socverify_osc133_send "133;A"
