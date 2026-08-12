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
import { dirname } from 'node:path';

import type { PositionAdvice } from '../advisors/position/advisor.js';
import type { ResolvedOpponent } from '../advisors/position/opponent.js';
import type { Recommendation, TavernAdvice } from '../advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../data/cards.js';
import { LiveAdvisor } from '../live/advisor.js';
import { PositionWorker } from '../live/position/client.js';
import { replayLog } from '../live/replay.js';
import { LiveWatcher, type LiveNotice } from '../live/watcher.js';
import type { GameState, Minion } from '../state/types.js';
import { ensureLogSizeLimit, inspectClientConfig } from '../watcher/clientConfig.js';
import { DEFAULT_LOGS_ROOT } from '../watcher/logPaths.js';

const ACTION_LABEL: Readonly<Record<Recommendation['action'], string>> = {
  levelUp: 'ПОДНЯТЬ ТАВЕРНУ',
  buy: 'КУПИТЬ',
  sell: 'ПРОДАТЬ',
  reroll: 'ОБНОВИТЬ',
  freeze: 'ЗАМОРОЗИТЬ',
  pass: 'НИЧЕГО',
};

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

function shortName(m: Minion, cards: CardIndex): string {
  const info = cards.info(m.cardId);
  const marks = [
    m.golden ? 'зол' : '',
    m.taunt ? 'провок' : '',
    m.divineShield ? 'щит' : '',
    m.poisonous || m.venomous ? 'яд' : '',
    m.reborn ? 'перерожд' : '',
    m.windfury ? 'вихрь' : '',
  ].filter((x) => x !== '');

  return (
    `${info?.name ?? m.cardId} ${String(m.attack ?? '?')}/${String(m.health ?? '?')}` +
    (marks.length > 0 ? ` (${marks.join(',')})` : '')
  );
}

function heroHp(state: GameState): string {
  const hero = state.hero;
  if (hero === null) return '?';
  const hp = (hero.health ?? 0) - hero.damage;
  return hero.armor > 0 ? `${String(hp)}+${String(hero.armor)}` : String(hp);
}

function printSituation(state: GameState, advice: TavernAdvice | null, cards: CardIndex): void {
  // До выбора героя советовать нечего, а печатать пустую шапку — шум.
  if (state.hero === null) return;

  console.log(
    `\n══ ход ${String(state.turn)} · ${state.phase === 'tavern' ? 'таверна' : 'бой'}` +
      ` · тир ${String(state.techLevel)} · золото ${String(state.gold)}/${String(state.goldTotal)}` +
      ` · hp ${heroHp(state)}`,
  );

  if (state.board.length > 0) {
    console.log(
      `   борд:    ${state.board.map((m, i) => `${String(i + 1)}.${shortName(m, cards)}`).join('  ')}`,
    );
  }
  if (advice === null) return;

  if (state.shop.length > 0) {
    console.log(`   витрина: ${state.shop.map((m) => shortName(m, cards)).join('  |  ')}`);
  }

  for (const r of advice.recommendations.slice(0, 2)) {
    const what = r.minion === null ? '' : ` ${shortName(r.minion, cards)}`;
    const price = r.cost > 0 ? ` за ${String(r.cost)}` : '';
    const victim = r.sellFirst === null ? '' : `, продав ${shortName(r.sellFirst, cards)}`;
    console.log(`   ▸ ${ACTION_LABEL[r.action]}${what}${price}${victim} — ${r.reason}`);
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

  const best = advice.top[0];
  if (best === undefined) return;

  const against =
    opponent.source === 'lastSeen'
      ? `по борду ${String(opponent.staleTurns)} ходов давности`
      : 'по текущему бою';

  const odds = `${winPercent(advice.report.current.estimate).toFixed(0)}% побед`;
  const spent = `${against}, ${String(advice.elapsedMs)} мс`;

  if (!advice.improves) {
    console.log(`   расстановка: менять нечего (${odds}, ${spent})`);
  } else {
    console.log(
      `   расстановка: ${best.board.map((m) => shortName(m, cards)).join(' → ')}` +
        `  +${advice.gain.toFixed(1)} п.п. к ${odds} (${spent})`,
    );
  }

  // Порог показной, а не замеренный: за столько ходов противник успевает
  // дважды сходить в таверну, и картинка перестаёт что-либо значить. В обеих
  // фикстурах устаревание доходит до 17 ходов, и там счёт даёт 100% побед
  // против борда, которого давно нет.
  if (opponent.source === 'lastSeen' && opponent.staleTurns > 4) {
    console.log('                картинка противника устарела, полагаться на числа нельзя');
  }
}

/** Доля побед оценки, в процентах. */
function winPercent(estimate: { readonly sims: number; readonly won: number }): number {
  return estimate.sims === 0 ? 0 : (estimate.won / estimate.sims) * 100;
}

function printNotice(notice: LiveNotice): void {
  switch (notice.kind) {
    case 'noLog':
      console.log(
        `логов не нашлось в ${notice.logsRoot}\n` +
          'проверьте log.config и что клиент перезапускали после его правки',
      );
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

  let thinkingFor: GameState | null = null;

  const advisor = new LiveAdvisor(
    { cards, position },
    {
      onTavern: (advice, state) => {
        printSituation(state, advice, cards);
      },
      onThinking: (state) => {
        thinkingFor = state;
      },
      onPosition: (advice, opponent, state) => {
        if (thinkingFor === state) thinkingFor = null;
        printPosition(advice, opponent, cards);
      },
      onNoOpponent: (opponent) => {
        console.log(
          opponent.source === 'unseen'
            ? '   расстановка: следующего противника ещё не видели — считать не против кого'
            : '   расстановка: противник неизвестен',
        );
      },
      onError: (error) => {
        console.error(`советник расстановки: ${error.message}`);
      },
    },
    { search: searchOptions(args) },
  );

  if (args.replay !== null) {
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

  // Настройка предела размера логов проверяется при каждом запуске: файл лежит
  // в каталоге игры, и обновление Hearthstone его сносит.
  const installDir = dirname(args.logsRoot);
  const config = inspectClientConfig(installDir);
  if (!config.sufficient) {
    const fixed = ensureLogSizeLimit(installDir);
    console.log(
      fixed
        ? 'предел размера логов был мал — поправил, нужен перезапуск Hearthstone'
        : 'предел размера логов мал, и поправить не вышло: запустите с правами на каталог игры',
    );
  }

  const watcher = new LiveWatcher(
    {
      onUpdate: ({ state, catchingUp }) => {
        // На догоне советовать нечего: события уже сыграны. Состояние копится,
        // а советник просыпается на первом же свежем изменении.
        if (!catchingUp) advisor.update(state);
      },
      onNotice: printNotice,
    },
    { logsRoot: args.logsRoot },
  );

  const stop = (): void => {
    watcher.stop();
    advisor.reset();
    void position.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);

  watcher.start();
}

void main();
