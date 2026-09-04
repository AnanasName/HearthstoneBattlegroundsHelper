import { fileURLToPath } from 'node:url';

import { BrowserWindow, globalShortcut, screen } from 'electron';

import { spendPlan } from '../advisors/tavern/spend.js';
import { loadCardIndex } from '../data/cards.js';
import { DATASET_DIR, DatasetRecorder } from '../dataset/recorder.js';
import { PositionWorker } from '../live/position/client.js';
import { startLiveSession, type LiveSession } from '../live/session.js';
import type { LiveNotice } from '../live/watcher.js';
import type { GameState } from '../state/types.js';
import { waitingForLogText } from '../ui/setup.js';
import { buildView, EMPTY_VIEW, type OverlayView, type ViewInput } from './view.js';

/**
 * Окно оверлея поверх игры.
 *
 * Здесь только окно и передача готового вида в разметку: что показывать,
 * решает `view.ts`, а когда считать — `live/advisor.ts`. Оба проверены
 * тестами, окно проверить нечем. Жизненным циклом приложения (трей,
 * выход, сборщик логов) заведует `app/main.ts`: оверлей — одна из его
 * функций, включаемая и выключаемая на ходу.
 *
 * ## Свойства окна и почему именно такие
 *
 * - **прозрачное и без рамки** — поверх игры не должно быть ничего лишнего;
 * - **сквозное для мыши** (`setIgnoreMouseEvents`) — иначе оверлей крал бы
 *   клики, а в Battlegrounds кликают по всему экрану;
 * - **не в панели задач и не забирает фокус** — переключение фокуса
 *   в полноэкранной игре сворачивает её.
 *
 * Оговорка, которую не обойти: поверх ИСКЛЮЧИТЕЛЬНОГО полноэкранного режима
 * Windows не показывает ничего. Игру надо ставить в оконный без рамки —
 * это стандартное требование ко всем оверлеям, а не наше ограничение.
 */

/*
 * Размеров окна здесь больше нет: оно во весь экран, а панель советов стала
 * блоком внутри него и живёт со своей геометрией в разметке.
 *
 * Прежний предел высоты (680 против 520, замер: худший кадр 592 пикселя)
 * перестал быть пределом сам собой — на весь экран места больше. Порядок
 * узлов в разметке при этом остаётся выстроенным по важности: обрезка снизу
 * молчалива на любом экране, и терять она обязана темп, а не план.
 */

/**
 * Как спрятать оверлей.
 *
 * Окно намеренно без рамки, без кнопок и не принимает фокус — закрыть его
 * мышью нельзя по построению. Терминал не всегда под рукой: помощник
 * запускают и ярлыком. Поэтому горячая клавиша, общесистемная — окно
 * ведь фокуса не получает. Клавиша выключает ОВЕРЛЕЙ, а не приложение:
 * сборщик логов в трее продолжает работать.
 */
export const HIDE_SHORTCUT = 'Control+Shift+Q';

export interface OverlayOptions {
  readonly logsRoot: string;
  /** Что показать первой строкой до первого совета — например, проблему настройки. */
  readonly initialHeader: string | null;
  /** Игрок нажал клавишу — оверлей просит себя выключить. */
  readonly onHideRequested: () => void;
}

export interface OverlayHandle {
  stop: () => Promise<void>;
}

/** Соотношение сторон экрана, на котором лежит оверлей. */
function aspectOfDisplay(): number {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  return height > 0 ? width / height : 16 / 9;
}

