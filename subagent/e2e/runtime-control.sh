#!/usr/bin/env bash
# 端到端验证：运行时常驻面板 + 干预浮层（steer / abort / currentAction 可见性）
#
# 用法：bash subagent/e2e/runtime-control.sh
#
# 断言（全部从 tmux capture-pane 实抓快照取证，脚本不注入任何伪造文本）：
#   [1] 面板出现：编辑器下方出现 `● runtime-e2e`（只断言「出现」，不做位置断言）
#   [2] 面板耗时列严格递增：两次抓取同一运行行的 `· NN s ·` 数字，B-A >= 1
#   [3] /agents-ps 唤出干预浮层：出现 `子代理运行时 (N)`
#   [4] steer 注入生效：浮层出现 `已注入指令`，且浮层选中行出现 `↩1`
#   [5] `x` 中止选中项（设计指定）：严格匹配面板终态行 `⊘ runtime-e2e · `；
#       notice（已中止…）仅作辅助证据打印，**不进入判定**
#   [5b] 父工具结果卡片含 `aborted`
#   [5c] 重试守卫：检测父模型是否自行重试 subagent（若重试则后续断言可能失真）
#   [6] 【看得见】运行期间面板行含 `bash:`；且终态行不显示旧动作（不含 `bash:`）
#   [7] 终态 3s 保留期后常驻面板消失（无 `[✓⊘✗] runtime-e2e ·`、无 `● runtime-e2e`）
#   [8] 无 running 时 /agents-ps → `没有运行中的子代理`
#   WARN best-effort：工具结束后 currentAction 应回退到 lastLine/(thinking…)。
#       该回退窗口长度取决于模型吐字（tool_execution_end → 下一条 message_end）的
#       时长，轮询窗口内观测不到只告警、不判失败。
#
# 环境隔离：本脚本在私有 HOME + 私有 PI_CODING_AGENT_DIR 下运行 pi，
# 避免 stats.ts（走 os.homedir()）污染真实 ~/.pi/agent/agents-stats.json。
# 失败时打印最后快照、原始快照路径与 agent 目录日志路径；trap 清理 tmux 会话。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="pi-subagent-e2e-$$"
TMP="$(mktemp -d)"
# 先记录真实 HOME / agent 目录，再切换隔离 HOME（凭据来源仍是真实目录）
REAL_HOME="${HOME}"
REAL_AGENT_DIR="${REAL_HOME}/.pi/agent"
AGENT_DIR="$TMP/agent"           # PI_CODING_AGENT_DIR（agents + auth/settings/models）
HOME_AGENT_DIR="$TMP/home/.pi/agent" # 隔离 HOME 下的 ~/.pi/agent（stats/sessions 落点）
PASS=0
FAIL=0
WARN=0
LAST_SNAP="$TMP/pane.txt"

cleanup() {
	tmux kill-session -t "$SESSION" 2>/dev/null
	rm -rf "$TMP"
}
# EXIT 统一清理；INT/TERM 先退出再触发 EXIT（原样保留失败现场供 cat）
trap cleanup EXIT
trap 'exit 130' INT TERM

