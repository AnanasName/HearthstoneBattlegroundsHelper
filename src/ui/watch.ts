/**
 * Живой режим в терминале.
 *
 *   npm run watch                                следить за идущей игрой
 *   npm run watch -- --replay data/fixtures/part3/game.log
 *   npm run watch -- --replay <лог> --speed 20 --budget 1200
 *   npm run watch -- --logs-root "D:\Games\Hearthstone\Logs"
 *
 * Это и режим отладки навсегда, и то, поверх чего рисует оверлей: советники,
 * порядок вызовов и отмена устаревшего счёта — здесь, а не в интерфейсе.
 *
 * Проигрывание фикстуры (`--replay`) идёт через тот же путь, что и живая игра,
 * и нужно ровно потому, что живой режим иначе нечем показать без Hearthstone
 * под рукой.
 */
import { readFileSync } from 'node:fs';

import type { PositionAdvice } from '../advisors/position/advisor.js';
import type { ResolvedOpponent } from '../advisors/position/opponent.js';
import type { TavernAdvice } from '../advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../data/cards.js';
import { LiveAdvisor, type LiveAdvisorHandlers } from '../live/advisor.js';
import { PositionWorker } from '../live/position/client.js';
import { replayLog } from '../live/replay.js';
import { startLiveSession } from '../live/session.js';
import type { LiveNotice } from '../live/watcher.js';
import type { GameState } from '../state/types.js';
import {
  minionLabel,
  noOpponentReason,
  opponentStale,
  positionLine,
  recommendationLine,
  situationLine,
} from './format.js';
import { DEFAULT_LOGS_ROOT } from '../watcher/logPaths.js';
import { checkGameSetup, waitingForLogText } from './setup.js';

interface Args {
  readonly logsRoot: string;
  readonly replay: string | null;
  readonly speed: number;
  readonly budgetMs: number | null;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const number = (raw: string | undefined, fallback: number | null): number | null => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  return {
    logsRoot: get('logs-root') ?? DEFAULT_LOGS_ROOT,
    replay: get('replay') ?? null,
    speed: number(get('speed'), 20) ?? 20,
    budgetMs: number(get('budget'), null),
  };
}

/**
 * Бюджет счёта расстановки.
 *
 * В живой игре фаза таверны идёт около полуминуты, и умолчания поиска (около
 * восьми секунд) в неё укладываются с запасом. При проигрывании записи фаза
 * сжимается во столько же раз, во сколько ускорено время, и счёт перестаёт
 * успевать — не потому, что советник плох, а потому, что ему отвели секунду
 * вместо тридцати. Отсюда `--budget`.
 */
function searchOptions(args: Args): { budgetMs?: number; screenBudgetMs?: number } {
  if (args.budgetMs === null) return {};
  return { budgetMs: args.budgetMs, screenBudgetMs: args.budgetMs / 3 };
}

function printSituation(state: GameState, advice: TavernAdvice | null, cards: CardIndex): void {
  // До выбора героя советовать нечего, а печатать пустую шапку — шум.
  if (state.hero === null) return;

  console.log(`\n══ ${situationLine(state)}`);

  if (state.board.length > 0) {
    console.log(
      `   борд:    ${state.board.map((m, i) => `${String(i + 1)}.${minionLabel(m, cards)}`).join('  ')}`,
    );
  }
  if (advice === null) return;

  if (state.shop.length > 0) {
    console.log(`   витрина: ${state.shop.map((m) => minionLabel(m, cards)).join('  |  ')}`);
  }

  for (const r of advice.recommendations.slice(0, 2)) {
    console.log(`   ▸ ${recommendationLine(r, cards)} — ${r.reason}`);
  }
}

function printPosition(
  advice: PositionAdvice | null,
  opponent: ResolvedOpponent,
  cards: CardIndex,
): void {
  if (advice === null) {
    console.log('   расстановка: счёт брошен, положение изменилось');
    return;
  }

  console.log(`   расстановка: ${positionLine(advice, opponent, cards)}`);

  if (opponentStale(opponent)) {
    console.log('                картинка противника устарела, полагаться на числа нельзя');
  }
}

function printNotice(notice: LiveNotice): void {
  switch (notice.kind) {
    case 'noSessions':
      console.log(
        `папок с логами не нашлось в ${notice.logsRoot}\n` +
          'проверьте путь установки игры: --logs-root <путь>',
      );
      return;
    case 'noPowerLog':
      console.log(waitingForLogText(notice.sessionDir));
      return;
    case 'watching':
      console.log(`слежу за ${notice.path}`);
      return;
    case 'switched':
      console.log(`\nклиент перезапущен, перехожу на ${notice.path}`);
      return;
    case 'restarted':
      console.log('\nлог обрезан, собираю состояние заново');
      return;
    case 'caughtUp':
      console.log(
        `догнал: ${(notice.bytes / 1024 / 1024).toFixed(1)} МБ,` +
          ` ${notice.events.toLocaleString('ru-RU')} событий за ${String(notice.ms)} мс`,
      );
      return;
    case 'newGame':
      console.log(`\n═══ партия ${String(notice.id)}${notice.player === null ? '' : `, ${notice.player}`}`);
      return;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const cards = loadCardIndex();
  const position = new PositionWorker();
  const loadMs = await position.ready();
  console.log(`справочник: ${cards.size.toLocaleString('ru-RU')} карт; воркер готов за ${String(loadMs)} мс`);

  const handlers: LiveAdvisorHandlers = {
    onTavern: (advice, state) => {
      printSituation(state, advice, cards);
    },
    onPosition: (advice, opponent) => {
      printPosition(advice, opponent, cards);
    },
    onNoOpponent: (opponent) => {
      console.log(`   расстановка: ${noOpponentReason(opponent)}`);
    },
    onError: (error) => {
      console.error(`советник расстановки: ${error.message}`);
    },
  };

  if (args.replay !== null) {
    const advisor = new LiveAdvisor({ cards, position }, handlers, {
      search: searchOptions(args),
    });
    console.log(`проигрываю ${args.replay} со скоростью ×${String(args.speed)}`);
    await replayLog(
      readFileSync(args.replay, 'utf8'),
      {
        onUpdate: (feed) => {
          advisor.update(feed.snapshot());
        },
        onDone: (feed) => {
          const state = feed.snapshot();
          console.log(
            `\nконец записи: ход ${String(state?.turn ?? 0)},` +
              ` место ${state?.finalPlace === null ? '—' : String(state?.finalPlace)}`,
          );
        },
      },
      { speed: args.speed },
    );
    await position.close();
    return;
  }

  // Настройки игры проверяются при каждом запуске: они лежат вне нашего
  // каталога, и обновление Hearthstone их не бережёт.
  const problem = checkGameSetup(args.logsRoot);
  if (problem !== null) console.log(problem.text);

  const session = startLiveSession({ cards, position }, { ...handlers, onNotice: printNotice }, {
    watcher: { logsRoot: args.logsRoot },
    advisor: { search: searchOptions(args) },
  });

  process.on('SIGINT', () => {
    session.stop();
    void position.close().then(() => {
      process.exit(0);
    });
  });
}

void main();
