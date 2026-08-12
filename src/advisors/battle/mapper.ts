import type { BgsBattleInfo } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-info.js';
import type { BgsPlayerEntity } from '@firestone-hs/simulate-bgs-battle/dist/bgs-player-entity.js';
import type {
  BoardEnchantment,
  BoardEntity,
} from '@firestone-hs/simulate-bgs-battle/dist/board-entity.js';

import {
  EMPTY_GLOBAL_INFO,
  type Enchantment,
  type GlobalInfo,
  type Hero,
  type Minion,
} from '../../state/types.js';
import type { BattleEpisode } from './episodes.js';

/**
 * Перевод нашего состояния во входной формат симулятора.
 *
 * Контракт и список того, что мы пока не извлекаем, — в docs/simulator.md.
 */

function toEnchantment(e: Enchantment): BoardEnchantment {
  return {
    cardId: e.cardId,
    timing: e.timing,
    ...(e.scriptDataNum1 === null ? {} : { tagScriptDataNum1: e.scriptDataNum1 }),
    ...(e.scriptDataNum2 === null ? {} : { tagScriptDataNum2: e.scriptDataNum2 }),
  };
}

/** Сырые теги идут числовыми ключами — симулятор ждёт именно так. */
function numericTags(tags: Readonly<Record<string, number>>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [key, value] of Object.entries(tags)) {
    const numeric = Number(key);
    if (Number.isInteger(numeric)) out[numeric] = value;
  }
  return out;
}

export function toBoardEntity(m: Minion): BoardEntity {
  const [d1, d2, d3, d4, d5, d6] = m.scriptData;
  return {
    entityId: m.entityId,
    cardId: m.cardId,
    attack: m.attack ?? 0,
    health: m.health ?? 1,
    ...(m.maxHealth === null ? {} : { maxHealth: m.maxHealth }),
    taunt: m.taunt,
    divineShield: m.divineShield,
    poisonous: m.poisonous,
    venomous: m.venomous,
    reborn: m.reborn,
    windfury: m.windfury,
    stealth: m.stealth,
    ...(m.techLevel === null ? {} : { tavernTier: m.techLevel }),
    enchantments: m.enchantments.map(toEnchantment),
    ...(d1 === null ? {} : { scriptDataNum1: d1 }),
    ...(d2 === null ? {} : { scriptDataNum2: d2 }),
    ...(d3 === null ? {} : { scriptDataNum3: d3 }),
    ...(d4 === null ? {} : { scriptDataNum4: d4 }),
    ...(d5 === null ? {} : { scriptDataNum5: d5 }),
    ...(d6 === null ? {} : { scriptDataNum6: d6 }),
    tags: numericTags(m.tags),
  };
}

/**
 * Счётчики игрока для симулятора — только те, что реально прочитаны из лога.
 *
 * Заполнять неизвестные нулями было попыткой убрать `NaN` в статах спавнов,
 * но замеры это опровергли: калибровка ухудшилась вдвое с лишним
 * (расхождение 4.0 → 9.1 п.п., Brier 0.019 → 0.066). Выдуманный ноль хуже
 * отсутствия — механика начинает работать с заведомо неверным значением,
 * тогда как при отсутствии симулятор обходится своими умолчаниями.
 */
function toGlobalInfo(info: GlobalInfo): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (key: string, value: number | null): void => {
    if (value !== null) out[key] = value;
  };

  put('GoldSpentThisGame', info.goldSpentThisGame);
  put('SpellsCastThisGame', info.spellsCastThisGame);
  put('CardsPlayedThisTurn', info.cardsPlayedThisTurn);
  put('TavernSpellAttackBuff', info.tavernSpellAttackBuff);
  put('TavernSpellHealthBuff', info.tavernSpellHealthBuff);
  put('ElementalAttackBuff', info.elementalAttackBuff);
  put('ElementalHealthBuff', info.elementalHealthBuff);

  return out;
}

export function toPlayerEntity(
  hero: Hero,
  tavernTier: number,
  globalInfo: GlobalInfo,
): BgsPlayerEntity {
  return {
    cardId: hero.cardId,
    hpLeft: (hero.health ?? 0) - hero.damage + hero.armor,
    tavernTier,
    globalInfo: toGlobalInfo(globalInfo),
    heroPowers:
      hero.heroPowerCardId === null
        ? []
        : [
            {
              cardId: hero.heroPowerCardId,
              entityId: hero.heroPowerEntityId ?? 0,
              used: false,
              info: 0,
              info2: 0,
              info3: 0,
              info4: 0,
              info5: 0,
              info6: 0,
            },
          ],
    questEntities: [],
  };
}

/**
 * Собирает вход симулятора для одного боя.
 *
 * Герой противника нам неизвестен: в логе видно его борд, но не карточку героя
 * на момент боя. Подставляется заглушка — на исход боя герой влияет только
 * через силу, а её мы всё равно не извлекаем.
 */
export function toBattleInfo(
  episode: BattleEpisode,
  numberOfSimulations: number,
): BgsBattleInfo {
  const opponentHero: BgsPlayerEntity = {
    cardId: 'TB_BaconShop_HERO_PH',
    hpLeft: 40,
    tavernTier: episode.techLevel,
    heroPowers: [],
    questEntities: [],
    globalInfo: toGlobalInfo(EMPTY_GLOBAL_INFO),
  };

  return {
    playerBoard: {
      player: toPlayerEntity(episode.playerHero, episode.techLevel, episode.globalInfo),
      board: episode.playerBoard.map(toBoardEntity),
    },
    opponentBoard: {
      player: opponentHero,
      board: episode.opponentBoard.map(toBoardEntity),
    },
    options: { numberOfSimulations, skipInfoLogs: true },
    gameState: {
      currentTurn: episode.turn,
      ...(episode.anomalyCardId === null ? {} : { anomalies: [episode.anomalyCardId] }),
    },
  };
}
