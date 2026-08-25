import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  DESK_SHARE,
  IDLE_ACTIVITIES,
  pickIdleActivity,
  resolveActivitySpots,
} from '../src/office/engine/idleActivities.js';
import type { OfficeLayout } from '../src/office/types.js';

/**
 * Занятия в простое — единственная часть офиса, не отражающая работу ассистента.
 * Здесь проверяется, что штатная планировка действительно даёт сотрудникам куда
 * пойти и что половина простоя остаётся за рабочим местом.
 */
function loadDefaultLayout(): OfficeLayout {
  const file = path.join(__dirname, '..', 'public', 'assets', 'default-layout-1.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OfficeLayout;
}

describe('занятия в простое', () => {
  const layout = loadDefaultLayout();
  const spots = resolveActivitySpots(layout, layout.furniture, new Set());

  it('штатная планировка содержит зоны для всех занятий', () => {
    // Кухня, лаундж, курилка и уборная размечены зонами; чтение — по стеллажам.
    for (const activity of IDLE_ACTIVITIES) {
      expect(spots.get(activity.key)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('точки занятий стоят на проходимых клетках', () => {
    for (const places of spots.values()) {
      for (const spot of places) {
        const tile = layout.tiles[spot.row * layout.cols + spot.col];
        expect(tile).toBeDefined();
        expect(tile).not.toBe(0); // стена
        expect(tile).not.toBe(255); // пустота
      }
    }
  });

  it('занятая мебелью клетка точкой не становится', () => {
    const desk = layout.furniture.find((f) => f.type === 'DESK_FRONT');
    expect(desk).toBeDefined();
    const blocked = new Set([`${desk!.col},${desk!.row}`]);
    const guarded = resolveActivitySpots(layout, layout.furniture, blocked);
    for (const places of guarded.values()) {
      expect(places.some((s) => s.col === desk!.col && s.row === desk!.row)).toBe(false);
    }
  });

  it('около половины простоя приходится на рабочее место', () => {
    let desk = 0;
    const runs = 4000;
    for (let i = 0; i < runs; i++) {
      if (pickIdleActivity(spots) === null) desk++;
    }
    const share = desk / runs;
    // Допуск на случайность: доля должна держаться около DESK_SHARE.
    expect(share).toBeGreaterThan(DESK_SHARE - 0.05);
    expect(share).toBeLessThan(DESK_SHARE + 0.05);
  });

  it('остальное время делится между разными занятиями', () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const chosen = pickIdleActivity(spots);
      if (chosen) seen.set(chosen.key, (seen.get(chosen.key) ?? 0) + 1);
    }
    // Каждое занятие из каталога должно хоть раз выпасть — иначе перекос весов.
    for (const activity of IDLE_ACTIVITIES) {
      expect(seen.get(activity.key) ?? 0).toBeGreaterThan(0);
    }
  });

  it('без зон и мебели сотрудник просто остаётся за столом', () => {
    const bare: OfficeLayout = { ...layout, furniture: [], areaTiles: undefined };
    const empty = resolveActivitySpots(bare, [], new Set());
    expect(empty.size).toBe(0);
    expect(pickIdleActivity(empty)).toBeNull();
  });

  it('у занятия есть подпись и конечная длительность', () => {
    for (let i = 0; i < 200; i++) {
      const chosen = pickIdleActivity(spots);
      if (!chosen) continue;
      expect(chosen.label.length).toBeGreaterThan(0);
      expect(chosen.seconds).toBeGreaterThan(0);
      expect(chosen.seconds).toBeLessThan(120);
    }
  });
});
