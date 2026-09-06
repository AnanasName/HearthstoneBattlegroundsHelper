/**
 * Сборка эталонного поля бордов.
 *
 *   npm run field:fit
 *
 * Читает логи партий `CURRENT_BUILD_PARTS`, вынимает из каждого боя борд
 * СОПЕРНИКА и складывает их по ходам таверны в `data/field/boards.json`.
 * Устройство и доводы — в boards.ts, числа — в docs/quality.md.
 *
 * Гонять надо из ЧИСТОГО дерева и перепрогонять при росте списка партий:
 * снапшот — такие же данные, как веса прогноза места, и устаревает он
 * так же (правило `CURRENT_BUILD_PARTS`, CLAUDE.md).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBattleEpisodes } from '../battle/episodes.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';
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
}

export function collectFieldBoards(
  parts: readonly number[] = CURRENT_BUILD_PARTS,
  onPart?: (part: number, boards: number) => void,
): CollectedField {
  const boards: FieldBoard[] = [];
  // Урон копится по ходу таверны и только по ПРОИГРАННЫМ боям — довод
  // у `FieldDamage`.
  const losses = new Map<number, number[]>();
  for (const part of parts) {
    const text = readFixtureGame(part);
    if (text === null) continue;
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
      });
      added += 1;
    }
    onPart?.(part, added);
  }

  const damage: FieldDamage[] = [...losses.entries()]
    .map(([tavernTurn, taken]) => ({
      tavernTurn,
      mean: taken.reduce((a, b) => a + b, 0) / taken.length,
      losses: taken.length,
    }))
    .sort((a, b) => a.tavernTurn - b.tavernTurn);

  return { boards, damage };
}

function main(): void {
  const { boards, damage } = collectFieldBoards(CURRENT_BUILD_PARTS, (part, added) => {
    console.error(`part${String(part)}: бордов ${String(added)}`);
  });

  const snapshot: FieldSnapshot = {
    builtAt: new Date().toISOString(),
    parts: [...CURRENT_BUILD_PARTS],
    boards,
    damage,
  };

  mkdirSync(dirname(FIELD_BOARDS_PATH), { recursive: true });
  writeFileSync(FIELD_BOARDS_PATH, JSON.stringify(snapshot), 'utf8');

  const byTurn = new Map<number, number>();
  for (const b of boards) byTurn.set(b.tavernTurn, (byTurn.get(b.tavernTurn) ?? 0) + 1);
  console.log(`\nбордов ${String(boards.length)} из ${String(CURRENT_BUILD_PARTS.length)} партий → ${FIELD_BOARDS_PATH}`);
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
