import type { CardIndex } from '../data/cards.js';
import type { GameState } from '../state/types.js';

/**
 * Предупреждение «снапшот карт отстал от патча».
 *
 * Незнакомая карта — это не «чуть хуже совет», а совет вслепую: замер 13.08
 * показал 41 незнакомую карту из 216 на партии нового билда со старым
 * снапшотом. Обновление снапшотов — ручная команда по правилу «никакой сети
 * в рантайме», поэтому приложение обязано хотя бы сказать вслух, что пора
 * её запустить, — как `ensureLogSizeLimit` чинит настройки игры.
 *
 * Сигнал — уникальные незнакомые карты в зонах, которые советник реально
 * оценивает: борд, рука, витрина, заклинания. Фон замерен на всех тринадцати
 * партиях текущего патча со свежим снапшотом: ровно ноль. Порог 3 — выше
 * любого мыслимого шума и на порядок ниже реального отставания.
 */

/** Уникальных незнакомых карт, после которых говорится вслух. */
export const STALE_CARDS_THRESHOLD = 3;

export class CardsFreshness {
  readonly #cards: CardIndex;
  readonly #unknown = new Set<string>();
  #warned = false;

  constructor(cards: CardIndex) {
    this.#cards = cards;
  }

  /** Новая партия: незнакомые копятся в пределах одной. */
  reset(): void {
    this.#unknown.clear();
    this.#warned = false;
  }

  /**
   * Проверить состояние. Предупреждение возвращается ОДИН раз за партию,
   * когда порог перейдён; дальше — null, чтобы не заспамить интерфейс.
   */
  update(state: GameState): string | null {
    for (const m of [...state.board, ...state.hand, ...state.shop]) {
      if (this.#cards.info(m.cardId) === null) this.#unknown.add(m.cardId);
    }
    for (const s of [...state.handSpells, ...state.shopSpells]) {
      if (this.#cards.info(s.cardId) === null) this.#unknown.add(s.cardId);
    }

    if (this.#warned || this.#unknown.size < STALE_CARDS_THRESHOLD) return null;
    this.#warned = true;

    const build = state.buildNumber === null ? '' : ` (билд ${String(state.buildNumber)})`;
    return (
      `снапшот карт отстал от патча${build}: ${String(this.#unknown.size)} незнакомых карт — ` +
      'советы по ним слепые; выполните npm run update:cards и npm run update:bgstats'
    );
  }
}
