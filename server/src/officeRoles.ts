import type { AgentStateStore } from './agentStateStore.js';

/**
 * Штат офиса по умолчанию — двое: Ассистент (персонаж самой сессии) и Секретарь,
 * который берёт на себя запись в заметки. Остальных владелец нанимает сам, и они
 * становятся настоящими субагентами в его хранилище.
 *
 * Раньше здесь было четыре автоматических роли, но офис от этого выглядел
 * набитым сотрудниками, которых никто не нанимал: люди появлялись сами собой.
 * Пустой стол честнее — он показывает, что штат можно расширить.
 */
export interface OfficeRole {
  key: string;
  /** Подпись под персонажем. */
  name: string;
  /** Индекс палитры спрайта (0..5), фиксирован за ролью — стол не «переезжает». */
  palette: number;
  tools: readonly string[];
}

export const OFFICE_ROLES: readonly OfficeRole[] = [
  {
    key: 'clerk',
    name: 'Секретарь',
    palette: 1,
    tools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  },
];

const ROLE_BY_TOOL = new Map<string, OfficeRole>(
  OFFICE_ROLES.flatMap((role) => role.tools.map((tool) => [tool, role] as [string, OfficeRole])),
);

export function roleForTool(toolName: string): OfficeRole | undefined {
  return ROLE_BY_TOOL.get(toolName);
}

/**
 * Идентификаторы персонажей-ролей начинаются заведомо выше настоящих: те выдаются
 * из nextAgentId с единицы, и пересечение увело бы события чужому персонажу.
 */
const ROLE_AGENT_ID_BASE = 9001;

/** Нанятые сотрудники сидят в своём диапазоне, чтобы не пересекаться с ролями. */
const EMPLOYEE_AGENT_ID_BASE = 9101;

interface ActiveRoleTool {
  roleAgentId: number;
  toolId: string;
}

/** Нанятый сотрудник, показанный в офисе. */
export interface OfficeEmployee {
  key: string;
  name: string;
  palette: number;
}

/**
 * Держит персонажей-ролей и адресует им события инструментов.
 *
 * Работает поверх существующих сообщений протокола (agentCreated / agentTeamInfo /
 * agentToolStart / agentToolDone), поэтому core/asyncapi.yaml остаётся нетронутым,
 * а с ним и ритуал перегенерации messages.ts.
 */
export class OfficeRoleDirector {
  private spawned = new Map<string, number>();
  private activeByAgent = new Map<number, ActiveRoleTool>();
  private employees = new Map<string, OfficeEmployee>();
  private activeSubagentByAgent = new Map<number, ActiveRoleTool>();
  private toolSeq = 0;

  constructor(
    private store: AgentStateStore,
    private enabled: () => boolean,
  ) {}

  /** Роли живут в офисе, пока идёт сессия; после перезагрузки страницы их надо вернуть. */
  replay(): void {
    for (const role of OFFICE_ROLES) {
      const id = this.spawned.get(role.key);
      if (id !== undefined) this.announce(role, id);
    }
    for (const emp of this.employees.values()) {
      this.announce(emp, this.employeeId(emp.key));
    }
  }

  // ── Нанятые сотрудники ────────────────────────────────────────

  /**
   * Показать в офисе нанятых сотрудников. Список приходит из хранилища
   * (файлы `.claude/agents/`), поэтому офис отражает реальный штат, а не свою память.
   */
  setEmployees(list: readonly OfficeEmployee[]): void {
    const incoming = new Map(list.map((e) => [e.key, e]));

    for (const key of [...this.employees.keys()]) {
      if (!incoming.has(key)) {
        this.employees.delete(key);
        this.store.broadcast({ type: 'agentClosed', id: this.employeeId(key) });
      }
    }

    for (const emp of incoming.values()) {
      if (this.employees.has(emp.key)) continue;
      this.employees.set(emp.key, emp);
      this.announce(emp, this.employeeId(emp.key));
    }
  }

  /**
   * Claude позвал субагента. Если это нанятый сотрудник — оживает именно его
   * персонаж: тот самый, которого владелец «нанял» кнопкой.
   */
  subagentStart(ownerAgentId: number, agentType: string): boolean {
    if (!this.enabled()) return false;
    const emp = this.employees.get(agentType);
    if (!emp) return false;

    this.subagentEnd(ownerAgentId);
    const toolId = `employee-${emp.key}-${++this.toolSeq}`;
    const employeeAgentId = this.employeeId(emp.key);
    this.activeSubagentByAgent.set(ownerAgentId, { roleAgentId: employeeAgentId, toolId });
    this.store.broadcast({
      type: 'agentToolStart',
      id: employeeAgentId,
      toolId,
      // Владелец видит имя сотрудника, а не служебный ключ агента.
      status: `В работе: ${emp.name}`,
      toolName: 'Task',
    });
    this.store.broadcast({ type: 'agentStatus', id: employeeAgentId, status: 'active' });
    return true;
  }

