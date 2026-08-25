import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HIREABLE_ROLES, hireEmployee, isHired, listHiredKeys } from '../src/hiring.js';

/**
 * Наём — единственное место, где офис пишет в хранилище владельца. Обещание
 * продукта: сотрудник остаётся у клиента даже если игру удалить, поэтому здесь
 * проверяются именно файлы, а не внутреннее состояние.
 */
describe('hireEmployee', () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-vault-'));
    fs.mkdirSync(path.join(vault, 'AIOS'), { recursive: true });
    fs.writeFileSync(
      path.join(vault, 'AIOS', 'Skill-Map.md'),
      '# Skill-Map\n\n## Навыки\n\nтаблица навыков\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('создаёт субагента, которого Claude Code сможет вызвать', () => {
    const result = hireEmployee(vault, 'yurist');

    expect(result.alreadyHired).toBe(false);
    const text = fs.readFileSync(result.agentFile, 'utf8');
    // Claude Code читает name и description из frontmatter; без них агента не видно.
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('name: yurist');
    expect(text).toMatch(/^description: .+/m);
    expect(text.split('---')[2]?.trim().length ?? 0).toBeGreaterThan(50);
    expect(isHired(vault, 'yurist')).toBe(true);
  });

  it('записывает сотрудника в карту навыков хранилища', () => {
    hireEmployee(vault, 'finansist');

    const skillMap = fs.readFileSync(path.join(vault, 'AIOS', 'Skill-Map.md'), 'utf8');
    expect(skillMap).toContain('## Сотрудники');
    expect(skillMap).toContain('**Финансист**');
    expect(skillMap).toContain('`finansist`');
    // Прежнее содержимое карты не должно пострадать.
    expect(skillMap).toContain('таблица навыков');
  });

  it('повторный наём не затирает правки владельца и не двоит строку', () => {
    const first = hireEmployee(vault, 'yurist');
    fs.appendFileSync(first.agentFile, '\nПравка владельца.\n', 'utf8');

    const second = hireEmployee(vault, 'yurist');

    expect(second.alreadyHired).toBe(true);
    expect(fs.readFileSync(first.agentFile, 'utf8')).toContain('Правка владельца.');
    const skillMap = fs.readFileSync(path.join(vault, 'AIOS', 'Skill-Map.md'), 'utf8');
    expect(skillMap.match(/`yurist`/g)?.length).toBe(1);
  });

  it('нанимает всех из каталога и перечисляет их', () => {
    for (const role of HIREABLE_ROLES) hireEmployee(vault, role.key);

    expect(listHiredKeys(vault).sort()).toEqual(HIREABLE_ROLES.map((r) => r.key).sort());
  });

  it('без карты навыков всё равно создаёт агента', () => {
    fs.rmSync(path.join(vault, 'AIOS'), { recursive: true, force: true });

    const result = hireEmployee(vault, 'kadrovik');

    expect(result.skillMapUpdated).toBe(false);
    expect(fs.existsSync(result.agentFile)).toBe(true);
  });

  it('отвергает неизвестную роль', () => {
    expect(() => hireEmployee(vault, 'нет-такого')).toThrow();
  });
});
