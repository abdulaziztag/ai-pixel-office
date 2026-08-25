#!/usr/bin/env node
/**
 * Телеграм-бот к хранилищу.
 *
 * Владелец пишет боту с телефона → бот запускает Claude Code в папке хранилища
 * на этом компьютере → ответ уходит обратно в телеграм. Пиксельный офис при этом
 * оживает сам: работает настоящий Claude Code на хосте, и его хуки срабатывают
 * как обычно.
 *
 * Внешних зависимостей нет: Telegram Bot API — обычный HTTP, fetch есть в Node 20+.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';

// У api.telegram.org есть адрес IPv6, а у многих домашних сетей маршрута до него
// нет. Node периодически выбирает именно его и падает с ENETUNREACH — обрывы
// выглядят случайными и лечатся только предпочтением IPv4.
setDefaultResultOrder('ipv4first');

const CONFIG_PATH = path.join(os.homedir(), '.ai-office', 'telegram.json');
const POLL_TIMEOUT_SEC = 25;
const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;
const TELEGRAM_MESSAGE_LIMIT = 4000;

// ── Конфигурация ────────────────────────────────────────────────

/**
 * Белый список — не настройка, а условие запуска. У бота полные права на машине
 * владельца, поэтому доступ к нему обязан быть ограничен поимённо: без списка
 * любой, кто найдёт бота, получит доступ к хранилищу и к командам.
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(
      `Нет файла настроек ${CONFIG_PATH}.\n` +
        `Создайте его по образцу telegram.example.json из папки бота.`,
    );
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    fail(`Файл настроек повреждён: ${err.message}`);
  }

  if (!config.token || typeof config.token !== 'string') {
    fail('В настройках нет token — это ключ бота от @BotFather.');
  }
  // Файл создаётся установщиком с заглушками. Без этой проверки бот дошёл бы до
  // Telegram и упал с невнятным «Not Found» вместо понятной подсказки.
  if (!/^\d+:[\w-]{30,}$/.test(config.token)) {
    fail(
      'token не похож на ключ бота. Возьмите его у @BotFather (/newbot) и впишите\n' +
        `в ${CONFIG_PATH} вместо заглушки. Выглядит так: 1234567890:AA...`,
    );
  }
  // Настоящие телеграм-id строго положительные: ноль остаётся в файле от заглушки.
  const allowed = Array.isArray(config.allowedUserIds)
    ? config.allowedUserIds.filter((id) => Number.isInteger(id) && id > 0)
    : [];
  if (allowed.length === 0) {
    fail(
      'В настройках пуст allowedUserIds — список телеграм-аккаунтов, которым можно писать боту.\n' +
        'Без него бот не запускается: у него полные права на этом компьютере.\n' +
        'Свой numeric id можно узнать у бота @userinfobot.',
    );
  }
  if (!config.vault || !fs.existsSync(config.vault)) {
    fail(`Папка хранилища не найдена: ${config.vault ?? '(не указана)'}`);
  }

  return { token: config.token, allowed: new Set(allowed), vault: config.vault };
}

function stamp() {
  return new Date().toLocaleTimeString('ru-RU');
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

// ── Telegram API ────────────────────────────────────────────────

async function callTelegram(token, method, payload, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description ?? 'неизвестная ошибка Telegram');
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Телеграм рвёт длинные сообщения — режем сами, по строкам, чтобы не рвать слова. */
export function splitMessage(text) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > TELEGRAM_MESSAGE_LIMIT) {
      if (current) chunks.push(current);
      current = line.slice(0, TELEGRAM_MESSAGE_LIMIT);
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : ['(пустой ответ)'];
}

/**
 * Claude отвечает разметкой markdown, а телеграм её не понимает: владелец видел
 * звёздочки и палки таблиц как есть. Переводим в тот небольшой HTML, который
 * телеграм поддерживает, а таблицы кладём в моноширинный блок — иначе колонки
 * разъезжаются и читать невозможно.
 */
