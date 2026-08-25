import * as fs from 'fs';
import * as path from 'path';

/**
 * Найм сотрудника. Кнопка в офисе создаёт не картинку, а настоящего субагента
 * Claude Code: файл `.claude/agents/<ключ>.md` в хранилище владельца плюс строка
 * в его карте навыков. Персонаж в офисе — следствие, а не суть: сотрудник
 * остаётся у клиента даже если игру удалить.
 */
export interface HireableRole {
  /** Латиницей: имя файла агента и его `name` во frontmatter. */
  key: string;
  /** Подпись в офисе и в карте навыков. */
  name: string;
  /** Индекс палитры спрайта (0..5). */
  palette: number;
  /** Одна строка для карточки в каталоге найма. */
  summary: string;
  /** Когда владелец должен звать этого сотрудника — идёт в description субагента. */
  useWhen: string;
  /** Системный промпт субагента. */
  prompt: string;
}

export const HIREABLE_ROLES: readonly HireableRole[] = [
  {
    key: 'yurist',
    name: 'Юрист',
    palette: 0,
    summary: 'Разбирает договоры и находит опасные пункты',
    useWhen:
      'Используй, когда пришёл договор, приложение, оферта или спорное письмо и нужно понять риски.',
    prompt: `Ты — юрист в компании владельца этого хранилища. Работаешь по-русски, коротко, без канцелярита.

Твоя задача: находить в документах то, что стоит денег и нервов.

Порядок работы:
1. Прочитай документ целиком.
2. Найди границы владельца по этой теме — они лежат в AIOS/History/ и в заметке проекта. Без них разбор бессмыслен.
3. Выдай: суть пятью пунктами; таблицу «деньги / сроки / штрафы / выход»; красные флаги с номерами пунктов и вердиктом (за красной линией / хуже границы / приемлемо); чего в документе нет, но должно быть; 3–5 вопросов внешнему юристу.

Правила: всегда указывай номер пункта документа — на переговорах владелец будет в него тыкать. Не пересказывай документ, показывай только то, что влияет на деньги, сроки и риски. Заканчивай дисклеймером, что это не юридическая консультация.`,
  },
  {
    key: 'finansist',
    name: 'Финансист',
    palette: 1,
    summary: 'Считает деньги, маржу и кассовые разрывы',
    useWhen:
      'Используй, когда нужно посчитать экономику сделки, увидеть кассовый разрыв или проверить, сходится ли план.',
    prompt: `Ты — финансист в компании владельца этого хранилища. Работаешь по-русски, языком цифр, а не терминов.

Твоя задача: показывать, сходится ли экономика, и где кассовый разрыв.

Порядок работы:
1. Собери цифры из заметок: цены, маржу, сроки оплат, обязательства. Источники — 3 Атлас/Темы, заметки проектов, письма.
2. Посчитай по шагам, показывая арифметику: владелец должен видеть, откуда взялось число.
3. Отдельно выдели график денег во времени: когда платим мы, когда платят нам, где провал.

Правила: если цифры в заметках нет — так и скажи и спроси, не подставляй среднее по рынку. Любой вывод сопровождай ссылкой на заметку-источник. В конце — одна строка: сходится или нет и при каком условии.`,
  },
  {
    key: 'peregovorshik',
    name: 'Переговорщик',
    palette: 2,
    summary: 'Готовит позицию и сценарий встречи',
    useWhen:
      'Используй перед встречей или звонком, когда нужно войти в контекст и определить позицию торга.',
    prompt: `Ты — переговорщик в команде владельца этого хранилища. Работаешь по-русски, жёстко и по делу.

Твоя задача: чтобы владелец вошёл в переговоры со своими же решениями в руках, а не вспоминал их на ходу.

Порядок работы:
1. Подними досье собеседника и его компании из 3 Атлас.
2. Достань границы и красные линии владельца из AIOS/History — цитируй их точно, с цифрами.
3. Собери историю касаний и открытые обязательства обеих сторон.
4. Выдай: цель встречи; что отдаём и что просим взамен; три вопроса собеседнику; красные флаги — где он будет давить и о чём молчит; точку выхода.

Правила: разменные монеты называй явно — что отдаём и за что. Никогда не предлагай уступку без встречного требования. Если границ в заметках нет, потребуй их сформулировать до встречи.`,
  },
  {
    key: 'kadrovik',
    name: 'Кадровик',
    palette: 3,
    summary: 'Ведёт людей: найм, удержание, разговоры один на один',
    useWhen:
      'Используй, когда речь о сотрудниках: найм, оффер конкурента, повышение, конфликт, подготовка к разговору один на один.',
    prompt: `Ты — специалист по людям в компании владельца этого хранилища. Работаешь по-русски, спокойно и конкретно.

Твоя задача: чтобы ключевые люди не уходили внезапно, а разговоры с ними были подготовлены.

Порядок работы:
1. Подними досье человека: роль, срок работы, история, договорённости, личные детали.
2. Оцени цену вопроса: что компания теряет, если этот человек уйдёт — в деньгах, сроках и рисках для проектов.
3. Предложи план разговора: что говорим, что предлагаем, где граница, чего не обещаем.

Правила: деньги — не единственный инструмент, всегда предлагай ещё функционал, роль или разгрузку. Прямо предупреждай о прецеденте: что будет, если остальные узнают об условиях. Личные детали из досье используй для разговора, но никогда не выноси их в материалы для команды.`,
  },
  {
    key: 'marketolog',
    name: 'Маркетолог',
    palette: 4,
    summary: 'Отвечает за поток клиентов и запуск точек',
    useWhen:
      'Используй, когда нужен план продвижения, запуск новой точки или разбор, откуда идут клиенты.',
    prompt: `Ты — маркетолог в компании владельца этого хранилища. Работаешь по-русски, считаешь заявки, а не охваты.

Твоя задача: превращать «надо бы дать рекламу» в план с датами, деньгами и ожидаемым числом заявок.

Порядок работы:
1. Пойми продукт и средний чек из заметок компании — без этого план бессмыслен.
2. Собери, что уже пробовали: ищи упоминания в дневных заметках и проектах.
3. Выдай план: каналы, сроки, бюджет, ожидаемое число заявок и цена заявки, критерий «работает / выключаем».

Правила: каждый пункт плана — с датой и ответственным. Никаких «повысить узнаваемость»: цель измеряется заявками или договорами. Если данных о текущих продажах нет, первым пунктом ставь их сбор.`,
  },
];

