import type { OfficeLayout, PlacedFurniture } from '../types.js';

/**
 * Чем сотрудник занят, когда задач нет.
 *
 * Половину времени он сидит за компьютером — офис не должен выглядеть пустым, —
 * а остальное делится между бытовыми занятиями. Это единственная часть офиса,
 * которая не отражает реальную работу ассистента: статусы занятий подписаны
 * так, чтобы их нельзя было спутать с делом («Пьёт кофе», а не «Изучает»).
 */
export interface IdleActivity {
  key: string;
  /** Подпись над персонажем. */
  label: string;
  /** Вес среди занятий: доли внутри той половины, что не за компьютером. */
  weight: number;
  /** Названия зон планировки, где этим занимаются. */
  areas?: string[];
  /** Либо мебель, к которой подходят. */
  furniture?: string[];
  /** Сколько занимается, секунд. */
  minSec: number;
  maxSec: number;
}

/** Доля времени за рабочим местом. Остальное — занятия ниже. */
export const DESK_SHARE = 0.5;

export const IDLE_ACTIVITIES: readonly IdleActivity[] = [
  {
    key: 'coffee',
    label: 'Пьёт кофе',
    weight: 3,
    areas: ['Кухня'],
    furniture: ['COFFEE'],
    minSec: 12,
    maxSec: 25,
  },
  {
    key: 'lunch',
    label: 'Обедает',
    weight: 2,
    areas: ['Кухня'],
    furniture: ['SMALL_TABLE_FRONT', 'SMALL_TABLE_SIDE'],
    minSec: 20,
    maxSec: 40,
  },
  {
    key: 'lounge',
    label: 'Отдыхает',
    weight: 3,
    areas: ['Лаундж'],
    furniture: ['SOFA_FRONT', 'SOFA_BACK', 'SOFA_SIDE', 'CUSHIONED_BENCH'],
    minSec: 15,
    maxSec: 35,
  },
  {
    key: 'game',
    label: 'Играет',
    weight: 2,
    areas: ['Лаундж'],
    furniture: ['COFFEE_TABLE'],
    minSec: 15,
    maxSec: 30,
  },
  {
    key: 'smoke',
    label: 'Курит',
    weight: 2,
    areas: ['Курилка'],
    minSec: 12,
    maxSec: 25,
  },
  {
    key: 'toilet',
    label: 'Отошёл',
    weight: 2,
    areas: ['Уборная'],
    minSec: 8,
    maxSec: 18,
  },
  {
    key: 'read',
    label: 'Читает',
    weight: 2,
    furniture: ['DOUBLE_BOOKSHELF', 'BOOKSHELF'],
    minSec: 15,
    maxSec: 30,
  },
];

export interface ActivitySpot {
  col: number;
  row: number;
}

/** Точки, где можно заниматься каждым делом, по ключу занятия. */
export type ActivitySpots = Map<string, ActivitySpot[]>;

function isWalkable(layout: OfficeLayout, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return false;
  const tile = layout.tiles[row * layout.cols + col];
  // 0 — стена, 255 — пустота; всё остальное это пол.
  return tile !== undefined && tile !== 0 && tile !== 255;
}

/**
 * Разложить планировку на точки занятий. Зоны важнее мебели: если владелец
 * разметил «Кухню», сотрудники идут туда, а не к конкретной кофемашине.
 * Занятие без единой найденной точки просто выпадает из розыгрыша — офис
 * с планировкой без кухни не должен ломаться.
 */
export function resolveActivitySpots(
  layout: OfficeLayout,
  furniture: readonly PlacedFurniture[],
  blockedTiles: ReadonlySet<string>,
): ActivitySpots {
  const spots: ActivitySpots = new Map();
  const free = (col: number, row: number): boolean =>
    isWalkable(layout, col, row) && !blockedTiles.has(`${col},${row}`);

  for (const activity of IDLE_ACTIVITIES) {
    const found: ActivitySpot[] = [];

    if (activity.areas && layout.areaTiles) {
      for (let row = 0; row < layout.rows; row++) {
        for (let col = 0; col < layout.cols; col++) {
          const label = layout.areaTiles[row * layout.cols + col];
          if (label && activity.areas.includes(label) && free(col, row)) {
            found.push({ col, row });
          }
        }
      }
    }

    if (found.length === 0 && activity.furniture) {
      for (const item of furniture) {
        const base = item.type.split(':')[0] ?? item.type;
        if (!activity.furniture.includes(base)) continue;
        // Встать рядом: сама клетка мебели занята. Радиус в две клетки нужен для
        // настенных предметов — под стеллажом идёт стена, и пол начинается дальше.
        for (let radius = 1; radius <= 2 && found.length === 0; radius++) {
          for (const [dc, dr] of [
            [0, radius],
            [0, -radius],
            [radius, 0],
            [-radius, 0],
          ]) {
            const col = item.col + dc;
            const row = item.row + dr;
            if (free(col, row)) found.push({ col, row });
          }
        }
      }
    }

    if (found.length > 0) spots.set(activity.key, found);
  }

  return spots;
}

export interface ChosenActivity {
  key: string;
  label: string;
  spot: ActivitySpot;
  seconds: number;
}

/**
 * Выбрать занятие. null означает «за рабочее место»: так возвращается и
 * половина случаев по DESK_SHARE, и любой случай, когда занятий не нашлось.
 */
export function pickIdleActivity(spots: ActivitySpots): ChosenActivity | null {
  if (spots.size === 0 || Math.random() < DESK_SHARE) return null;

  const available = IDLE_ACTIVITIES.filter((a) => spots.has(a.key));
  if (available.length === 0) return null;

  const total = available.reduce((sum, a) => sum + a.weight, 0);
  let roll = Math.random() * total;
  // Последнее занятие берётся запасным: из-за погрешности сложения остаток может
  // не дойти до нуля, и тогда цикл завершился бы вообще без выбора.
  let chosen = available[available.length - 1];
  for (const activity of available) {
    roll -= activity.weight;
    if (roll <= 0) {
      chosen = activity;
      break;
    }
  }
  if (!chosen) return null;

  const places = spots.get(chosen.key);
  if (!places || places.length === 0) return null;
  const spot = places[Math.floor(Math.random() * places.length)];
  if (!spot) return null;
  return {
    key: chosen.key,
    label: chosen.label,
    spot,
    seconds: chosen.minSec + Math.random() * (chosen.maxSec - chosen.minSec),
  };
}
