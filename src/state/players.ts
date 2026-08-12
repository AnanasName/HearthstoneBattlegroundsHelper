import { parseLogLine, splitLogLines } from '../parser/logLine.js';

/**
 * Определение «кто я» в партии.
 *
 * В Battlegrounds лог заводит ровно две сущности Player, хотя игроков восемь:
 *
 *   Player EntityID=11 PlayerID=4  GameAccountId=[hi=144115198130930503 lo=113002704]
 *   Player EntityID=12 PlayerID=12 GameAccountId=[hi=0 lo=0]
 *
 * Первая — сам игрок, вторая — переиспользуемый слот «соперник». В таверне
 * в нём сидит Бармен Боб, а на бой подставляется герой очередного оппонента:
 * `HERO_ENTITY` этого слота ходит между 62 (Боб) и id героя противника.
 *
 * Свой игрок опознаётся по ненулевому `GameAccountId` — у системного слота он
 * `[hi=0 lo=0]`. Это признак из самого лога, без догадок про номера.
 */

const PLAYER_DECL_RE =
  /^Player EntityID=(\d+) PlayerID=(\d+) GameAccountId=\[hi=(\d+) lo=(\d+)\]/;

const PLAYER_NAME_RE = /^PlayerID=(\d+), PlayerName=(.+)$/;

export const PLAYER_NAME_SOURCE = 'GameState.DebugPrintGame';

export interface PlayerDecl {
  readonly entityId: number;
  readonly playerId: number;
  /** Ненулевой только у самого игрока. */
  readonly hasAccount: boolean;
}

export interface Players {
  /** PlayerID → отображаемое имя. Для себя это BattleTag. */
  readonly names: ReadonlyMap<number, string>;
  /** Объявления из CREATE_GAME. */
  readonly decls: readonly PlayerDecl[];
  /** PlayerID самого игрока. */
  readonly selfPlayerId: number | null;
  /** BattleTag самого игрока — им подписаны TAG_CHANGE про него. */
  readonly selfName: string | null;
}

/**
 * Накопление сведений об игроках по строкам.
 *
 * В живом режиме «кто я» становится известно не сразу: объявления `Player`
 * идут в дампе CREATE_GAME, а имена — двумя сотнями строк ниже, уже в другом
 * канале. Редьюсер же требует готовых `Players` при создании, поэтому кто-то
 * должен уметь ответить «уже знаю» — это и есть задача накопителя.
 */
export class PlayersCollector {
  readonly #names = new Map<number, string>();
  readonly #decls: PlayerDecl[] = [];

  push(raw: string): void {
    const line = parseLogLine(raw);
    if (line === null) return;

    if (line.source === PLAYER_NAME_SOURCE) {
      const m = PLAYER_NAME_RE.exec(line.content);
      if (m?.[1] !== undefined && m[2] !== undefined) {
        this.#names.set(Number(m[1]), m[2]);
      }
      return;
    }

    const m = PLAYER_DECL_RE.exec(line.content);
    if (m?.[1] === undefined) return;
    const [, entityId, playerId, hi, lo] = m;
    if (playerId === undefined || hi === undefined || lo === undefined) return;

    const decl: PlayerDecl = {
      entityId: Number(entityId),
      playerId: Number(playerId),
      hasAccount: hi !== '0' || lo !== '0',
    };
    if (!this.#decls.some((d) => d.entityId === decl.entityId)) this.#decls.push(decl);
  }

  /** Снимок независим от накопителя: редьюсер держит его у себя всю партию. */
  snapshot(): Players {
    const self = this.#decls.find((d) => d.hasAccount) ?? null;
    const selfPlayerId = self?.playerId ?? null;

    return {
      names: new Map(this.#names),
      decls: [...this.#decls],
      selfPlayerId,
      selfName: selfPlayerId === null ? null : (this.#names.get(selfPlayerId) ?? null),
    };
  }

  /** Известно ли всё, на чём стоит определение «кто я». */
  get resolved(): boolean {
    const self = this.#decls.find((d) => d.hasAccount);
    return self !== undefined && this.#names.has(self.playerId);
  }
}

/** Собирает сведения об игроках. Дёшево: один проход, только нужные строки. */
export function readPlayers(text: string): Players {
  const collector = new PlayersCollector();
  for (const raw of splitLogLines(text)) collector.push(raw);
  return collector.snapshot();
}
