/**
 * Сборка эталонного поля бордов.
 *
 *   npm run field:fit
 *
 * Читает логи фикстур, вынимает из каждого боя борд СОПЕРНИКА и складывает
 * их по ходам таверны в `data/field/boards.json`. Устройство и доводы —
 * в boards.ts, числа — в docs/quality.md.
 *
 * ## Какие партии — по пулу, а не по списку (D304)
 *
 * До 25.09 поле собиралось из `CURRENT_BUILD_PARTS`, списка батареи.
 * 22.09 пул сменился посреди билда 251952 (part67 | part68), и у 357
 * из 662 бордов прежнего поля оказались карты вне пула. Поле — это норма
 * хода ТЕКУЩЕЙ игры, поэтому партия берётся в него, только если все карты
 * её витрины с меткой пула (`seenShopPoolCardIds`) лежат в пуле снапшота
 * карт (`src/data/pool.ts`). Борд несёт и Божество соперника: с пулом
 * 22.09 оно есть в каждом бою (`FieldBoard.deity`). Отбор — правило,
 * а не литерал: новая фикстура входит сама, а после следующей ротации
 * (обновления снапшота карт) старые партии уйдут сами. Выпавшие партии
 * печатаются с картами, из-за которых выпали.
 *
 * Гонять из ЧИСТОГО дерева и перепрогонять при каждой новой фикстуре
 * и при обновлении снапшота карт: тест `test/data/fieldPool.test.ts`
 * не даёт закоммитить поле, собранное на другом пуле.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBattleEpisodes } from '../battle/episodes.js';
import { loadCardIndex, type CardIndex } from '../../data/cards.js';
import { fixturePartsAll, readFixtureGame } from '../../data/fixtureGames.js';
import { offPoolShopCards, poolFingerprint } from '../../data/pool.js';
import { reduceLog } from '../../state/reducer.js';
import { tavernTurnOf } from '../tavern/rules.js';
import {
  FIELD_BOARDS_PATH,
  type FieldBoard,
  type FieldDamage,
  type FieldSnapshot,
} from './boards.js';

export interface CollectedField {
  readonly boards: FieldBoard[];
  readonly damage: FieldDamage[];
  /** Партии, вошедшие в поле. */
  readonly parts: number[];
  /** Партии другого пула — и карты их витрины, которых в пуле нет. */
  readonly dropped: { readonly part: number; readonly offPool: readonly string[] }[];
}

export function collectFieldBoards(
  parts: readonly number[],
  cards: CardIndex,
  onPart?: (part: number, boards: number, offPool: readonly string[]) => void,
): CollectedField {
  const boards: FieldBoard[] = [];
  const kept: number[] = [];
  const dropped: { part: number; offPool: string[] }[] = [];
  // Урон копится по ходу таверны и только по ПРОИГРАННЫМ боям — довод
  // у `FieldDamage`.
  const losses = new Map<number, number[]>();
  for (const part of parts) {
    const text = readFixtureGame(part);
    if (text === null) continue;
    const offPool = offPoolShopCards(reduceLog(text).seenShopPoolCardIds, cards);
    if (offPool.length > 0) {
      dropped.push({ part, offPool });
      onPart?.(part, 0, offPool);
      continue;
    }
    kept.push(part);
    let added = 0;
    for (const episode of readBattleEpisodes(text)) {
      const tavernTurn = tavernTurnOf(episode.turn);
      if (episode.outcome === 'lost') {
        const seen = losses.get(tavernTurn) ?? [];
        seen.push(episode.damageTaken);
        losses.set(tavernTurn, seen);
      }
      // Пустой борд соперника — это бой с уже мёртвым столом либо обрыв
      // снятия; полем такой борд быть не может, он утянул бы норму вниз.
      if (episode.opponentBoard.length === 0) continue;
      boards.push({
        tavernTurn,
        part,
        turn: episode.turn,
        board: episode.opponentBoard,
        trinketDbfIds: episode.opponentTrinketDbfIds,
        deity: episode.opponentDeity,
      });
      added += 1;
    }
    onPart?.(part, added, []);
  }

  const damage: FieldDamage[] = [...losses.entries()]
    .map(([tavernTurn, taken]) => ({
      tavernTurn,
      mean: taken.reduce((a, b) => a + b, 0) / taken.length,
      losses: taken.length,
    }))
    .sort((a, b) => a.tavernTurn - b.tavernTurn);

  return { boards, damage, parts: kept, dropped };
}

function main(): void {
  const cards = loadCardIndex();
  const { boards, damage, parts, dropped } = collectFieldBoards(fixturePartsAll(), cards, (part, added, offPool) => {
    console.error(
      offPool.length === 0
        ? `part${String(part)}: бордов ${String(added)}`
        : `part${String(part)}: другой пул — вне пула ${String(offPool.length)} карт витрины`,
    );
  });

  const snapshot: FieldSnapshot = {
    builtAt: new Date().toISOString(),
    pool: poolFingerprint(cards),
    parts,
    boards,
    damage,
  };

  mkdirSync(dirname(FIELD_BOARDS_PATH), { recursive: true });
  writeFileSync(FIELD_BOARDS_PATH, JSON.stringify(snapshot), 'utf8');

  const byTurn = new Map<number, number>();
  for (const b of boards) byTurn.set(b.tavernTurn, (byTurn.get(b.tavernTurn) ?? 0) + 1);
  console.log(
    `\nпул ${snapshot.pool}: партий ${String(parts.length)} (part${parts.join(', part')}), ` +
      `другого пула ${String(dropped.length)}`,
  );
  console.log(`бордов ${String(boards.length)} → ${FIELD_BOARDS_PATH}`);
  console.log('ход таверны | бордов | цена поражения (hp) | проигранных боёв');
  for (const tt of [...byTurn.keys()].sort((a, b) => a - b)) {
    const d = damage.find((x) => x.tavernTurn === tt);
    console.log(
      `${String(tt).padStart(11)} | ${String(byTurn.get(tt) ?? 0).padStart(6)} | ` +
        `${(d === undefined ? '-' : d.mean.toFixed(1)).padStart(19)} | ${String(d?.losses ?? 0).padStart(16)}`,
    );
  }
}

main();
