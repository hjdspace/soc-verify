# ── SoC Verify Enhanced Terminal .zshrc ────────────────────────────
#
# 加载顺序（重要）：
#   1. source ~/.zshrc（保留用户自定义配置，若存在）
#   2. source osc133.zsh（Shell Integration 脚本，发送 OSC 133 序列）
#   3. source zsh-autosuggestions（命令预测插件，若存在）
#   4. eval "$(starship init zsh)"（Prompt 美化，在 OSC 133 标记之后初始化）
#
# ZDOTDIR 设置后 zsh 从该目录读取 .zshrc 而非 ~/.zshrc，
# 因此必须显式 source 用户原始 .zshrc 以保留自定义配置。

# ── 1. 加载用户自定义 .zshrc ────────────────────────────────────────
if [ -r "${HOME}/.zshrc" ]; then
  source "${HOME}/.zshrc"
fi

# ── 2. Shell Integration 脚本（OSC 133 序列）──────────────────────
# osc133.zsh 与本文件同目录（ZDOTDIR 指向 resources/terminal/zsh/）
if [ -r "${ZDOTDIR}/osc133.zsh" ]; then
  source "${ZDOTDIR}/osc133.zsh"
fi

# ── 3. zsh-autosuggestions（命令预测）─────────────────────────────
# 插件通过 download:zsh-plugins 脚本下载到 plugins/zsh-autosuggestions/
if [ -r "${ZDOTDIR}/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh" ]; then
  source "${ZDOTDIR}/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
  # 建议颜色：灰色
  ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=8'
fi

# ── 4. Starship Prompt 美化 ───────────────────────────────────────
# STARSHIP_CONFIG 环境变量由 TerminalManager 设置，指向打包的 starship.toml
# eval 在 osc133.zsh 之后，确保 Starship 的 Prompt 渲染在 OSC 133;A 标记之后
if command -v starship &>/dev/null; then
  eval "$(starship init zsh)"
fi
