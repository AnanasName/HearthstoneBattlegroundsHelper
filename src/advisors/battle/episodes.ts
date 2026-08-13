import { insideBlock, readPowerEvents } from '../../parser/blocks.js';
import { readPlayers } from '../../state/players.js';
import { createReducer } from '../../state/reducer.js';
import type { GameState, GlobalInfo, Hero, Minion } from '../../state/types.js';

/**
 * Извлечение боёв с известным исходом.
 *
 * Нужно для калибровки: ТЗ формулирует DoD фазы 2 как «фактический исход
 * не является выбросом», но по одному бою это почти невозможно опровергнуть.
 * Тридцать боёв с фактическими результатами дают нормальную метрику.
 */

export type Outcome = 'won' | 'lost' | 'tied';

export interface BattleEpisode {
  /** Номер хода партии, на котором случился бой. */
  readonly turn: number;
  /** Свой борд на начало боя, до первого размена. */
  readonly playerBoard: readonly Minion[];
  /** Борд противника на начало боя. */
  readonly opponentBoard: readonly Minion[];
  readonly playerHero: Hero;
  readonly techLevel: number;
  readonly anomalyCardId: string | null;
  readonly globalInfo: GlobalInfo;
  readonly opponentPlayerId: number | null;
  /** Взятые тринкеты, свои и противника, как dbfId из лога. */
  readonly playerTrinketDbfIds: readonly number[];
  readonly opponentTrinketDbfIds: readonly number[];
  /** Чем бой закончился на самом деле. */
  readonly outcome: Outcome;
  /** Сколько здоровья потерял игрок. */
  readonly damageTaken: number;
}

/** Здоровье с бронёй — то, что реально теряется в бою. */
function effectiveHp(hero: Hero | null): number {
  if (hero === null) return 0;
  return (hero.health ?? 0) - hero.damage + hero.armor;
}

interface Pending {
  turn: number;
  playerBoard: readonly Minion[];
  opponentBoard: readonly Minion[];
  playerHero: Hero;
  techLevel: number;
  anomalyCardId: string | null;
  globalInfo: GlobalInfo;
  opponentPlayerId: number | null;
  playerTrinketDbfIds: readonly number[];
  opponentTrinketDbfIds: readonly number[];
  hpBefore: number;
}

/**
 * Собирает бои из лога партии.
 *
 * Момент снятия бордов выбран так: в фазе боя состояние обновляется на каждом
 * событии, пока не начался первый блок `ATTACK`. Последний снимок перед ним и
 * есть расстановка на начало боя — обе стороны уже выставлены, но размены ещё
 * не начались. Снимать позже нельзя: к концу боя половина миньонов мертва,
 * а к выходу в таверну чужие вообще убраны из `PLAY`.
 */
export function readBattleEpisodes(text: string): BattleEpisode[] {
  const reducer = createReducer(readPlayers(text));
  const episodes: BattleEpisode[] = [];

  let phase: GameState['phase'] = 'tavern';
  let pending: Pending | null = null;
  let frozen = false;
  let hpBeforeCombat = 0;

  for (const event of readPowerEvents(text)) {
    reducer.step(event);

    const combatStarting = event.line.content.includes('BOARD_VISUAL_STATE');
    const inAttack = insideBlock(event, 'ATTACK');

    // Снимок дорогой, поэтому берётся только там, где он может понадобиться:
    // на переключении фазы и внутри боя до первого размена.
    if (!combatStarting && !(phase === 'combat' && !frozen) && !inAttack) continue;

    const state = reducer.snapshot();

    if (state.phase === 'combat' && phase !== 'combat') {
      hpBeforeCombat = effectiveHp(state.hero);
      pending = null;
      frozen = false;
    }

    if (state.phase === 'combat' && !frozen && state.hero !== null) {
      if (inAttack && pending !== null) {
        // Первый размен — фиксируем то, что накопили до него.
        frozen = true;
      } else if (state.opponentBoard.length > 0 || state.board.length > 0) {
        pending = {
          turn: state.turn,
          playerBoard: state.board,
          opponentBoard: state.opponentBoard,
          playerHero: state.hero,
          techLevel: state.techLevel,
          anomalyCardId: state.anomalyCardId,
          globalInfo: state.globalInfo,
          opponentPlayerId: state.currentOpponentPlayerId,
          playerTrinketDbfIds:
            state.playerId === null ? [] : (state.trinketsByPlayer[state.playerId] ?? []),
          opponentTrinketDbfIds:
            state.currentOpponentPlayerId === null
              ? []
              : (state.trinketsByPlayer[state.currentOpponentPlayerId] ?? []),
          hpBefore: hpBeforeCombat,
        };
      }
    }

    if (state.phase !== 'combat' && phase === 'combat' && pending !== null) {
      const damageTaken = Math.max(0, pending.hpBefore - effectiveHp(state.hero));
      // BACON_WON_LAST_COMBAT согласуется с потерей здоровья на всех боях
      // обеих фикстур, но приходит не с первого боя — поэтому урон надёжнее.
      const outcome: Outcome =
        state.wonLastCombat === true ? 'won' : damageTaken > 0 ? 'lost' : 'tied';

      episodes.push({
        turn: pending.turn,
        playerBoard: pending.playerBoard,
        opponentBoard: pending.opponentBoard,
        playerHero: pending.playerHero,
        techLevel: pending.techLevel,
        anomalyCardId: pending.anomalyCardId,
        globalInfo: pending.globalInfo,
        opponentPlayerId: pending.opponentPlayerId,
        playerTrinketDbfIds: pending.playerTrinketDbfIds,
        opponentTrinketDbfIds: pending.opponentTrinketDbfIds,
        outcome,
        damageTaken,
      });
      pending = null;
    }

    phase = state.phase;
  }

  return episodes;
}