export function toTelegramHtml(text) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = text.split('\n');
  const out = [];
  let table = [];

  const flushTable = () => {
    if (table.length === 0) return;
    // Строку-разделитель («|---|---|») телеграму показывать незачем.
    const rows = table.filter((r) => !/^\s*\|[\s|:-]+\|\s*$/.test(r));
    const cells = rows.map((r) =>
      r
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    );
    const widths = [];
    for (const row of cells) {
      row.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
    }
    const rendered = cells
      .map((row) =>
        row
          .map((c, i) => c.padEnd(widths[i] ?? 0))
          .join('  ')
          .trimEnd(),
      )
      .join('\n');
    out.push(`<pre>${escape(rendered)}</pre>`);
    table = [];
  };

  let fence = null;
  let fenced = [];

  for (const line of lines) {
    // Блоки кода в тройных кавычках: телеграм их не знает, а Claude присылает
    // ими готовые файлы — без обработки владелец видел сами кавычки.
    const fenceMark = /^\s*```(.*)$/.exec(line);
    if (fenceMark) {
      if (fence === null) {
        flushTable();
        fence = fenceMark[1].trim();
        fenced = [];
      } else {
        out.push(`<pre>${escape(fenced.join('\n'))}</pre>`);
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fenced.push(line);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      table.push(line);
      continue;
    }
    flushTable();

    let html = escape(line);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    html = html.replace(/^#{1,6}\s+(.*)$/, '<b>$1</b>');
    out.push(html);
  }
  if (fence !== null && fenced.length > 0) {
    out.push(`<pre>${escape(fenced.join('\n'))}</pre>`);
  }
  flushTable();
  return out.join('\n');
}

async function reply(token, chatId, text) {
  for (const chunk of splitMessage(text)) {
    try {
      await callTelegram(token, 'sendMessage', {
        chat_id: chatId,
        text: toTelegramHtml(chunk),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      // Разметка не должна стоить владельцу ответа: не разобралась — шлём как есть.
      console.warn(`[бот ${stamp()}] Разметка отклонена (${err.message}), отправляю текстом`);
      await callTelegram(token, 'sendMessage', { chat_id: chatId, text: chunk });
    }
  }
}

/** Отправить готовый файл: то, ради чего владелец и просил «выведи в excel». */
async function sendDocument(token, chatId, filePath) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const data = await fs.promises.readFile(filePath);
  form.append('document', new Blob([data]), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description ?? 'не удалось отправить файл');
}

/**
 * Файлы, появившиеся или изменившиеся за время запуска. Заметки (.md) исключены
 * намеренно: ассистент правит их постоянно, и владельцу не нужен поток вложений —
 * ему нужен результат вроде таблицы или отчёта.
 */
async function collectDeliverables(vault, since) {
  const found = [];
  const skip = new Set(['.obsidian', '.claude', 'node_modules', '.git']);
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.name.endsWith('.md')) continue;
      try {
        const st = await fs.promises.stat(full);
        if (st.mtimeMs >= since) found.push({ path: full, size: st.size });
      } catch {
        /* файл исчез — не беда */
      }
    }
  };
  await walk(vault);
  // Телеграм не принимает документы больше 50 МБ.
  return found.filter((f) => f.size > 0 && f.size < 50 * 1024 * 1024).map((f) => f.path);
}

// ── Запуск Claude Code ──────────────────────────────────────────

/**
 * Продолжение разговора: у каждого чата своя сессия Claude, иначе каждое
 * сообщение начиналось бы с чистого листа и «а что по Атланту?» было бы
 * бессмысленным вопросом.
 */
const sessions = new Map();

/** Один запуск Claude. Сессию наверх не запоминает — это решает вызывающий. */
function spawnClaude(vault, prompt, sessionArgs) {
  // --bare здесь использовать нельзя: он отключает автообнаружение хуков,
  // и пиксельный офис перестал бы видеть работу бота.
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    ...sessionArgs,
  ];

  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd: vault,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `Не удалось запустить Claude: ${err.message}`, raw: '' });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, text: extractResult(stdout), raw: stdout });
        return;
      }
      // Claude сообщает о части сбоев в обычный вывод, а не в поток ошибок:
      // если смотреть только на stderr, владелец получит немое «код 1».
      const raw = `${stderr}\n${stdout}`.trim();
      const hint = /401|authenticate|OAuth/i.test(raw)
        ? 'Claude Code не авторизован на этом компьютере — войдите командой claude в терминале.'
        : raw.slice(0, 500) || `Claude завершился с кодом ${code}.`;
      resolve({ ok: false, text: hint, raw });
    });
  });
}

/**
 * Запрос к Claude с продолжением разговора. Сессия запоминается только после
 * успешного запуска: иначе первая же неудача (нет сети, нет входа) закрепляла бы
 * за чатом идентификатор несуществующей сессии, и все следующие сообщения падали
 * бы на попытке её продолжить.
 */
async function runClaude(vault, chatId, prompt) {
  const known = sessions.get(chatId);

  if (known) {
    const resumed = await spawnClaude(vault, prompt, ['--resume', known]);
    if (resumed.ok) return resumed;
    if (!/No conversation found/i.test(resumed.raw)) return resumed;
    // Сессия потерялась (перезапуск, очистка истории) — начинаем заново, молча.
    console.warn(`[бот ${stamp()}] Сессия чата ${chatId} потеряна, начинаю новую`);
    sessions.delete(chatId);
  }

  const fresh = randomUUID();
  const result = await spawnClaude(vault, prompt, ['--session-id', fresh]);
  if (result.ok) sessions.set(chatId, fresh);
  return result;
}

/** Ответ приходит как JSON; на всякий случай умеем и простой текст. */
export function extractResult(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return '(пустой ответ)';
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.result === 'string') return parsed.result;
    if (typeof parsed.text === 'string') return parsed.text;
  } catch {
    /* не JSON — отдаём как есть */
  }
  return trimmed;
}

// ── Обработка сообщений ─────────────────────────────────────────

const GREETING = [
  'Готов. Пишите вопрос — отвечу по вашему хранилищу.',
  '',
  'Примеры:',
  '• Утренний бриф',
  '• Подготовь меня к встрече со Стрельцовым',
  '• лог: созвонился с поставщиком, договорились о скидке',
  '• Кто кому что должен?',
  '',
  '/агент — создать ИИ-помощника  ·  /новый — начать разговор заново',
].join('\n');

/** Один чат — одна задача за раз: параллельные запуски мешали бы друг другу. */
const busy = new Set();

async function handleMessage(cfg, message) {
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  let text = (message.text ?? '').trim();
  if (!chatId || !userId || !text) return;

  if (!cfg.allowed.has(userId)) {
    console.warn(`[бот ${stamp()}] Отклонён чужой аккаунт: ${userId}`);
    await reply(cfg.token, chatId, 'Этот бот приватный.');
    return;
  }

  if (text === '/start' || text === '/help') {
    await reply(cfg.token, chatId, GREETING);
    return;
  }

  // Команда уходит ассистенту обычным текстом: логика найма живёт навыком в
  // хранилище, а не в боте, — тогда она работает и из терминала, и с телефона.
  if (text === '/агент' || text === '/agent') {
    // Именно «ИИ-агент», а не «сотрудник»: у владельца в хранилище идут настоящие
    // кадровые проекты, и «нанять сотрудника» ассистент справедливо понимал как
    // найм живого человека.
    text = 'Создай ИИ-агента';
  }

  if (text === '/новый') {
    sessions.delete(chatId);
    await reply(cfg.token, chatId, 'Начал разговор заново.');
    return;
  }

  if (busy.has(chatId)) {
    await reply(cfg.token, chatId, 'Ещё думаю над прошлым вопросом — секунду.');
    return;
  }

  busy.add(chatId);
  try {
    await callTelegram(cfg.token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    console.log(`[бот ${stamp()}] Запрос от ${userId}: ${text.slice(0, 80)}`);
    // Отсечка на секунду раньше запуска: файловые времена округляются, и файл,
    // созданный в первое мгновение работы, иначе не попал бы в выдачу.
    const startedAt = Date.now() - 1000;
    const result = await runClaude(cfg.vault, chatId, text);
    await reply(cfg.token, chatId, result.text);

    if (result.ok) {
      const files = await collectDeliverables(cfg.vault, startedAt);
      for (const file of files) {
        try {
          await callTelegram(cfg.token, 'sendChatAction', {
            chat_id: chatId,
            action: 'upload_document',
          });
          await sendDocument(cfg.token, chatId, file);
          console.log(`[бот ${stamp()}] Отправлен файл: ${path.basename(file)}`);
        } catch (err) {
          console.warn(`[бот ${stamp()}] Файл не ушёл (${path.basename(file)}): ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error('[бот] Ошибка обработки:', err);
    await reply(cfg.token, chatId, `Сбой: ${err.message}`).catch(() => {});
  } finally {
    busy.delete(chatId);
  }
}

// ── Основной цикл ───────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const me = await callTelegram(cfg.token, 'getMe', {});
  console.log(`[бот] Запущен как @${me.username}`);
  console.log(`[бот] Хранилище: ${cfg.vault}`);
  console.log(`[бот] Доступ разрешён аккаунтам: ${[...cfg.allowed].join(', ')}`);

  let offset = 0;
  for (;;) {
    try {
      const updates = await callTelegram(
        cfg.token,
        'getUpdates',
        { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message'] },
        (POLL_TIMEOUT_SEC + 15) * 1000,
      );
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(cfg, update.message);
      }
    } catch (err) {
      // Сеть моргает, телефон в метро, ноутбук уснул — это не повод падать.
      const cause = err.cause?.code ?? err.cause?.message ?? '';
      console.error(
        `[бот ${stamp()}] Сбой опроса, повтор через 5 с: ${err.message}${cause ? ` (${cause})` : ''}`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Цикл опроса запускается только при прямом запуске: файл ещё и импортируется
// проверками, а им лишний сетевой цикл ни к чему.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => fail(err.message));
}