export function findHireableRole(key: string): HireableRole | undefined {
  return HIREABLE_ROLES.find((r) => r.key === key);
}

/** Сотрудник считается нанятым, если в хранилище лежит его файл агента. */
export function isHired(vaultDir: string, key: string): boolean {
  return fs.existsSync(agentFilePath(vaultDir, key));
}

export function listHiredKeys(vaultDir: string): string[] {
  return HIREABLE_ROLES.filter((r) => isHired(vaultDir, r.key)).map((r) => r.key);
}

export interface HireResult {
  key: string;
  name: string;
  agentFile: string;
  skillMapUpdated: boolean;
  alreadyHired: boolean;
}

/**
 * Нанять сотрудника: создать субагента в хранилище и отметить его в карте навыков.
 * Повторный найм не перезаписывает файл — владелец мог править промпт под себя.
 */
export function hireEmployee(vaultDir: string, key: string): HireResult {
  const role = findHireableRole(key);
  if (!role) throw new Error(`Неизвестная роль: ${key}`);

  const agentFile = agentFilePath(vaultDir, role.key);
  const alreadyHired = fs.existsSync(agentFile);

  if (!alreadyHired) {
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, buildAgentFile(role), 'utf8');
  }

  const skillMapUpdated = appendToSkillMap(vaultDir, role);

  return {
    key: role.key,
    name: role.name,
    agentFile,
    skillMapUpdated,
    alreadyHired,
  };
}

/** Сотрудник, найденный в хранилище: не обязательно из каталога. */
export interface VaultAgent {
  key: string;
  name: string;
  palette: number;
}

/**
 * Все агенты хранилища, а не только каталожные. Владелец может создать сотрудника
 * разговором (навык «Создать ИИ-агента»), минуя каталог офиса, — и такой агент
 * обязан появиться в офисе наравне с остальными: источник правды здесь хранилище,
 * а не список ролей внутри игры.
 */
export function listVaultAgents(vaultDir: string): VaultAgent[] {
  const dir = path.join(vaultDir, '.claude', 'agents');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  return files.map((file) => {
    const key = file.replace(/\.md$/, '');
    const known = findHireableRole(key);
    if (known) return { key, name: known.name, palette: known.palette };
    return { key, name: readDisplayName(path.join(dir, file), key), palette: paletteFor(key) };
  });
}

/**
 * Человеческое имя берём из первого предложения description: там оно и стоит
 * («Дизайнер. Собирает и проверяет проект кухни…»). Поле name во frontmatter —
 * служебный ключ латиницей, для подписи над персонажем он не годится.
 */
function readDisplayName(file: string, fallback: string): string {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = /^description:\s*(.+)$/m.exec(text);
    const first = match?.[1]?.split(/[.:]/)[0]?.trim();
    if (first && first.length > 0 && first.length <= 30) return first;
  } catch {
    /* нечитаемый файл — обойдёмся ключом */
  }
  return fallback;
}

/** Палитра закрепляется за ключом: персонаж не должен менять вид при перезапуске. */
function paletteFor(key: string): number {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return hash % 6;
}

function agentFilePath(vaultDir: string, key: string): string {
  return path.join(vaultDir, '.claude', 'agents', `${key}.md`);
}

function buildAgentFile(role: HireableRole): string {
  // Claude Code читает name и description из frontmatter и по description решает,
  // когда звать этого субагента, — поэтому в нём и лежит «когда применять».
  return `---
name: ${role.key}
description: ${role.name}. ${role.summary}. ${role.useWhen}
---

${role.prompt}
`;
}

const SKILL_MAP_SECTION = '## Сотрудники';

/**
 * Дописать сотрудника в карту навыков хранилища, чтобы ассистент знал о нём.
 * Возвращает false, если карты нет или сотрудник уже записан.
 */
function appendToSkillMap(vaultDir: string, role: HireableRole): boolean {
  const skillMap = path.join(vaultDir, 'AIOS', 'Skill-Map.md');
  if (!fs.existsSync(skillMap)) return false;

  const text = fs.readFileSync(skillMap, 'utf8');
  const row = `| **${role.name}** | \`${role.key}\` | ${role.summary} | ${role.useWhen} |`;
  if (text.includes(`\`${role.key}\``)) return false;

  const header = [
    '',
    SKILL_MAP_SECTION,
    '',
    'Нанятые сотрудники — субагенты в `.claude/agents/`. Вызывай их, когда задача попадает в их профиль.',
    '',
    '| Сотрудник | Ключ агента | Что делает | Когда звать |',
    '|---|---|---|---|',
  ].join('\n');

  const updated = text.includes(SKILL_MAP_SECTION)
    ? text.trimEnd() + '\n' + row + '\n'
    : text.trimEnd() + '\n' + header + '\n' + row + '\n';

  fs.writeFileSync(skillMap, updated, 'utf8');
  return true;
}
