/**
 * Модель послематчевого отчёта — то, что пишется в JSON рядом с HTML
 * и из чего собирается индекс партий.
 *
 * Отчёт — функция версии правил: после новой правки пункты старых партий
 * сдвигаются. Поэтому в модели лежат версия схемы и версия приложения,
 * а сам отчёт пересобирается из лога, а не правится на месте (D159:
 * первичен сырой лог, производные устаревают).
 */

export const REPORT_SCHEMA = 1;

/**
 * Раздел пункта.
 *
 * `fact` — «ошибка ли» решена по информации, которая была у игрока
 * в момент хода, и не зависит от советника: правило игры или
 * доминирование, проверенное против поля хода.
 * `assumption` — опирается на советника или на знание задним числом;
 * печатается числами, без вердикта (D193).
 */
export type FindingKind = 'fact' | 'assumption';

export type FindingClass =
  /** Пара на столе, третья копия в витрине по карману — не куплена. */
  | 'missedTriple'
  /** Ход кончился с золотом, которого хватало на миньона витрины. */
  | 'burnedGold'
  /** Бесплатная сила, которая только прибавляет, не нажата. */
  | 'idlePower'
  /** В руке играбельный миньон, на борде есть место. */
  | 'unplacedMinion'
  /** Порядок борда в бою. */
  | 'positioning'
  /** Итоговый борд хода против борда плана советника. */
  | 'planVsPlayer';

/** Числа одного прогона боя — доли в процентах, урон — ожидаемый по герою. */
export interface BattleNumbers {
  /** Победа плюс половина ничьей, 0..100 — величина сравнения расстановок. */
  readonly scorePct: number;
  readonly winPct: number;
  readonly tiePct: number;
  readonly lossPct: number;
  /** Ожидаемый урон по герою за бой (0, если не проиграл). */
  readonly expectedDamage: number;
  readonly sims: number;
}

/** Пересчёт боя: как сыграно против альтернативы. */
export interface BattleRecount {
  /** Против чего считали — словами: «против фактического соперника», «против поля хода (51 борд)». */
  readonly against: string;
  readonly played: BattleNumbers;
  readonly alternative: BattleNumbers;
  /** Разница выше шума: 2σ на независимых зёрнах (D185, D120). */
  readonly distinguishable: boolean;
  /**
   * Против одного соперника. Урон и смерть против одного соперника
   * не калиброваны (D283: верхняя корзина смерти промахивалась на 25 п.п.,
   * тир соперника симулятору подставляется наш), и ожидаемый урон такого
   * пересчёта — оценка, а не число для порога.
   */
  readonly singleOpponent: boolean;
}

/** Что случилось в бою после хода на самом деле. */
export interface BattleFact {
  /** Ход партии боя (чётный). */
  readonly turn: number;
  readonly outcome: 'won' | 'lost' | 'tied';
  readonly damageTaken: number;
}

export interface Finding {
  readonly kind: FindingKind;
  readonly klass: FindingClass;
  /** Ход партии (нечётный — таверна). */
  readonly turn: number;
  /** Ход таверны — шкала, которой говорит игрок (D129). */
  readonly tavernTurn: number;
  /** Часы лога `ЧЧ:ММ:СС` — по ним находится кадр (`fixture:at`). */
  readonly time: string | null;
  /** Одно предложение: что случилось. */
  readonly title: string;
  /** Подробности — строки. */
  readonly details: readonly string[];
  /** Пересчёт влияния; `null` — не считается, причина в `impactNote`. */
  readonly impact: BattleRecount | null;
  readonly impactNote: string | null;
  /** Бой после хода — факт из лога. */
  readonly nextBattle: BattleFact | null;
  /** Чего мерка не видит на этом пункте. */
  readonly caveats: readonly string[];
}

/** Сводка действий хода — счётчики по журналу `GameState.actions`. */
export interface ActionCounts {
  readonly buy: number;
  readonly sell: number;
  readonly roll: number;
  readonly levelUp: number;
  readonly freeze: number;
  readonly play: number;
  readonly heroPower: number;
  readonly other: number;
}

export interface TurnRow {
  readonly turn: number;
  readonly tavernTurn: number;
  readonly tier: number;
  /** Здоровье с бронёй на конце хода — до боя. */
  readonly hp: number;
  readonly goldTotal: number;
  readonly goldLeft: number;
  readonly boardSize: number;
  readonly actions: ActionCounts;
  readonly clicks: number;
  /** Время хода, доступное игроку: без показа прошлого боя, с. */
  readonly turnSeconds: number | null;
  /** Пауза от последнего нажатия до конца хода, с. */
  readonly idleSeconds: number | null;
  /** Последнее действие — в последние секунды хода (`LATE_ACTION_SECONDS`). */
  readonly lateAction: boolean;
  /** Ход оборвал таймер: последнее нажатие не исполнилось. */
  readonly cutByTimer: boolean;
  readonly battle: BattleFact | null;
  /** Классы пунктов этого хода — значки в ленте. */
  readonly marks: readonly FindingClass[];
}

/** Что прибор пропустил и почему — чтобы молчание не читалось как «чисто». */
export interface Skip {
  readonly what: string;
  readonly reason: string;
  readonly count: number;
}

export interface PostGameReport {
  readonly schema: number;
  /** ISO-время сборки — ставит вызывающий: модуль часов не читает. */
  readonly generatedAt: string;
  readonly source: {
    /** `part73` или путь к логу. */
    readonly ref: string;
    /** Номер партии в тексте, если в нём их несколько. */
    readonly gameIndex: number | null;
  };
  readonly game: {
    readonly heroCardId: string | null;
    readonly heroName: string | null;
    readonly place: number | null;
    readonly buildNumber: number | null;
    /** Дата партии `ГГГГ-ММ-ДД`, если известна (из имени сессии логов); в самом логе даты нет. */
    readonly date: string | null;
    /** Часы первой и последней строки партии. */
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly tavernTurns: number;
    /**
     * Партия неполная: лог начинается с дампа переподключения или партия
     * не доиграна. Склейки сегментов из разных сессий у отчёта нет, и ход
     * шва дал бы ложные «сгорело» и «не взята» — поэтому пометка.
     */
    readonly partial: boolean;
  };
  /**
   * Чем посчитан отчёт — версия анализа, а не только формы: советник,
   * пороги и поле меняются, и тренд через разные версии строить нельзя.
   */
  readonly analysis: {
    readonly appVersion: string | null;
    readonly simulatorVersion: string | null;
    /** Когда собрано поле бордов и на каком билде. */
    readonly fieldBuiltAt: string | null;
    readonly fieldBuild: number | null;
    /** Поле собрано на той же игре, что партия: иначе расстановка фактом не бывает. */
    readonly fieldFitsGame: boolean;
  };
  readonly turns: readonly TurnRow[];
  readonly facts: readonly Finding[];
  readonly assumptions: readonly Finding[];
  /** Чего отчёт не судит вовсе — классы ходов с причиной. */
  readonly notJudged: readonly { readonly what: string; readonly reason: string }[];
  /**
   * Сводка сравнения «план советника против хода» по всем сравнённым ходам.
   * Пунктами в отчёт идут только ходы, где план сильнее выше шума; ходы,
   * где сильнее стол игрока, — только числом здесь: в отчёте об ошибках
   * они шум, а в споре «советник ли судья» — довод, и потерять его нельзя.
   */
  readonly planTally: {
    readonly compared: number;
    readonly same: number;
    readonly withinNoise: number;
    readonly playerStronger: number;
    readonly planStronger: number;
  };
  readonly skipped: readonly Skip[];
  readonly elapsedMs: number;
}
