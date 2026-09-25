import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodesAsync, type BattleEpisode } from '../../src/advisors/battle/episodes.js';
import { sharedBattleSimulator } from '../../src/advisors/battle/simulator.js';
import { loadFieldBoards, type FieldSnapshot } from '../../src/advisors/strength/boards.js';
import { loadCardIndex } from '../../src/data/cards.js';
import { poolFingerprint } from '../../src/data/pool.js';
import {
  judgePositioning,
  nextBattleSetup,
  recountAddition,
  type RecountDeps,
} from '../../src/report/battle.js';
import { affordableShop } from '../../src/report/facts.js';
import { readTimelineAsync, type GameTimeline, type ReportTurn } from '../../src/report/timeline.js';
import { createBreather } from '../breather.js';
import { part52Game, part68Game } from '../fixtures.js';

/**
 * Пересчёт боя для отчёта: расстановка и цена сгоревшего золота.
 *
 * Эталон расстановки — part52, бой хода 16 (ход таверны 8): сыграно
 * Cord Puller первым, бой проигран с −11 hp. Разведка 25.09 по part52–55
 * (47 боёв): из 16 боёв, где против фактического соперника находилась
 * расстановка лучше сыгранной, этот — единственный, где лучшая лучше
 * и против поля хода. Борд — конца таверны, а не эпизода: эпизод снят
 * после Start of Combat.
 *
 * Поле — ЗАМОРОЖЕННОЕ: ходы таверны 8–9 поля 19.09 (part4–55, 52 борда
 * на ход), `test/field-2026-09-19-turns8-9.json`. Живое поле с 25.09
 * собирается по пулу (D304) и на этих ходах пока уже порога в 12 бордов;
 * ворота факта проверяются здесь на неизменных числах. Сверка пула
 * пройдена нарочно (отпечаток нынешнего пула, в витрине ничего вне него):
 * part52 сыгран до ротации, а сама сверка проверяется в verdict.test.ts.
 */
describe('отчёт после партии: пересчёт боя', () => {
  let deps: RecountDeps;
  let game52: GameTimeline;
  let episodes52: BattleEpisode[];
  let game68: GameTimeline;
  let episodes68: BattleEpisode[];

  beforeAll(async () => {
    const cards = loadCardIndex();
    const frozen = loadFieldBoards(fileURLToPath(new URL('../field-2026-09-19-turns8-9.json', import.meta.url)));
    if (frozen === null) throw new Error('нет замороженного поля');
    const field: FieldSnapshot = { ...frozen, pool: poolFingerprint(cards) };
    deps = { simulator: sharedBattleSimulator(), cards, field, excludePart: 52, gameOffPool: [] };
    const text52 = part52Game();
    game52 = await readTimelineAsync(text52, createBreather());
    episodes52 = await readBattleEpisodesAsync(text52, createBreather());
    const text68 = part68Game();
    game68 = await readTimelineAsync(text68, createBreather());
    episodes68 = await readBattleEpisodesAsync(text68, createBreather());
  }, 600_000);

  const pick = (
    game: GameTimeline,
    episodes: readonly BattleEpisode[],
    turn: number,
  ): { turn: ReportTurn; episode: BattleEpisode } => {
    const t = game.turns.find((x) => x.turn === turn);
    const episode = episodes.find((e) => e.turn === turn + 1);
    if (t === undefined || episode === undefined) throw new Error(`нет хода ${String(turn)}`);
    return { turn: t, episode };
  };

  /**
   * Разведка считала этот бой единственной ошибкой расстановки на part52–55:
   * против поля и против соперника другой порядок лучше. Но у игрока тринкет
   * Emergency Gearblade, платящий краю борда каждый ход, и Cord Puller первым
   * мог стоять ради него. Все числовые ворота факта бой проходит — отсекает
   * его ровно это условие, и отсекать должно.
   */
  it('part52, бой 16: против поля лучше выше порога, но край платный — предположение с причиной', () => {
    const { turn, episode } = pick(game52, episodes52, 15);
    if (turn.beforeCombat === null) throw new Error('нет борда перед боем');
    expect(episode.outcome).toBe('lost');
    expect(episode.damageTaken).toBe(11);
    const judgement = judgePositioning(
      nextBattleSetup(episode, turn.beforeCombat),
      episode,
      turn.beforeCombat,
      turn.tavernTurn,
      deps,
    );
    if (judgement.kind !== 'assumption') throw new Error(`ожидалось предположение, а не ${judgement.kind}`);
    expect(judgement.reasons).toEqual([
      'тринкет Emergency Gearblade платит краю борда каждый ход — расстановка решает не только бой',
    ]);
    // Разведка 25.09: против поля из 51 борда 73.2 → 76.1 %; против
    // соперника (20 000 симуляций) 2.7 % → 95.7 %.
    const field = judgement.field;
    if (field === null) throw new Error('поле хода есть');
    expect(field.distinguishable).toBe(true);
    expect(field.alternative.scorePct - field.played.scorePct).toBeGreaterThanOrEqual(2);
    expect(judgement.actual.played.scorePct).toBeLessThan(10);
    expect(judgement.actual.alternative.scorePct).toBeGreaterThan(85);
    expect(judgement.actual.singleOpponent).toBe(true);
  }, 300_000);

  it('тот же бой на партии другого пула — к причинам добавляется поле (D304)', () => {
    const { turn, episode } = pick(game52, episodes52, 15);
    if (turn.beforeCombat === null) throw new Error('нет борда перед боем');
    const judgement = judgePositioning(
      nextBattleSetup(episode, turn.beforeCombat),
      episode,
      turn.beforeCombat,
      turn.tavernTurn,
      // Molten Rock `BGS_127` — элементаль, ушедший из пула 22.09.
      { ...deps, gameOffPool: ['BGS_127'] },
    );
    if (judgement.kind !== 'assumption') throw new Error(`ожидалось предположение, а не ${judgement.kind}`);
    expect(judgement.reasons.join(' ')).toMatch(/партия сыграна на другом пуле карт: в её витрине были Molten Rock/);
  }, 300_000);

  it('part52, бой 2: первый ход таверны не судится (D087)', () => {
    const { turn, episode } = pick(game52, episodes52, 1);
    if (turn.beforeCombat === null) throw new Error('нет борда перед боем');
    const judgement = judgePositioning(
      nextBattleSetup(episode, turn.beforeCombat),
      episode,
      turn.beforeCombat,
      turn.tavernTurn,
      deps,
    );
    expect(judgement.kind).toBe('skip');
  });

  it('part68, ход 19: цена сгоревшего золота считается на свежих зёрнах против соперника боя 20', () => {
    const { turn, episode } = pick(game68, episodes68, 19);
    if (turn.beforeCombat === null) throw new Error('нет борда перед боем');
    const setup = nextBattleSetup(episode, turn.beforeCombat);
    expect(setup.playerBoard).toHaveLength(6);
    const added = recountAddition(setup, affordableShop(turn.end), { ...deps, excludePart: 68 });
    if (added === null) throw new Error('на борде было место — пересчёт обязан быть');
    expect(added.recount.against).toBe('против фактического соперника');
    expect(added.recount.played.sims).toBe(4000);
    // Кандидат из витрины конца хода и ничего больше.
    expect(affordableShop(turn.end).map((m) => m.entityId)).toContain(added.minion.entityId);
  }, 300_000);
});
