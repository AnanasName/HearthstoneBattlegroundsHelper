import type { PositionAdvice } from '../advisors/position/advisor.js';
import type { PositionTarget, ResolvedOpponent } from '../advisors/position/opponent.js';
import type { TavernAdvice } from '../advisors/tavern/advisor.js';
import type { CardIndex } from '../data/cards.js';
import type { GameState } from '../state/types.js';
import {
  choiceLine,
  minionLabel,
  noOpponentReason,
  opponentStale,
  planLine,
  positionLine,
  recommendationLine,
  situationLine,
  trinketLine,
} from '../ui/format.js';

/**
 * Что показывает оверлей — простыми данными, без DOM и без Electron.
 *
 * Смысл разделения не в чистоте, а в проверяемости: окно поверх игры нечем
 * проверить тестом, а решения о том, что показывать, проверить нужно. Здесь
 * они все, и они же покрыты тестами; на долю Electron остаётся создание окна
 * и передача этой структуры в разметку.
 */

export type Tone = 'normal' | 'good' | 'warn' | 'muted';

export interface OverlayLine {
  readonly text: string;
  readonly tone: Tone;
}

export interface OverlayView {
  /** Есть ли что показывать вообще. */
  readonly active: boolean;
  readonly header: string;
  readonly board: readonly string[];
  readonly shop: readonly string[];
  /** Что делать: первые рекомендации по таверне. */
  readonly actions: readonly OverlayLine[];
  /** Расстановка: совет, причина молчания или отметка о счёте. */
  readonly position: OverlayLine | null;
}

export const EMPTY_VIEW: OverlayView = {
  active: false,
  header: 'жду партию',
  board: [],
  shop: [],
  actions: [],
  position: null,
};

/**
 * Сколько советов по таверне помещается, не превращая оверлей в простыню.
 *
 * Три, а не два: с появлением «разыграть» и подъёма-приоритета в топе
 * обычно сочетание разных действий, и обрезка до двух прятала бы покупку
 * за подъёмом и розыгрышем.
 */
const MAX_ACTIONS = 3;

export interface ViewInput {
  readonly state: GameState;
  readonly tavern: TavernAdvice | null;
  /** Идёт ли счёт расстановки прямо сейчас. */
  readonly thinking: boolean;
  readonly position:
    | { readonly kind: 'advice'; readonly advice: PositionAdvice; readonly target: PositionTarget }
    | { readonly kind: 'dropped' }
    | { readonly kind: 'noOpponent'; readonly opponent: ResolvedOpponent }
    | null;
}

export function buildView(input: ViewInput, cards: CardIndex): OverlayView {
  const { state } = input;
  if (state.hero === null) return EMPTY_VIEW;

  return {
    active: true,
    header: situationLine(state),
    board: state.board.map((m) => minionLabel(m, cards)),
    shop: state.shop.map((m) => minionLabel(m, cards)),
    actions: actionLines(input, cards),
    position: positionView(input, cards),
  };
}

function actionLines(input: ViewInput, cards: CardIndex): OverlayLine[] {
  // Открытый выбор тринкета вытесняет обычные советы: в игре это модальный
  // экран, и пока он открыт, игрок решает именно его.
  const trinkets = input.tavern?.trinkets ?? [];
  if (trinkets.length > 0) {
    return trinkets.map((t, i) => ({
      text: `ВЗЯТЬ? ${trinketLine(t)}`,
      tone: i === 0 && t.tribeMinions > 0 ? 'good' : 'normal',
    }));
  }

  // Открытый выбор карт — награда за тройку, раскопка, сокровища — такой же
  // модальный экран, и пока он открыт, игрок решает именно его. Показывается
  // всегда: спрятанный выбор выглядел так, будто помощник его не заметил
  // (part10, ход 17 — три сокровища-заклинания и советы про покупки поверх).
  const choice = input.tavern?.choice ?? [];
  if (choice.length > 0) {
    return choice.map((c, i) => ({
      text: `ВЫБРАТЬ? ${choiceLine(c)}`,
      tone: i === 0 && c.score !== null ? 'good' : 'normal',
    }));
  }

  // План на несколько розыгрышей заменяет отдельные строки «разыграть»:
  // игрок читает верхнюю строку, и она должна описывать весь ход.
  const recommendations = input.tavern?.recommendations ?? [];
  const plan = input.tavern?.playPlan ?? [];
  const lines: string[] = [];
  let planShown = false;
  for (const r of recommendations) {
    if (plan.length >= 2 && r.action === 'play') {
      if (!planShown) {
        lines.push(planLine(plan, cards));
        planShown = true;
      }
      continue;
    }
    lines.push(recommendationLine(r, cards));
  }

  return lines
    .slice(0, MAX_ACTIONS)
    .map((text, i) => ({ text, tone: i === 0 ? 'good' : 'normal' }));
}

function positionView(input: ViewInput, cards: CardIndex): OverlayLine | null {
  // Отметка о счёте идёт впереди прошлого ответа: показывать старый совет как
  // действующий, пока считается новый, — это ровно тот случай, когда игрок
  // делает ход по числам, которых уже нет.
  if (input.thinking) return { text: 'считаю расстановку…', tone: 'muted' };

  const position = input.position;
  if (position === null) return null;

  if (position.kind === 'dropped') {
    return { text: 'счёт брошен: положение изменилось', tone: 'muted' };
  }
  if (position.kind === 'noOpponent') {
    return { text: noOpponentReason(position.opponent), tone: 'muted' };
  }

  const text = positionLine(position.advice, position.target, cards);
  if (opponentStale(position.target)) {
    // Не «плохой совет», а совет по устаревшим данным: разница существенная,
    // и прятать её нельзя.
    return { text: `${text} — картинка устарела, верить нельзя`, tone: 'warn' };
  }
  return { text, tone: position.advice.improves ? 'good' : 'normal' };
}
