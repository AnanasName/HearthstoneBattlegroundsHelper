import { readBattleEpisodes, readBattleEpisodesAsync, type BattleEpisode } from '../advisors/battle/episodes.js';
import type { BattleSimulator } from '../advisors/battle/simulator.js';
import type { FieldSnapshot } from '../advisors/strength/boards.js';
import { readTavernTurns, readTavernTurnsAsync } from '../advisors/tavern/turns.js';
import type { CardIndex } from '../data/cards.js';
import { offPoolShopCards } from '../data/pool.js';
import type { Yielder } from '../parser/blocks.js';
import type { GameState, Minion, PlayerActionType } from '../state/types.js';
import { minionLabel, recommendationLine } from '../ui/format.js';
import { judgePlan, planFinding } from './assumptions.js';
import {
  DEFAULT_RECOUNT_OPTIONS,
  fieldFitsGame,
  fieldPoolReason,
  judgePositioning,
  nextBattleSetup,
  recountAddition,
  recountPlacement,
  type RecountDeps,
} from './battle.js';
import {
  NOT_JUDGED,
  affordableShop,
  burnedGold,
  cutByTimer,
  idlePowers,
  idleSlots,
  lateLastAction,
  missedTriples,
  unplacedMinions,
} from './facts.js';
import { idleBeforeEnd, readTimeline, readTimelineAsync, turnSeconds, type ReportTurn } from './timeline.js';
import {
  REPORT_SCHEMA,
  type ActionCounts,
  type BattleFact,
  type Finding,
  type PostGameReport,
  type Skip,
  type TurnRow,
} from './types.js';

/**
 * Сборка послематчевого отчёта из текста ОДНОЙ партии.
 *
 * Разделы и правило, которое их разводит, — в `types.ts` (`FindingKind`)
 * и в решении об отчёте. Здесь — порядок работ и склейка: лента,
 * факты, их цена в ближайшем бою, расстановка, предположения о плане.
 *
 * Стоимость: разбор — секунды (лента 0.3–1 с, точки решения 3–12 с,
 * бои 7–26 с на партиях 33–85 МБ), расстановка — около двух минут
 * на партию (поиск без бюджета по часам, part52 — 124 с), план — десятки
 * секунд. Поэтому сборка асинхронная: с `yielder` она отдаёт поток между
 * событиями и боями и годится и для воркера, и для тестов.
 */

export interface BuildDeps {
  readonly cards: CardIndex;
  readonly simulator: BattleSimulator;
  readonly field: FieldSnapshot | null;
  readonly yielder?: Yielder;
}

export interface BuildOptions {
  /** `part73` или путь к логу — для шапки отчёта. */
  readonly ref: string;
  readonly gameIndex: number | null;
  /** Дата партии `ГГГГ-ММ-ДД`, если её знает вызывающий (имя сессии логов). */
  readonly date?: string | null;
  /** Партия-фикстура: её борды не входят в поле, против которого она мерится. */
  readonly excludePart: number | null;
  /** ISO-время сборки: модуль часов не читает, чтобы отчёт был воспроизводим. */
  readonly generatedAt: string;
  readonly appVersion: string | null;
  /** Версия пакета симулятора — в шапку анализа. */
  readonly simulatorVersion?: string | null;
  /** Считать расстановку (дорого) — по умолчанию да. */
  readonly positioning?: boolean;
  /** Считать предположения о плане — по умолчанию да. */
  readonly plan?: boolean;
  /** Строка о ходе работы — для терминала. */
  readonly onProgress?: (message: string) => void;
}

const ACTION_BUCKET: Readonly<Record<PlayerActionType, keyof ActionCounts>> = {
  buy: 'buy',
  sell: 'sell',
  roll: 'roll',
  levelUp: 'levelUp',
  freeze: 'freeze',
  unfreeze: 'other',
  play: 'play',
  heroPower: 'heroPower',
  darkGift: 'other',
  activate: 'other',
  trinket: 'other',
};

function effectiveHp(state: GameState): number {
  const h = state.hero;
  return h === null ? 0 : (h.health ?? 0) - h.damage + h.armor;
}

function battleFact(episode: BattleEpisode | undefined): BattleFact | null {
  return episode === undefined
    ? null
    : { turn: episode.turn, outcome: episode.outcome, damageTaken: episode.damageTaken };
}

