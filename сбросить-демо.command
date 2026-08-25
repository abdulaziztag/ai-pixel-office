#!/bin/bash
# Возврат демо-хранилища в эталонное состояние — перед показом клиенту.
#
# Смысл: во время показа ассистент пишет заметки, создаёт агентов и файлы. Ко
# второму клиенту хранилище выглядит уже иначе, а демонстрация должна быть
# предсказуемой — вы говорите «сейчас он найдёт забытое обещание», и он находит.
set -u

REFERENCE="/Users/manopov/WebstormProjects/obsidian-эталон"
VAULT="/Users/manopov/WebstormProjects/obsidian"
ARCHIVE="$HOME/.ai-office/архив-демо"

clear 2>/dev/null || true
echo "═══════════════════════════════════════"
echo "   Возврат демо к эталону"
echo "═══════════════════════════════════════"
echo ""

[ -d "$REFERENCE" ] || { echo "❌ Не найден эталон: $REFERENCE"; read -r -n 1 -s; exit 1; }
[ -d "$VAULT" ] || { echo "❌ Не найдено хранилище: $VAULT"; read -r -n 1 -s; exit 1; }

echo "Текущее состояние хранилища будет заменено эталонным."
echo "Продолжить? (д/н)"
printf '> '
read -r ANSWER
case "$ANSWER" in
  д|Д|y|Y|да|Да) ;;
  *) echo "Отменено."; read -r -n 1 -s; exit 0 ;;
esac

# Прежнее состояние не удаляем, а откладываем: в нём могли остаться заметки,
# которые вы делали не для демонстрации.
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
mkdir -p "$ARCHIVE"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude '.obsidian/workspace.json' "$VAULT/" "$ARCHIVE/$STAMP/"
else
  cp -R "$VAULT" "$ARCHIVE/$STAMP"
fi
echo "✓ Прежнее состояние отложено: $ARCHIVE/$STAMP"

# Расстановку панелей Obsidian не трогаем: она про окно, а не про содержимое.
rsync -a --delete --exclude '.obsidian/workspace.json' "$REFERENCE/" "$VAULT/"
echo "✓ Хранилище возвращено к эталону"

echo ""
echo "Готово. Демо начинается с чистого листа:"
echo "  · три дневные заметки (30.07 — 01.08), встреча с Атлантом ещё впереди"
echo "  · ни одного ИИ-агента — клиент увидит, как появляется первый"
echo "  · обещание перезвонить Ушаковой не выполнено — его найдёт утренний бриф"
echo ""
echo "Нажмите любую клавишу, чтобы закрыть окно."
read -r -n 1 -s