  /** Субагент отработал — сотрудник возвращается за свой стол. */
  subagentEnd(ownerAgentId: number): void {
    const active = this.activeSubagentByAgent.get(ownerAgentId);
    if (!active) return;
    this.activeSubagentByAgent.delete(ownerAgentId);
    this.store.broadcast({
      type: 'agentToolDone',
      id: active.roleAgentId,
      toolId: active.toolId,
    });
    this.store.broadcast({ type: 'agentStatus', id: active.roleAgentId, status: 'waiting' });
  }

  /**
   * Идентификатор персонажа сотрудника. Закрепляется за ключом навсегда в пределах
   * запуска: если считать его от позиции в текущем списке, при увольнении соседи
   * «переедут» на чужие столы, а уволенный не исчезнет.
   */
  private employeeId(key: string): number {
    let index = this.employeeSlots.indexOf(key);
    if (index < 0) {
      index = this.employeeSlots.length;
      this.employeeSlots.push(key);
    }
    return EMPLOYEE_AGENT_ID_BASE + index;
  }

  private employeeSlots: string[] = [];

  /**
   * Инструмент пошёл в работу. Возвращает true, если событие подхватил профильный
   * сотрудник, — тогда вызывающий знает, что офис ожил не только главным персонажем.
   */
  toolStart(ownerAgentId: number, toolName: string, status: string): boolean {
    if (!this.enabled()) return false;
    const role = roleForTool(toolName);
    if (!role) return false;

    // Предыдущий инструмент этой же сессии закрываем: сотрудник делает одно дело за раз.
    this.toolEnd(ownerAgentId);

    const roleAgentId = this.ensureRoleAgent(role);
    const toolId = `role-${role.key}-${++this.toolSeq}`;
    this.activeByAgent.set(ownerAgentId, { roleAgentId, toolId });
    this.store.broadcast({
      type: 'agentToolStart',
      id: roleAgentId,
      toolId,
      status,
      toolName,
    });
    // Без смены состояния персонаж навсегда остаётся «занятым»: он не встанет
    // из-за стола и не пойдёт отдыхать, когда работа кончится.
    this.store.broadcast({ type: 'agentStatus', id: roleAgentId, status: 'active' });
    return true;
  }

  /** Инструмент закончился — сотрудник возвращается к безделью за своим столом. */
  toolEnd(ownerAgentId: number): void {
    const active = this.activeByAgent.get(ownerAgentId);
    if (!active) return;
    this.activeByAgent.delete(ownerAgentId);
    this.store.broadcast({
      type: 'agentToolDone',
      id: active.roleAgentId,
      toolId: active.toolId,
    });
    this.store.broadcast({ type: 'agentStatus', id: active.roleAgentId, status: 'waiting' });
  }

  /** Сессия закончилась: гасим её незакрытый инструмент, персонажи остаются на местах. */
  sessionEnd(ownerAgentId: number): void {
    this.toolEnd(ownerAgentId);
  }

  /** Убрать сотрудников из офиса целиком (выключение режима ролей). */
  clear(): void {
    for (const id of this.activeByAgent.values()) {
      this.store.broadcast({ type: 'agentToolDone', id: id.roleAgentId, toolId: id.toolId });
    }
    this.activeByAgent.clear();
    for (const id of this.spawned.values()) {
      this.store.broadcast({ type: 'agentClosed', id });
    }
    this.spawned.clear();
  }

  private ensureRoleAgent(role: OfficeRole): number {
    const existing = this.spawned.get(role.key);
    if (existing !== undefined) return existing;

    const id = ROLE_AGENT_ID_BASE + OFFICE_ROLES.findIndex((r) => r.key === role.key);
    this.spawned.set(role.key, id);
    this.announce(role, id);
    return id;
  }

  private announce(role: { name: string; palette: number }, id: number): void {
    this.store.broadcast({
      type: 'agentCreated',
      id,
      isExternal: true,
      palette: role.palette,
      hueShift: 0,
    });
    this.store.broadcast({
      type: 'agentTeamInfo',
      id,
      agentName: role.name,
    });
  }
}
