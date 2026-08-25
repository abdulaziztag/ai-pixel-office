#!/bin/bash
# Установщик AI-Офиса. Рассчитан на двойной клик в Finder: клиент не должен
# набирать команды. Всё, что требуется от него, — перетащить папку хранилища.
set -u

OFFICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.ai-office"
LAUNCHER="$HOME/Desktop/Мой офис.command"
PORT=4317

say() { printf '%s\n' "$1"; }
fail() {
  say ""
  say "❌ $1"
  say ""
  say "Нажмите любую клавишу, чтобы закрыть окно."
  read -r -n 1 -s
  exit 1
}

clear 2>/dev/null || true
say "═══════════════════════════════════════"
say "   Установка AI-Офиса"
say "═══════════════════════════════════════"
say ""

# ── 1. Node.js ──────────────────────────────────────────────
# Node ставится из nodejs.org и не попадает в PATH сеанса Finder,
# поэтому кроме PATH проверяем и стандартные места установки.
if ! command -v node >/dev/null 2>&1; then
  for candidate in /usr/local/bin /opt/homebrew/bin; do
    [ -x "$candidate/node" ] && PATH="$candidate:$PATH"
  done
fi

command -v node >/dev/null 2>&1 || fail "Не найден Node.js. Установите его с nodejs.org (кнопка LTS) и запустите установщик снова."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || fail "Нужен Node.js версии 20 или новее, а установлена $(node -v). Обновите его с nodejs.org."
say "✓ Node.js $(node -v)"

# ── 2. Сборка ───────────────────────────────────────────────
say ""
say "Собираю офис — это займёт пару минут…"
cd "$OFFICE_DIR" || fail "Не удалось открыть папку офиса."
if [ ! -d node_modules ]; then
  npm install --silent >/dev/null 2>&1 || fail "Не удалось установить зависимости. Проверьте интернет и попробуйте снова."
fi
npm run build >/dev/null 2>&1 || fail "Сборка не удалась. Пришлите разработчику вывод команды: npm run build"
say "✓ Офис собран"

# ── 3. Папка хранилища ──────────────────────────────────────
say ""
say "Перетащите сюда папку вашего хранилища Obsidian и нажмите Enter:"
printf '> '
read -r VAULT_RAW
VAULT="${VAULT_RAW%\'}"; VAULT="${VAULT#\'}"          # Finder оборачивает путь в кавычки
VAULT="${VAULT%\"}"; VAULT="${VAULT#\"}"
VAULT="${VAULT%/}"                                    # и может добавить хвостовой слэш
VAULT="${VAULT/#\~/$HOME}"

[ -n "$VAULT" ] || fail "Папка не указана."
[ -d "$VAULT" ] || fail "Папка не найдена: $VAULT"

if [ ! -f "$VAULT/Me.md" ]; then
  say ""
  say "⚠️  В этой папке нет файла Me.md — обычно он лежит в корне хранилища."
  say "    Продолжить всё равно? (д/н)"
  printf '> '
  read -r ANSWER
  case "$ANSWER" in
    д|Д|y|Y|да|Да) ;;
    *) fail "Установка отменена." ;;
  esac
fi
say "✓ Хранилище: $VAULT"

# ── 4. Резервная копия настроек Claude ──────────────────────
# Офис пропишет свои хуки в общий файл настроек Claude. Копию делаем до первого
# запуска: если у клиента уже были свои хуки, их можно будет вернуть.
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && [ ! -f "$SETTINGS.backup-ai-office" ]; then
  cp "$SETTINGS" "$SETTINGS.backup-ai-office" && say "✓ Резервная копия настроек Claude сохранена"
fi

# ── 5. Конфиг и ярлык ───────────────────────────────────────
mkdir -p "$CONFIG_DIR"
printf 'VAULT=%s\nOFFICE_DIR=%s\nPORT=%s\n' "$VAULT" "$OFFICE_DIR" "$PORT" > "$CONFIG_DIR/config"

cat > "$LAUNCHER" <<'LAUNCHER_EOF'
#!/bin/bash
# Ярлык запуска AI-Офиса. Создан установщиком, править вручную не нужно.
set -u
CONFIG="$HOME/.ai-office/config"
[ -f "$CONFIG" ] || { echo "Офис не настроен: запустите установить.command"; read -r -n 1 -s; exit 1; }
# shellcheck disable=SC1090
. "$CONFIG"

if ! command -v node >/dev/null 2>&1; then
  for candidate in /usr/local/bin /opt/homebrew/bin; do
    [ -x "$candidate/node" ] && PATH="$candidate:$PATH"
  done
fi

clear 2>/dev/null || true
echo "Офис открывается…"
echo "Хранилище: $VAULT"
echo ""
echo "Чтобы закрыть офис — закройте это окно."
echo ""

# Если офис уже запущен, второй раз не поднимаем: просто открываем вкладку.
if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT"
  echo "Офис уже был запущен — открыл вкладку в браузере."
  read -r -n 1 -s
  exit 0
fi

# Рабочая папка обязана быть хранилищем: из неё офис понимает, за чем следить
# и куда записывать нанятых сотрудников.
cd "$VAULT" || { echo "Не найдена папка хранилища: $VAULT"; read -r -n 1 -s; exit 1; }
( sleep 3; open "http://127.0.0.1:$PORT" ) &
exec node "$OFFICE_DIR/dist/cli.js" --port "$PORT"
LAUNCHER_EOF

chmod +x "$LAUNCHER"

say ""
say "═══════════════════════════════════════"
say "   Готово"
say "═══════════════════════════════════════"
say ""
say "На рабочем столе появился ярлык «Мой офис» — им и запускайте."
say ""
say "Важно: офис показывает работу Claude Code."
say "Режим Cowork он не видит — тот работает в отдельной виртуальной машине."
say ""
say "Нажмите любую клавишу, чтобы закрыть окно."
read -r -n 1 -s