ok()   { echo "  ✅ PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "  ❌ FAIL: $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠️  WARN: $1"; WARN=$((WARN + 1)); }
ev()   { echo "     证据: $1"; }
snap() { tmux capture-pane -t "$SESSION" -p > "$LAST_SNAP" 2>/dev/null || true; }

# 失败现场：原始快照 + agent 目录日志路径（含内容 tail）
dump_failure() {
	echo "---- 最后快照（原始 capture-pane）----"
	cat "$LAST_SNAP" 2>/dev/null || true
	echo "---- 原始快照文件 ----"
	echo "  LAST_SNAP=$LAST_SNAP"
	echo "---- agent 目录日志路径 ----"
	for f in "$AGENT_DIR/pi-debug.log" "$HOME_AGENT_DIR/pi-debug.log"; do
		echo "  $f"
		if [ -f "$f" ]; then
			echo "  ---- tail -n 40 $(basename "$f") ----"
			tail -n 40 "$f" 2>/dev/null || true
		fi
	done
}

# ---------------------------------------------------------------------------
# 前置检查：环境不满足时如实报告，不伪造 PASS
# ---------------------------------------------------------------------------
command -v tmux >/dev/null 2>&1 || { echo "❌ 环境缺少 tmux，无法运行 E2E"; exit 2; }
command -v pi   >/dev/null 2>&1 || { echo "❌ 环境缺少 pi"; exit 2; }
[ -f "$REAL_AGENT_DIR/auth.json" ] || {
	echo "❌ 未找到 $REAL_AGENT_DIR/auth.json（无可用 provider 凭据）"
	exit 2
}

# ---- 隔离环境：私有 HOME + 私有 agent 目录 ----
export HOME="$TMP/home"
mkdir -p "$AGENT_DIR/agents" "$HOME_AGENT_DIR"
cp -f "$ROOT/subagent/e2e/agents/runtime-e2e.md" "$AGENT_DIR/agents/"
for d in "$AGENT_DIR" "$HOME_AGENT_DIR"; do
	for f in auth.json settings.json models-store.json; do
		cp -f "$REAL_AGENT_DIR/$f" "$d/$f" 2>/dev/null || true
	done
done

# 模型分两次调用 bash：第一次 sleep 8（结束后可观测 currentAction 回退），
# 第二次 sleep 90（留足窗口给浮层 steer / abort）。若模型合并为一次调用，
# best-effort 回退观测将 WARN，abort 仍可验证。
PROMPT='立即用 subagent 工具以 single 模式调用 runtime-e2e，任务：分两次调用 bash，第一次命令 `sleep 8`，第二次命令 `sleep 90`，完成后报告"已完成"。重要：无论这次 subagent 调用成功、失败还是被中止，都不要重试、不要再次调用 subagent 工具，直接结束回合并简短说明结果。'

tmux kill-session -t "$SESSION" 2>/dev/null
# 环境变量写进命令串（tmux server 可能复用旧环境，不能只依赖脚本 export）
if ! tmux new-session -d -s "$SESSION" -x 220 -y 50 \
	"cd '$ROOT' && HOME='$TMP/home' PI_CODING_AGENT_DIR='$AGENT_DIR' pi --no-session --no-extensions --no-skills -e ./subagent/index.ts '$PROMPT'"; then
	echo "❌ tmux new-session 启动失败" >&2
	exit 3
fi

# ---------------------------------------------------------------------------
echo "[1] 等待子代理启动与面板出现（● runtime-e2e）…"
STARTED=0
PANEL_LINE=""
for _ in $(seq 1 120); do
	sleep 1
	snap
	PANEL_LINE="$(grep -m1 '● runtime-e2e' "$LAST_SNAP" || true)"
	if [ -n "$PANEL_LINE" ]; then STARTED=1; break; fi
done
if [ "$STARTED" = "1" ]; then
	# 只断言「面板出现」：位置断言（输入框下方 / 末行提示行上方）对 TUI 布局过脆，
	# 宁可不做也不让文案超出断言范围。
	ok "面板出现"
	ev "$PANEL_LINE"
else
	bad "面板未出现（等待 120s）"
	dump_failure
	exit 1
fi

# ---------------------------------------------------------------------------
echo "[6a] 断言运行期间面板展示 currentAction（行内含 'bash:'）…"
SAW_BASH=0
BASH_LINE=""
for _ in $(seq 1 160); do
	snap
	BASH_LINE="$(grep -m1 '● runtime-e2e.*bash:' "$LAST_SNAP" || true)"
	if [ -n "$BASH_LINE" ]; then SAW_BASH=1; break; fi
	sleep 0.5
done
if [ "$SAW_BASH" = "1" ]; then ev "运行行: $BASH_LINE"; else ev "未在 80s 内抓到含 bash: 的运行行"; fi

# ---------------------------------------------------------------------------
# 从面板运行行抽取耗时秒数（严格匹配 `· <elapsed> ·` 字段，避免误取其它数字）。
# formatElapsed 支持 `NNs` / `NmNNs` / `NhNNm` 三种形式；慢 provider 下秒数可能超过
# 60s 显示为 `1m23s`，旧实现只认 `NNs` 会让断言 [2] 假失败。这里统一转成秒。
elapsed_of() {
	local raw
	raw="$(printf '%s' "$1" | sed -nE 's/.*· ([0-9]+h[0-9]+m|[0-9]+m[0-9]+s|[0-9]+s) ·.*/\1/p' | head -1)"
	case "$raw" in
		*h*)
			local h rest m
			h="${raw%%h*}"; rest="${raw#*h}"; m="${rest%m}"
			echo $((10#$h * 3600 + 10#$m * 60))
			;;
		*m*)
			local m rest s
			m="${raw%%m*}"; rest="${raw#*m}"; s="${rest%s}"
			echo $((10#$m * 60 + 10#$s))
			;;
		*s)
			echo "$((10#${raw%s}))"
			;;
	esac
}

echo "[2] 断言耗时列严格递增（面板在刷新）…"
snap; cp -f "$LAST_SNAP" "$TMP/pane_a.txt"
LINE_A="$(grep -m1 '● runtime-e2e' "$TMP/pane_a.txt" || true)"
sleep 3
snap; cp -f "$LAST_SNAP" "$TMP/pane_b.txt"
LINE_B="$(grep -m1 '● runtime-e2e' "$TMP/pane_b.txt" || true)"
A_SEC="$(elapsed_of "$LINE_A")"
B_SEC="$(elapsed_of "$LINE_B")"
if [ -n "$A_SEC" ] && [ -n "$B_SEC" ] && [ "$B_SEC" -gt "$A_SEC" ] && [ "$((B_SEC - A_SEC))" -ge 1 ]; then
	ok "面板耗时严格递增（Δt=${A_SEC}s→${B_SEC}s）"
	ev "t0: $LINE_A"
	ev "t1: $LINE_B"
else
	bad "面板耗时未严格递增（抽到的秒数：t0='${A_SEC:-<无>}' t1='${B_SEC:-<无>}'）"
	ev "t0: ${LINE_A:-<无>}"
	ev "t1: ${LINE_B:-<无>}"
fi

# ---------------------------------------------------------------------------
# best-effort：工具结束后 currentAction 回退到 lastLine/(thinking…)
# 轮询窗口 20s（覆盖第一次 sleep 8 的自然结束 + 模型吐字间隔）。
# 窗口依赖模型吐字时长：若模型在 tool_execution_end 后立刻发出下一条消息，
# 回退态可能短于一帧而无法被 capture-pane 捕获 —— 此时只 WARN。
echo "[WARN-check] 观测工具结束后 currentAction 是否回退（best-effort）…"
FALLBACK=0
FALLBACK_LINE=""
LAST_RUN_LINE=""
for _ in $(seq 1 40); do
	snap
	LINE="$(grep -m1 '● runtime-e2e' "$LAST_SNAP" || true)"
	[ -n "$LINE" ] && LAST_RUN_LINE="$LINE"
	if [ -n "$LINE" ] && ! printf '%s' "$LINE" | grep -q 'bash:' \
		&& ! printf '%s' "$LINE" | grep -q '启动中'; then
		FALLBACK=1; FALLBACK_LINE="$LINE"; break
	fi
	if grep -q -E '[✓⊘✗] runtime-e2e · ' "$LAST_SNAP"; then break; fi
	sleep 0.5
done
if [ "$FALLBACK" = "1" ]; then
	echo "  ℹ️  已观测到回退态: $FALLBACK_LINE"
else
	warn "未在轮询窗口内观测到 currentAction 回退（窗口依赖模型吐字时长，非失败）"
	ev "窗口末尾运行行: ${LAST_RUN_LINE:-<无>}"
fi

# ---------------------------------------------------------------------------
echo "[3] 发 /agents-ps 唤出干预浮层…"
tmux send-keys -t "$SESSION" "/agents-ps"; sleep 1; tmux send-keys -t "$SESSION" Enter
OVERLAY=0
OVERLAY_LINE=""
for _ in $(seq 1 15); do
	sleep 1
	snap
	OVERLAY_LINE="$(grep -m1 '子代理运行时 (' "$LAST_SNAP" || true)"
	if [ -n "$OVERLAY_LINE" ]; then OVERLAY=1; break; fi
done
if [ "$OVERLAY" = "1" ]; then
	ok "浮层出现"
	ev "$OVERLAY_LINE"
else
	bad "浮层未出现"
	ev "未在 15s 内抓到 '子代理运行时 ('"
fi

# ---------------------------------------------------------------------------
echo "[4] 注入 steer 指令（并断言浮层选中行出现 ↩1）…"
tmux send-keys -t "$SESSION" "s"
sleep 1
tmux send-keys -t "$SESSION" "STEERED"
sleep 1
tmux send-keys -t "$SESSION" Enter
STEERED=0
STEER_LINE=""
STEER_ROW=""
for _ in $(seq 1 10); do
	sleep 1
	snap
	[ -z "$STEER_LINE" ] && STEER_LINE="$(grep -m1 '已注入指令' "$LAST_SNAP" || true)"
	[ -z "$STEER_ROW" ] && STEER_ROW="$(grep -m1 -E '▸ .*runtime-e2e.*↩1' "$LAST_SNAP" || true)"
	if [ -n "$STEER_LINE" ] && [ -n "$STEER_ROW" ]; then STEERED=1; break; fi
done
if [ "$STEERED" = "1" ]; then
	ok "steer 已注入（notice + 浮层行 ↩1）"
	ev "notice: $STEER_LINE"
	ev "浮层行: $STEER_ROW"
else
	bad "steer 未完全生效（notice='${STEER_LINE:-<无>}' 浮层行↩1='${STEER_ROW:-<无>}'）"
fi

# ---------------------------------------------------------------------------
echo "[5] 中止选中项（x，设计指定动作）…"
tmux send-keys -t "$SESSION" "x"
ABORT_NOTICE=""
ABORT_TERM=""
# 严格抓面板终态行（保留期仅 3s，尽快抓）；notice 只作辅助证据
for _ in $(seq 1 40); do
	sleep 0.5
	snap
	[ -z "$ABORT_NOTICE" ] && ABORT_NOTICE="$(grep -m1 '已中止' "$LAST_SNAP" || true)"
	ABORT_TERM="$(grep -m1 -E '⊘ runtime-e2e · ' "$LAST_SNAP" || true)"
	if [ -n "$ABORT_TERM" ]; then break; fi
done
echo "  ℹ️  浮层 notice（仅辅助，不进入判定）: ${ABORT_NOTICE:-<无>}"

# 关闭浮层，露出父工具结果卡片
tmux send-keys -t "$SESSION" Escape
CARD_ABORT=""
for _ in $(seq 1 30); do
	sleep 0.5
	snap
	# 卡片行含 aborted，排除面板终态行（面板 action 文本本身即 'aborted'）
	CARD_ABORT="$(grep -E 'aborted' "$LAST_SNAP" | grep -v -E '[✓⊘✗] runtime-e2e · ' | head -1 || true)"
	if [ -n "$CARD_ABORT" ]; then break; fi
done

if [ -n "$ABORT_TERM" ]; then
	ok "中止终态为 ⊘ aborted（严格匹配面板终态行）"
	ev "终态面板行: $ABORT_TERM"
else
	bad "中止后未抓到严格的 ⊘ runtime-e2e · 终态面板行"
	ev "辅助 notice: ${ABORT_NOTICE:-<无>}"
fi
if [ -n "$CARD_ABORT" ]; then
	ok "父工具结果卡片含 aborted"
	ev "卡片行: $CARD_ABORT"
else
	bad "父工具结果卡片未含 aborted"
	ev "未在快照中找到含 aborted 且非面板终态行的文本"
fi

# ---------------------------------------------------------------------------
# 守卫：父模型若自行重试 subagent，会启动第二个 sleep 90，污染 [7]/[8]。
echo "[5c] 守卫：检测父模型是否自行重试 subagent…"
RETRY_SEEN=0
RETRY_LINE=""
for _ in $(seq 1 20); do
	sleep 0.5
	snap
	RETRY_LINE="$(grep -m1 '● runtime-e2e' "$LAST_SNAP" || true)"
	if [ -n "$RETRY_LINE" ]; then RETRY_SEEN=1; break; fi
done
if [ "$RETRY_SEEN" = "1" ]; then
	warn "检测到父模型重试（新 ● runtime-e2e 条目）：[7]/[8] 结果可能不可靠"
	ev "$RETRY_LINE"
else
	echo "  ℹ️  未检测到父模型重试"
fi

# ---------------------------------------------------------------------------
echo "[6b] 断言终态面板行不显示旧动作（不含 bash:）…"
A6=1
if [ "$SAW_BASH" != "1" ]; then A6=0; fi
if [ -z "$ABORT_TERM" ] || printf '%s' "$ABORT_TERM" | grep -q 'bash:'; then A6=0; fi
if [ "$A6" = "1" ]; then
	ok "[看得见] 运行期展示 currentAction（含 bash:），终态行不显示旧动作"
	ev "终态面板行: $ABORT_TERM"
else
	bad "[看得见] currentAction 可见性或终态陈旧动作检查未通过"
	ev "运行期 bash 行: ${BASH_LINE:-<无>}"
	ev "终态面板行: ${ABORT_TERM:-<无>}"
fi

# ---------------------------------------------------------------------------
echo "[7] 终态保留 3s 后常驻面板消失（sleep 5 后复查）…"
sleep 5
snap
GONE_TERM="$(grep -m1 -E '[✓⊘✗] runtime-e2e · ' "$LAST_SNAP" || true)"
GONE_RUN="$(grep -m1 '● runtime-e2e' "$LAST_SNAP" || true)"
if [ -z "$GONE_TERM" ] && [ -z "$GONE_RUN" ]; then
	ok "终态保留期后常驻面板已消失"
	ev "无 [✓⊘✗] runtime-e2e · 且无 ● runtime-e2e"
else
	bad "终态保留期后常驻面板仍存在"
	ev "残留终态行: ${GONE_TERM:-<无>}"
	ev "残留运行行: ${GONE_RUN:-<无>}"
	[ "$RETRY_SEEN" = "1" ] && ev "⚠️ 检测到父模型重试，[7] 结果可能不可靠（测试环境问题，非产品缺陷）"
fi

# ---------------------------------------------------------------------------
echo "[8] 无 running 时 /agents-ps → 没有运行中的子代理…"
tmux send-keys -t "$SESSION" "/agents-ps"; sleep 1; tmux send-keys -t "$SESSION" Enter
NORUN=""
for _ in $(seq 1 20); do
	sleep 0.5
	snap
	NORUN="$(grep -m1 '没有运行中的子代理' "$LAST_SNAP" || true)"
	if [ -n "$NORUN" ]; then break; fi
done
if [ -n "$NORUN" ]; then
	ok "无 running 时 /agents-ps 提示『没有运行中的子代理』"
	ev "$NORUN"
else
	bad "无 running 时 /agents-ps 未提示『没有运行中的子代理』"
	ev "未在 10s 内抓到该提示"
	[ "$RETRY_SEEN" = "1" ] && ev "⚠️ 检测到父模型重试，[8] 结果可能不可靠（测试环境问题，非产品缺陷）"
fi

# ---------------------------------------------------------------------------
echo
echo "==== E2E 结果：PASS=$PASS FAIL=$FAIL WARN=$WARN ===="
if [ "$FAIL" -gt 0 ]; then
	dump_failure
	exit 1
fi
exit 0
