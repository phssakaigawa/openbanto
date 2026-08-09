#!/usr/bin/env bash
#
# OpenBanto systemd インストーラ（Linux 専用）
#
# 使い方:
#   sudo ./scripts/systemd/install.sh [USER]
#
# USER を省略すると、現在の SUDO_USER（sudo 元のユーザー）を採用します。
# このスクリプトは:
#   1. ryoko / node / npm のフルパスを `command -v` で検出
#   2. ~ユーザー/.nvm/... まで含めた PATH を組み立て
#   3. テンプレートを /etc/systemd/system/openbanto.service に配置
#   4. systemctl daemon-reload + enable + start を実行
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: このスクリプトは root で実行してください: sudo $0" >&2
  exit 1
fi

TARGET_USER="${1:-${SUDO_USER:-}}"
if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
  echo "ERROR: OpenBanto を実行する非rootユーザーを指定してください: sudo $0 USER" >&2
  echo "        例: sudo $0 ryoko" >&2
  exit 1
fi

if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
  echo "ERROR: ユーザー '$TARGET_USER' が存在しません。先に useradd で作成してください。" >&2
  exit 1
fi

USER_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
USER_SHELL="$(getent passwd "$TARGET_USER" | cut -d: -f7)"
TARGET_GROUP="$(id -gn "$TARGET_USER")"

# ryoko / node を、対象ユーザーの環境で検索。
# nvm / asdf / Volta はログインシェルの rc ファイルでしか PATH を設定しないため、
# 対象ユーザーの「実際の」ログインシェルでサブコマンドを実行する。bash 以外
# (zsh / fish 等) を使っているサーバーアカウントでも auto-detect を効かせるため。
run_as_user() {
  local cmd="$1"
  local out=""
  # まずログインシェルで試す（最大限 PATH を読み込ませる）
  if [[ -n "$USER_SHELL" && -x "$USER_SHELL" ]]; then
    out="$(sudo -u "$TARGET_USER" -i "$USER_SHELL" -lc "$cmd" 2>/dev/null || true)"
  fi
  # 空ならフォールバックで bash
  if [[ -z "$out" ]]; then
    out="$(sudo -u "$TARGET_USER" -i bash -lc "$cmd" 2>/dev/null || true)"
  fi
  printf "%s" "$out"
}

RYOKO_BIN="$(run_as_user 'command -v ryoko')"
NODE_BIN="$(run_as_user 'command -v node')"
if [[ -z "$RYOKO_BIN" ]]; then
  echo "ERROR: ユーザー '$TARGET_USER' の PATH に ryoko が見つかりません。" >&2
  echo "        npm install -g openbanto を $TARGET_USER で先に実行してください。" >&2
  exit 1
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: ユーザー '$TARGET_USER' の PATH に node が見つかりません。" >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"

# Capture the target user's FULL interactive PATH so global CLIs installed via
# pnpm / Volta / asdf / a custom npm prefix are discoverable to spawn(claude),
# spawn(codex), etc. — not just node's own bin dir. The shell-quoting also
# guards against odd PATH entries (we treat the whole value as opaque).
USER_PATH="$(run_as_user 'printf "%s" "$PATH"')"
if [[ -z "$USER_PATH" ]]; then
  USER_PATH="$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
fi
# Always make sure node's dir + system defaults are present (idempotent).
SAFE_PATH="$USER_PATH"
case ":$SAFE_PATH:" in
  *":$NODE_DIR:"*) ;;
  *) SAFE_PATH="$NODE_DIR:$SAFE_PATH" ;;
esac
for sysdir in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
  case ":$SAFE_PATH:" in
    *":$sysdir:"*) ;;
    *) SAFE_PATH="$SAFE_PATH:$sysdir" ;;
  esac
done

UNIT_DST="/etc/systemd/system/openbanto.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/openbanto.service"

if [[ ! -f "$UNIT_SRC" ]]; then
  echo "ERROR: テンプレートが見つかりません: $UNIT_SRC" >&2
  exit 1
fi

echo "==> ユーザー        : $TARGET_USER ($TARGET_GROUP)"
echo "==> ホーム          : $USER_HOME"
echo "==> ryoko バイナリ  : $RYOKO_BIN"
echo "==> node バイナリ   : $NODE_BIN"
echo "==> Environment PATH: $SAFE_PATH"
echo

# テンプレートを置換しながら配置
sed \
  -e "s|^User=.*|User=$TARGET_USER|" \
  -e "s|^Group=.*|Group=$TARGET_GROUP|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$USER_HOME|" \
  -e "s|^Environment=PATH=.*|Environment=PATH=$SAFE_PATH|" \
  -e "s|^ExecStart=.*|ExecStart=$RYOKO_BIN start|" \
  "$UNIT_SRC" > "$UNIT_DST"

chmod 0644 "$UNIT_DST"
echo "==> $UNIT_DST に書き込み完了"

systemctl daemon-reload
systemctl enable openbanto.service
echo "==> openbanto.service を enable しました"

if systemctl is-active --quiet openbanto.service; then
  systemctl restart openbanto.service
  echo "==> 既に起動中だったため restart"
else
  systemctl start openbanto.service
  echo "==> openbanto.service を start"
fi

sleep 1
systemctl status openbanto.service --no-pager || true
echo
echo "ログ追跡: journalctl -u openbanto -f"
