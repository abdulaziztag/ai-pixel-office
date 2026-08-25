import { useCallback, useEffect, useState } from 'react';

import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

/** Роль из каталога найма (ответ GET /api/employees). */
interface HireableRoleView {
  key: string;
  name: string;
  summary: string;
  useWhen: string;
  palette: number;
  hired: boolean;
}

interface EmployeesResponse {
  vaultDir: string | null;
  roles: HireableRoleView[];
}

interface HiringModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Найм сотрудника. Кнопка создаёт не персонажа, а настоящего субагента Claude Code
 * в хранилище владельца — персонаж лишь показывает, что сотрудник теперь есть.
 *
 * Каталог и наём ходят по REST, а не через WebSocket-протокол: так форк не тянет
 * за собой правку core/asyncapi.yaml и перегенерацию сообщений.
 */
export function HiringModal({ isOpen, onClose }: HiringModalProps) {
  const [data, setData] = useState<EmployeesResponse | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/employees');
      if (!res.ok) throw new Error(`Сервер ответил ${res.status.toString()}`);
      setData((await res.json()) as EmployeesResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  const hire = useCallback(
    async (key: string) => {
      setBusyKey(key);
      setError(null);
      try {
        const res = await fetch('/api/employees/hire', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Сервер ответил ${res.status.toString()}`);
        }
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [load],
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Добавить ИИ-агента">
      <div className="px-10 pb-4 text-sm opacity-70">
        Сотрудник появится в офисе и станет доступен ассистенту: он записывается в ваше хранилище, а
        не в эту игру.
      </div>

      {error !== null && <div className="px-10 pb-4 text-sm text-danger">{error}</div>}

      {data?.vaultDir === null && (
        <div className="px-10 pb-4 text-sm text-danger">
          Хранилище не определено — запустите офис из папки с вашими заметками.
        </div>
      )}

      {data?.roles.map((role) => (
        <MenuItem
          key={role.key}
          onClick={() => {
            if (!role.hired && busyKey === null) void hire(role.key);
          }}
          right={
            <span className="text-sm opacity-70">
              {role.hired ? 'в штате' : busyKey === role.key ? '…' : 'добавить'}
            </span>
          }
        >
          <span className="flex flex-col">
            <span>{role.name}</span>
            <span className="text-sm opacity-70">{role.summary}</span>
          </span>
        </MenuItem>
      ))}

      {data === null && error === null && (
        <div className="px-10 pb-4 text-sm opacity-70">Загружаю каталог…</div>
      )}
    </Modal>
  );
}