function countActions(state: GameState, turn: number): ActionCounts {
  const counts = { buy: 0, sell: 0, roll: 0, levelUp: 0, freeze: 0, play: 0, heroPower: 0, other: 0 };
  for (const a of state.actions) if (a.turn === turn) counts[ACTION_BUCKET[a.type]] += 1;
  return counts;
}

function addSkip(skips: Map<string, Skip>, what: string, reason: string): void {
  const key = `${what}|${reason}`;
  const prev = skips.get(key);
  skips.set(key, { what, reason, count: (prev?.count ?? 0) + 1 });
}

export async function buildPostGameReport(
  text: string,
  deps: BuildDeps,
  options: BuildOptions,
): Promise<PostGameReport> {
  const started = Date.now();
  const say = options.onProgress ?? (() => undefined);
  const { yielder, cards } = deps;
  const pause = async (): Promise<void> => {
    if (yielder !== undefined) await yielder.pause();
  };

  say('лента ходов');
  const timeline = yielder === undefined ? readTimeline(text) : await readTimelineAsync(text, yielder);
  say('точки решения');
  const starts = new Map(
    (yielder === undefined ? readTavernTurns(text) : await readTavernTurnsAsync(text, yielder)).map(
      (t) => [t.turn, t.state] as const,
    ),
  );
  say('бои');
  const episodes = new Map(
    (yielder === undefined ? readBattleEpisodes(text) : await readBattleEpisodesAsync(text, yielder)).map(
      (e) => [e.turn, e] as const,
    ),
  );

  const final = timeline.final;
  const skips = new Map<string, Skip>();
  const ctx = {
    cards,
    actions: final.actions,
    silenced: (what: string, reason: string) => {
      addSkip(skips, what, reason);
    },
  };
  const recountDeps: RecountDeps = {
    simulator: deps.simulator,
    cards,
    field: deps.field,
    excludePart: options.excludePart,
    gameOffPool: offPoolShopCards(final.seenShopPoolCardIds, cards),
  };
  const poolReason = fieldPoolReason(recountDeps);
  const turnByNumber = new Map(timeline.turns.map((t) => [t.turn, t] as const));
  const boardLine = (board: readonly Minion[]): string =>
    board.length === 0 ? '—' : board.map((m) => minionLabel(m, cards)).join(' | ');
  const setupOf = (turn: ReportTurn) => {
    const episode = episodes.get(turn.turn + 1);
    return episode === undefined || turn.beforeCombat === null
      ? null
      : { episode, state: turn.beforeCombat, setup: nextBattleSetup(episode, turn.beforeCombat) };
  };
  const gameOver = final.phase === 'gameOver';

  // ── факты из лога ──
  say('факты');
  const logFindings: Finding[] = [
    ...missedTriples(timeline.turns, ctx),
    ...burnedGold(timeline.turns, ctx, gameOver),
    ...idlePowers(timeline.turns, ctx),
    ...idleSlots(timeline.turns, ctx),
  ];

  // ── их цена в ближайшем бою ──
  say('цена фактов в ближайшем бою');
  const priced: Finding[] = [];
  for (const finding of logFindings) {
    const turn = turnByNumber.get(finding.turn);
    const next = turn === undefined ? null : setupOf(turn);
    let withBattle: Finding = { ...finding, nextBattle: battleFact(next?.episode) };
    if (turn !== undefined && next !== null) {
      if (finding.klass === 'burnedGold') {
        const added = recountAddition(next.setup, affordableShop(turn.end), recountDeps);
        withBattle =
          added === null
            ? {
                ...withBattle,
                impactNote:
                  'Борд был полон: покупка ушла бы в руку и ближайшего боя не изменила бы. Потеря — около 1 золота, которое карта дала бы продажей на следующем ходу, или сама карта.',
              }
            : {
                ...withBattle,
                impact: added.recount,
                details: [
                  ...withBattle.details,
                  `лучшая из доступных покупок для этого боя — ${minionLabel(added.minion, cards)}`,
                ],
                caveats: [
                  'Покупка ставится в пересчёт голым телом в конец борда: клич и эффекты покупки не входят.',
                ],
              };
      } else if (finding.klass === 'unplacedMinion') {
        const minion = unplacedMinions(turn, cards)[0];
        const recount = minion === undefined ? null : recountPlacement(next.setup, minion, recountDeps);
        // Предположение «надо было поставить» пересчёт против соперника,
        // различимо говорящий «с ним хуже», снимает: спорить с собственным
        // числом ему нечем (part73, ход 23: Gatekeeper Amalgam — 79 % → 69 %).
        // Факт (ход оборван таймером) так не снимается: он решён тем, что
        // было в момент хода, а соперник — знание задним числом (D303).
        if (
          finding.kind === 'assumption' &&
          recount !== null &&
          recount.distinguishable &&
          recount.alternative.scorePct < recount.played.scorePct
        ) {
          addSkip(skips, 'Миньон в руке при свободном месте', 'поставить его было хуже для ближайшего боя');
          continue;
        }
        withBattle = recount === null ? withBattle : { ...withBattle, impact: recount };
      }
    } else if (withBattle.impactNote === null) {
      withBattle = { ...withBattle, impactNote: 'Боя после этого хода в логе нет.' };
    }
    priced.push(withBattle);
    await pause();
  }

  // ── расстановка ──
  const positionFindings: Finding[] = [];
  if (options.positioning !== false) {
    for (const turn of timeline.turns) {
      const next = setupOf(turn);
      if (next === null) continue;
      say(`расстановка: бой после хода таверны ${String(turn.tavernTurn)}`);
      const judgement = judgePositioning(next.setup, next.episode, next.state, turn.tavernTurn, recountDeps);
      await pause();
      if (judgement.kind === 'skip') {
        addSkip(skips, 'Расстановка', judgement.reason);
        continue;
      }
      if (judgement.kind === 'fine') continue;
      const { actual, field } = judgement;
      const fieldGain = field === null ? 0 : field.alternative.scorePct - field.played.scorePct;
      const fieldLine =
        field === null
          ? 'поля бордов на этом ходу мало — проверки «при любом сопернике» нет'
          : `${field.against}: ${field.played.scorePct.toFixed(1)} % → ${field.alternative.scorePct.toFixed(1)} % (${fieldGain >= 0 ? '+' : '−'}${Math.abs(fieldGain).toFixed(1)} п.п.)${field.distinguishable ? '' : ', в пределах шума'}`;
      // Заголовок «сильнее против поля» — только при том же пороге, что
      // у факта; иначе карточка попала в отчёт по фактическому сопернику
      // и обязана так и сказать (ревью: part57, ход 9 — +1.5 п.п. по полю).
      const fieldBacked =
        field !== null && field.distinguishable && fieldGain >= DEFAULT_RECOUNT_OPTIONS.factFieldGapPp;
      positionFindings.push({
        kind: judgement.kind,
        klass: 'positioning',
        turn: turn.turn,
        tavernTurn: turn.tavernTurn,
        time: turn.endTime.slice(0, 8),
        title: fieldBacked
          ? `Расстановка: другой порядок сильнее против поля хода на ${fieldGain.toFixed(1)} п.п.`
          : `Против этого соперника другой порядок давал ${actual.alternative.scorePct.toFixed(0)} % вместо ${actual.played.scorePct.toFixed(0)} %`,
        details: [
          `сыграно: ${boardLine(next.setup.playerBoard)}`,
          `лучше: ${boardLine(judgement.bestBoard)}`,
          fieldLine,
        ],
        impact: actual,
        impactNote: null,
        nextBattle: battleFact(next.episode),
        caveats: [
          ...judgement.reasons.map((r) => `Не факт: ${r}.`),
          ...(fieldBacked
            ? []
            : [
                field === null
                  ? 'Задним числом: борда этого соперника в таверне видно не было, а проверить порядок против поля хода не на чем — бордов мало.'
                  : 'Задним числом: борда этого соперника в таверне видно не было, а против поля хода такой порядок не лучше.',
              ]),
        ],
      });
    }
  }

  // ── предположения о плане ──
  const planFindings: Finding[] = [];
  const planTally = { compared: 0, same: 0, withinNoise: 0, playerStronger: 0, planStronger: 0 };
  if (options.plan !== false) {
    for (const turn of timeline.turns) {
      const start = starts.get(turn.turn);
      if (start === undefined) continue;
      if (turn.tavernTurn <= 1) {
        addSkip(skips, 'План против хода', 'первый ход таверны — бой один на один (D087)');
        continue;
      }
      say(`план против хода: ход таверны ${String(turn.tavernTurn)}`);
      const judgement = judgePlan(start, turn, cards, recountDeps, (steps) =>
        steps.map((s) => recommendationLine(s.recommendation, cards)),
      );
      await pause();
      if (judgement.kind === 'skip') {
        addSkip(skips, 'План против хода', judgement.reason);
        continue;
      }
      planTally.compared += 1;
      if (judgement.kind === 'same') planTally.same += 1;
      else if (judgement.kind === 'quiet') planTally.withinNoise += 1;
      else if (judgement.recount.alternative.scorePct < judgement.recount.played.scorePct) {
        planTally.playerStronger += 1;
      } else {
        planTally.planStronger += 1;
        const next = setupOf(turn);
        const finding = planFinding(turn, judgement, boardLine);
        planFindings.push({
          ...finding,
          nextBattle: battleFact(next?.episode),
          caveats:
            poolReason === null ? finding.caveats : [...finding.caveats, `Поле бордов не о той же игре: ${poolReason}.`],
        });
      }
    }
  }

  const all = [...priced, ...positionFindings, ...planFindings].sort(
    (a, b) => a.turn - b.turn || (a.time ?? '').localeCompare(b.time ?? ''),
  );
  const facts = all.filter((f) => f.kind === 'fact');
  const assumptions = all.filter((f) => f.kind === 'assumption');

  const turns: TurnRow[] = timeline.turns.map((turn) => ({
    turn: turn.turn,
    tavernTurn: turn.tavernTurn,
    tier: turn.end.techLevel,
    hp: effectiveHp(turn.end),
    goldTotal: turn.end.goldTotal,
    goldLeft: turn.end.gold,
    boardSize: (turn.beforeCombat ?? turn.end).board.length,
    actions: countActions(final, turn.turn),
    clicks: turn.clock.clicks,
    turnSeconds: turnSeconds(turn.clock),
    idleSeconds: idleBeforeEnd(turn.clock),
    lateAction: lateLastAction(turn),
    cutByTimer: cutByTimer(turn),
    battle: battleFact(episodes.get(turn.turn + 1)),
    marks: [...new Set(all.filter((f) => f.turn === turn.turn).map((f) => f.klass))],
  }));

  const hero = final.hero?.cardId ?? null;
  return {
    schema: REPORT_SCHEMA,
    generatedAt: options.generatedAt,
    source: { ref: options.ref, gameIndex: options.gameIndex },
    game: {
      heroCardId: hero,
      heroName: hero === null ? null : (cards.info(hero)?.name ?? hero),
      place: final.phase === 'gameOver' ? final.finalPlace : null,
      buildNumber: final.buildNumber,
      date: options.date ?? null,
      startedAt: timeline.firstTime?.slice(0, 8) ?? null,
      endedAt: timeline.lastTime?.slice(0, 8) ?? null,
      tavernTurns: timeline.turns.length,
      // Дамп переподключения тоже начинается с CREATE_GAME, поэтому
      // «неполная» — не по этой строке, а по первому ходу ленты, как
      // в импорте датасета (dataset/import.ts): партия, начатая не с хода 1,
      // — кусок после переподключения (ревью: part35 — 2 хода из 13).
      partial: !gameOver || (timeline.turns[0]?.turn ?? 1) !== 1,
      firstTavernTurn: timeline.turns[0]?.tavernTurn ?? null,
    },
    analysis: {
      appVersion: options.appVersion,
      simulatorVersion: options.simulatorVersion ?? null,
      fieldBuiltAt: deps.field?.builtAt ?? null,
      fieldPool: poolReason,
      fieldFitsGame: fieldFitsGame(recountDeps),
      sections: { positioning: options.positioning !== false, plan: options.plan !== false },
    },
    turns,
    facts,
    assumptions,
    notJudged: NOT_JUDGED,
    planTally,
    skipped: [...skips.values()],
    elapsedMs: Date.now() - started,
  };
}