function createWindow(getLastView: () => OverlayView): BrowserWindow {
  // Во весь экран, а не панелью в углу: метки рисуются поверх настоящих карт,
  // и окно обязано накрывать стол целиком. Берётся `bounds`, а не `workArea`:
  // игра идёт в окне без рамки на весь экран и панель задач собой закрывает,
  // а `workArea` панель вычитает — метки уехали бы вверх на её высоту.
  const area = screen.getPrimaryDisplay().bounds;

  const created = new BrowserWindow({
    width: area.width,
    height: area.height,
    x: area.x,
    y: area.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: fileURLToPath(new URL('preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Поверх полноэкранных окон, а не только поверх обычных.
  created.setAlwaysOnTop(true, 'screen-saver');
  created.setVisibleOnAllWorkspaces(true);
  // forward: события мыши всё равно доходят до игры, а окно их не перехватывает.
  created.setIgnoreMouseEvents(true, { forward: true });

  // Разметка грузится дольше, чем поднимается живой цикл, а сообщения,
  // отправленные до её готовности, пропадают молча. Поэтому последний вид
  // хранится и отправляется заново, когда окно готово.
  created.webContents.on('did-finish-load', () => {
    created.webContents.send('overlay:view', getLastView());
  });

  // Путь абсолютный, и это не придирка: относительный `loadFile` считается
  // не от рабочего каталога, а от каталога точки входа (`app.getAppPath()`),
  // и разметка искалась в dist/overlay/src/overlay. Поэтому она кладётся
  // в сборку рядом с main.js — см. npm run build.
  void created.loadFile(fileURLToPath(new URL('index.html', import.meta.url)));
  return created;
}

/**
 * Что из событий слежения показать в окне.
 *
 * `null` означает «оставить как есть». Это не мелочь: заглушка вместо
 * собранного состояния стирает борд и советы, а состояние вернётся только
 * следующим обновлением. О начале партии и о догоне окну знать незачем —
 * оба и так видны по тому, что в нём появляется.
 */
function describeNotice(notice: LiveNotice): OverlayView | null {
  switch (notice.kind) {
    case 'noSessions':
      return { ...EMPTY_VIEW, header: `логов не нашлось в ${notice.logsRoot}` };
    case 'noPowerLog':
      return { ...EMPTY_VIEW, header: waitingForLogText(notice.sessionDir) };
    case 'watching':
      return { ...EMPTY_VIEW, header: 'жду партию' };
    case 'switched':
      return { ...EMPTY_VIEW, header: 'клиент перезапущен, слежу за новым логом' };
    case 'restarted':
      return { ...EMPTY_VIEW, header: 'лог обрезан, собираю состояние заново' };
    case 'newGame':
    case 'caughtUp':
      return null;
  }
}

export function startOverlay(options: OverlayOptions): OverlayHandle {
  let lastView: OverlayView = EMPTY_VIEW;
  let window: BrowserWindow | null = null;

  const send = (view: OverlayView): void => {
    lastView = view;
    if (window !== null && !window.isDestroyed()) window.webContents.send('overlay:view', view);
  };

  window = createWindow(() => lastView);
  if (options.initialHeader !== null) send({ ...EMPTY_VIEW, header: options.initialHeader });

  const cards = loadCardIndex();
  const worker = new PositionWorker();

  let latest: GameState | null = null;
  let tavern: ViewInput['tavern'] = null;
  let thinking = false;
  let last: ViewInput['position'] = null;
  let buyCheck: ViewInput['buyCheck'] = null;
  // План трат считается там же, где строится вид: он всего лишь цепочка тех
  // же правил на гипотетических состояниях, симулятор ему не нужен. Правила
  // умолчальные — те же, на которых считает живой советник.
  let plan: ViewInput['spendPlan'] = null;
  // Предупреждение продукта держится до конца партии: оно про данные,
  // а не про положение дел, и гаснуть с новым советом не должно.
  let warning: string | null = null;

  const show = (): void => {
    if (latest === null) return;
    send(
      buildView(
        {
          state: latest,
          tavern,
          thinking,
          position: last,
          buyCheck,
          warning,
          spendPlan: plan,
          // Окно накрывает экран целиком, поэтому его соотношение сторон
          // и есть игровое: по нему метки переводятся из долей высоты,
          // которыми замерена раскладка, в доли ширины.
          aspect: aspectOfDisplay(),
        },
        cards,
      ),
    );
  };

  const session: LiveSession = startLiveSession(
    {
      cards,
      position: worker,
      buys: worker,
      dataset: new DatasetRecorder({ dir: DATASET_DIR }),
    },
    {
      onFreshness: (text) => {
        warning = text;
        show();
      },
      onTavern: (advice, state) => {
        latest = state;
        tavern = advice;
        plan = advice === null ? null : spendPlan(state, { cards });
        // Новое положение — прошлый совет по расстановке к нему не относится.
        last = null;
        thinking = false;
        // Досчёт покупок тоже про прошлое положение: строка гасится
        // до прихода свежего результата.
        buyCheck = null;
        show();
      },
      onBuyCheck: (result, target) => {
        // Брошенный досчёт ничего не меняет: строка уже погашена onTavern.
        if (result !== null) {
          buyCheck = { result, target };
          show();
        }
      },
      onThinking: () => {
        thinking = true;
        show();
      },
      onPosition: (advice, target) => {
        thinking = false;
        last = advice === null ? { kind: 'dropped' } : { kind: 'advice', advice, target };
        show();
      },
      onNoOpponent: (opponent) => {
        thinking = false;
        last = { kind: 'noOpponent', opponent };
        show();
      },
      onError: (error) => {
        // В окно, а не в консоль: у GUI-сборки Electron на Windows стандартный
        // вывод к терминалу не подключён вовсе, и console.error никто
        // не увидит — ошибка выглядела бы как молчание советника.
        thinking = false;
        // Борд, витрина и прошлые советы сбой переживают — это описание
        // положения, оно не портится от того, что счёт упал. План и темп
        // гасятся: это прескриптивные блоки, и «купи, продай, подними»,
        // пережившее сбой, — ровно тот случай, ради которого отметка о счёте
        // идёт впереди прошлого ответа.
        send({ ...lastView, plan: null, tempo: null, header: `сбой советника: ${error.message}` });
      },
      onNotice: (notice) => {
        // Новая партия — предупреждение прошлой гаснет: оно пересчитается.
        if (notice.kind === 'newGame') warning = null;
        const view = describeNotice(notice);
        if (view !== null) send(view);
      },
    },
    { watcher: { logsRoot: options.logsRoot } },
  );

  globalShortcut.register(HIDE_SHORTCUT, () => {
    options.onHideRequested();
  });

  return {
    stop: async () => {
      globalShortcut.unregister(HIDE_SHORTCUT);
      session.stop();
      await worker.close();
      if (window !== null && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
