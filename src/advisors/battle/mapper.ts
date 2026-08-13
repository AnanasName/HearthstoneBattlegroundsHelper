import type { BgsBattleInfo } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-info.js';
import type {
  BgsPlayerEntity,
  BoardTrinket,
} from '@firestone-hs/simulate-bgs-battle/dist/bgs-player-entity.js';
import type {
  BoardEnchantment,
  BoardEntity,
} from '@firestone-hs/simulate-bgs-battle/dist/board-entity.js';

import { loadCardIndex, type CardIndex } from '../../data/cards.js';
import {
  EMPTY_GLOBAL_INFO,
  type Enchantment,
  type GlobalInfo,
  type Hero,
  type Minion,
} from '../../state/types.js';

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
 * Всё, что нужно знать о положении дел перед боем.
 *
 * Выделено из `BattleEpisode` затем, что эпизод — это бой из лога с уже
 * известным исходом, а советнику расстановки надо считать бой, которого ещё
 * не было. Набор полей тот же, `BattleEpisode` подходит сюда как есть.
 */
export interface BattleSetup {
  readonly turn: number;
  readonly playerBoard: readonly Minion[];
  readonly opponentBoard: readonly Minion[];
  readonly playerHero: Hero;
  readonly techLevel: number;
  readonly anomalyCardId: string | null;
  readonly globalInfo: GlobalInfo;
  /**
   * Взятые тринкеты, свои и противника, как dbfId из лога.
   *
   * Поля необязательные: старые фикстуры сыграны до тринкетов, а часть
   * вызовов собирает вход там, где тринкеты неизвестны. Отсутствие честнее
   * пустого списка — оно означает «не знаем», а не «нет тринкетов».
   */
  readonly playerTrinketDbfIds?: readonly number[];
  readonly opponentTrinketDbfIds?: readonly number[];
}

/**
 * dbfId тринкетов → вход симулятора.
 *
 * Справочник карт грузится лениво и один раз: он нужен только партиям
 * с тринкетами, а тесты маппера на старых фикстурах не должны платить
 * секунду за разбор снапшота, которым не пользуются.
 */
let trinketCards: CardIndex | null = null;

function toTrinkets(dbfIds: readonly number[] | undefined): BoardTrinket[] {
  if (dbfIds === undefined || dbfIds.length === 0) return [];
  trinketCards ??= loadCardIndex();

  return dbfIds.flatMap((dbfId) => {
    const info = trinketCards?.infoByDbfId(dbfId);
    // Незнакомый dbfId молча пропускается: выдуманный тринкет исказил бы
    // бой сильнее, чем отсутствующий.
    if (info === undefined || info === null) return [];
    return [{ cardId: info.id, entityId: 0, scriptDataNum1: 0 }];
  });
}

/**
 * Собирает вход симулятора для одного боя.
 *
 * Герой противника нам неизвестен: в логе видно его борд, но не карточку героя
 * на момент боя. Подставляется заглушка — на исход боя герой влияет только
 * через силу, а её мы всё равно не извлекаем.
 */
export function toBattleInfo(
  episode: BattleSetup,
  numberOfSimulations: number,
): BgsBattleInfo {
  const opponentHero: BgsPlayerEntity = {
    cardId: 'TB_BaconShop_HERO_PH',
    hpLeft: 40,
    tavernTier: episode.techLevel,
    heroPowers: [],
    questEntities: [],
    globalInfo: toGlobalInfo(EMPTY_GLOBAL_INFO),
    trinkets: toTrinkets(episode.opponentTrinketDbfIds),
  };

  return {
    playerBoard: {
      player: {
        ...toPlayerEntity(episode.playerHero, episode.techLevel, episode.globalInfo),
        trinkets: toTrinkets(episode.playerTrinketDbfIds),
      },
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

/**
 * Тот же бой, но со своим бордом в другом порядке.
 *
 * Позиция миньона для симулятора — это индекс в массиве, отдельного поля под
 * неё нет. Поэтому советник расстановки меняет ровно одно: порядок элементов
 * `playerBoard.board`. Всё прочее — герой, счётчики, борд противника, ход —
 * обязано остаться тем же, иначе кандидаты сравниваются в разных условиях.
 */
export function withPlayerBoard(
  input: BgsBattleInfo,
  board: readonly Minion[],
): BgsBattleInfo {
  return {
    ...input,
    playerBoard: { ...input.playerBoard, board: board.map(toBoardEntity) },
  };
}
