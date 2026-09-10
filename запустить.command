#!/bin/bash
# Запуск всего сразу: пиксельный офис и телеграм-бот. Рассчитан на двойной клик
# в Finder. Окно держать открытым — оно и есть выключатель: закрыли окно или
# нажали Ctrl+C, и оба процесса гаснут.
set -u

OFFICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.ai-office"
CONFIG="$CONFIG_DIR/config"
TELEGRAM="$CONFIG_DIR/telegram.json"
BOT_LOCK="$CONFIG_DIR/bot.pid"
LOG_DIR="$CONFIG_DIR/logs"
PORT=4317

OFFICE_PID=""
BOT_PID=""
OFFICE_STARTED=0

say() { printf '%s\n' "$1"; }
fail() {
  say ""
  say "❌ $1"
  say ""
  say "Нажмите любую клавишу, чтобы закрыть окно."
  read -r -n 1 -s
  exit 1
}

# Гасим только то, что подняли сами: если офис уже работал до запуска скрипта,
# его трогать нельзя — за ним может смотреть открытая вкладка владельца.
cleanup() {
  say ""
  say "Останавливаю…"
  [ -n "$BOT_PID" ] && kill "$BOT_PID" 2>/dev/null
  [ "$OFFICE_STARTED" = "1" ] && [ -n "$OFFICE_PID" ] && kill "$OFFICE_PID" 2>/dev/null
  wait 2>/dev/null
  say "Остановлено."
}
trap cleanup EXIT
trap 'exit 130' INT TERM

clear 2>/dev/null || true
say "═══════════════════════════════════════"
say "   AI-Офис и телеграм-бот"
say "═══════════════════════════════════════"
say ""

# ── Node и Claude ───────────────────────────────────────────
# Finder не наследует PATH из профиля оболочки, поэтому стандартные места
# установки добавляем руками — иначе двойной клик падает, а из терминала работает.
for candidate in /usr/local/bin /opt/homebrew/bin; do
  case ":$PATH:" in *":$candidate:"*) ;; *) PATH="$candidate:$PATH" ;; esac
done
export PATH

command -v node >/dev/null 2>&1 || fail "Не найден Node.js. Установите его с nodejs.org (кнопка LTS)."
command -v claude >/dev/null 2>&1 || fail "Не найден Claude Code. Установите: sudo npm install -g @anthropic-ai/claude-code"

# ── Папка хранилища ─────────────────────────────────────────
# Сначала конфиг установщика, потом настройки бота: систему могли развернуть
# руками, без установщика, и тогда единственный известный путь лежит там.
VAULT=""
if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi
if [ -z "$VAULT" ] && [ -f "$TELEGRAM" ]; then
  VAULT="$(node -e 'try{process.stdout.write(require(process.argv[1]).vault||"")}catch{}' "$TELEGRAM" 2>/dev/null)"
fi

[ -n "$VAULT" ] || fail "Не знаю, где хранилище. Запустите установить.command или укажите vault в $TELEGRAM"
[ -d "$VAULT" ] || fail "Папка хранилища не найдена: $VAULT"

mkdir -p "$LOG_DIR"
say "Хранилище: $VAULT"

# ── Сборка, если её ещё нет ─────────────────────────────────
if [ ! -f "$OFFICE_DIR/dist/cli.js" ]; then
  say "Собираю офис — это займёт пару минут…"
  cd "$OFFICE_DIR" || fail "Не удалось открыть папку офиса."
  [ -d node_modules ] || npm install --silent >/dev/null 2>&1 || fail "Не удалось поставить зависимости. Проверьте интернет."
  npm run build >/dev/null 2>&1 || fail "Сборка не удалась. Запустите вручную: npm run build"
  say "✓ Офис собран"
fi

# ── Офис ────────────────────────────────────────────────────
if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  say "✓ Офис уже работает на порту $PORT — оставляю как есть"
else
  # Рабочая папка обязана быть хранилищем: офис следит за той папкой, из которой
  # стартовал. Запустишь из папки проекта — он молча смотрит не туда.
  cd "$VAULT" || fail "Не удалось перейти в хранилище: $VAULT"
  node "$OFFICE_DIR/dist/cli.js" --port "$PORT" > "$LOG_DIR/office.log" 2>&1 &
  OFFICE_PID=$!
  OFFICE_STARTED=1

  for _ in $(seq 1 30); do
    curl -s --max-time 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
    kill -0 "$OFFICE_PID" 2>/dev/null || fail "Офис упал при запуске. Лог: $LOG_DIR/office.log"
    sleep 1
  done

  curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
    || fail "Офис не поднялся за 30 секунд. Лог: $LOG_DIR/office.log"
  say "✓ Офис запущен на порту $PORT"
fi

# ── Бот ─────────────────────────────────────────────────────
# Бот необязателен: без него офис вполне работает с терминалом.
#
# Второй бот на том же ключе — это двойные ответы: Telegram раздаёт обновления
# обоим. Проверка здесь для понятного сообщения; настоящий замок в самом боте,
# иначе его хватало бы только на запуски через этот скрипт.
BOT_LOCK_PID=""
[ -f "$BOT_LOCK" ] && BOT_LOCK_PID="$(cat "$BOT_LOCK" 2>/dev/null)"

if [ ! -f "$TELEGRAM" ]; then
  say "• Бот пропущен: нет $TELEGRAM"
elif [ -n "$BOT_LOCK_PID" ] && kill -0 "$BOT_LOCK_PID" 2>/dev/null; then
  say "✓ Бот уже работает (процесс $BOT_LOCK_PID) — оставляю как есть"
else
  node "$OFFICE_DIR/bot/telegram-bot.mjs" > "$LOG_DIR/bot.log" 2>&1 &
  BOT_PID=$!
  sleep 3
  if kill -0 "$BOT_PID" 2>/dev/null; then
    BOT_NAME="$(grep -o '@[A-Za-z0-9_]*' "$LOG_DIR/bot.log" | head -1)"
    say "✓ Бот запущен ${BOT_NAME:-}"
  else
    BOT_PID=""
    say "• Бот не запустился. Причина:"
    sed 's/^/    /' "$LOG_DIR/bot.log" | head -5
  fi
fi

open "http://127.0.0.1:$PORT" 2>/dev/null || true

say ""
say "═══════════════════════════════════════"
say "Офис:  http://127.0.0.1:$PORT"
say "Логи:  $LOG_DIR"
say ""
say "Закройте окно или нажмите Ctrl+C, чтобы остановить."
say "═══════════════════════════════════════"

wait
