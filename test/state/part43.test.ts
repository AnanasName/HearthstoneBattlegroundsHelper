import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { recommendationLine } from '../../src/ui/format.js';
import { part43Game } from '../fixtures.js';

/**
 * part43 — MC Scabbs, ТРЕТЬЕ место (06.09.2026). Семь пунктов игрока;
 * здесь держатся три, которые оказались дефектами ЧТЕНИЯ КАРТ, и фактура,
 * на которой они разобраны.
 *
 * Все шесть кадров игрока сняты В СЕРЕДИНЕ хода, поэтому часть проверок
 * идёт по срезу лога до времени кадра, а не по точке решения: по точкам
 * не воспроизводится ни один из пунктов (тот же метод, что в part40).
 */
describe('part43: ветви модального миньона, витринный бафф и цель провокации', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part43Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  /** Состояние партии на момент времени кадра — срезом лога. */
  const at = (until: string): GameState => {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      lines.push(line);
    }
    return reduceLog(lines.join('\n'));
  };

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  const advice = (state: GameState) => {
    const a = adviseTavern(state, { cards });
    expect(a, 'совет на этом состоянии').not.toBeNull();
    return a!;
  };

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  it('ход 15: числа ветвей приходят СВОИМИ сущностями, а не тегами родителя', () => {
    // Пункт 2 игрока, и это ядро дефекта: у родителя scriptData [1,1,4],
    // а вторая ветвь пишет «+{0} Attack» — то есть по родительским тегам
    // читалось +1 при настоящих +4. Игра числа ветвей называет сама:
    // 02:00:44, сущности 3717 (BG27_084t → 1 и 1) и 3718 (BG27_084t2 → 4),
    // связь с родителем — тег CREATOR.
    const state = at('02:03:40');
    const scarab = state.hand.find((m) => m.cardId === 'BG27_084');
    expect(scarab, 'скарабей в руке на кадре игрока').toBeDefined();
    expect(scarab!.scriptData.slice(0, 3)).toEqual([1, 1, 4]);
    expect(scarab!.branchScriptData).toEqual({
      BG27_084t: [1, 1, null, null],
      BG27_084t2: [4, null, null, null],
    });
  });

  it('ход 15: совет называет и ВЕТВЬ словами, и ЦЕЛЬ', () => {
    // «Не подсказывает какой и на кого» — обе половины жалобы. Ветвь
    // подписана ключевым словом (по нему её и видно на экране игры),
    // цель — зверь: так сказано в тексте самой ветви, и на борде зверей
    // четверо из семи, а крупнейшее тело борда — ПИРАТ.
    const state = at('02:03:40');
    const play = advice(state).recommendations.find(
      (r) => r.action === 'play' && r.minion?.cardId === 'BG27_084',
    );
    expect(play, 'совет разыграть скарабея').toBeDefined();

    const branches = play!.spellBranches ?? [];
    expect(branches).toHaveLength(1);
    expect(branches[0]?.label).toContain('вихрь');
    expect(branches[0]?.label).toContain('+4');

    expect(play!.targetMinion?.cardId).toBe('BG31_809');
    const line = recommendationLine(play!, cards);
    expect(line).toContain('Turquoise Skitterer');
  });

  it('ход 23: витринный бафф читается витринным, а не усилением своего миньона', () => {
    // Пункт 5 игрока. Eonar's Favor: «Choose a minion. Give minions of its
    // type in the Tavern +3/+3 this game». Ни цели на борде, ни +6 статов
    // нашему миньону тут нет — до part43 совет обещал и то, и другое.
    const state = decisionPoint(23);
    const buy = advice(state).recommendations.find(
      (r) => r.action === 'buy' && r.spellCardId === 'BG35_912',
    );
    expect(buy, 'совет купить Eonar’s Favor').toBeDefined();
    expect(buy!.targetMinion ?? null).toBeNull();
    // Тип выбираем мы, и совет обязан назвать какой: на борде шесть зверей
    // из семи.
    expect(buy!.shopBuffPick).toBe('BEAST');
    expect(buy!.reason).toContain('до конца партии');
    expect(recommendationLine(buy!, cards)).toContain('выбрать BEAST');
  });

  it('ход 23: у баффа «this game» цена считается будущими покупками, а не этим ходом', () => {
    // Замер `spike:horizon` даёт на 12-м ходу таверны 10.6 покупок впереди,
    // но статы живут на телах, а тел на борде семь — по ним и считается.
    // Прежнее число было 3.0 очка (усиление своего миньона минус цена),
    // и оно было про другую карту.
    const state = decisionPoint(23);
    const buy = advice(state).recommendations.find(
      (r) => r.action === 'buy' && r.spellCardId === 'BG35_912',
    );
    expect(buy!.score).toBeGreaterThan(10);
    expect(buy!.score).toBeLessThan(15);
  });

  it('журнал: скарабей разыгран трижды и все три раза ПЕРВОЙ ветвью', () => {
    // Игрок — не эталон (второй контур, docs/ml.md), но три из трёх стоят
    // того, чтобы это было записано: советник теперь называет ВТОРУЮ ветвь,
    // и на этой партии ближайший бой их не различает (обе дают 0.00 %).
    const state = reduceLog(text);
    const plays = state.actions.filter((a) => a.type === 'play' && a.cardId === 'BG27_084');
    expect(plays.map((p) => p.turn)).toEqual([15, 23, 27]);
    expect(plays.every((p) => p.subOption === 0)).toBe(true);
  });

  it('ход 21: у тёмного дара метки нет — кнопка не размечена, и это видно', () => {
    // Пункт 4 игрока. Проверяется факт, а не желание: верхний совет —
    // тёмный дар, и координаты у него нет, поэтому на столе не помечается
    // ничего. Когда координата появится, тест упадёт и его надо будет
    // переписать вместе с разметкой.
    const state = decisionPoint(21);
    const top = advice(state).recommendations[0];
    expect(top?.action).toBe('darkGift');
  });
});
