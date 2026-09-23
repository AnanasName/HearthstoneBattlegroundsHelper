import electron = require('electron');

/**
 * Мост между главным процессом и разметкой.
 *
 * Главный канал один и в одну сторону: показывать готовый вид. Ни доступа
 * к файлам, ни к Node — оверлей ничего не решает и решать не должен.
 * Обратно разметка говорит ровно одно — стоит ли курсор на кнопке
 * раздела (`setInteractive`), — и это не решение об игре, а геометрия
 * её собственных кнопок.
 *
 * Файл на CommonJS (`.cts`) намеренно: preload грузится раньше всего
 * остального и модульной системы проекта не разделяет. Отсюда и форма
 * импорта — под `verbatimModuleSyntax` в CommonJS-файле пишут `import =`.
 */
electron.contextBridge.exposeInMainWorld('overlay', {
  onView: (handler: (view: unknown) => void): void => {
    electron.ipcRenderer.on('overlay:view', (_event: unknown, view: unknown) => {
      handler(view);
    });
  },
  /**
   * Второй канал — где на окне лежит ЭКРАН игры (пиксели CSS).
   *
   * Он понадобился ровно потому, что окно и экран совпадают не всегда:
   * Windows ужимает окно до рабочей области, а доли меток считаются
   * от стола, то есть от экрана целиком (part46, `layout.ts`, `stageBox`).
   * Разметке и тут решать нечего — приходит готовый прямоугольник.
   */
  onStage: (handler: (box: unknown) => void): void => {
    electron.ipcRenderer.on('overlay:stage', (_event: unknown, box: unknown) => {
      handler(box);
    });
  },
  /**
   * Принимать ли окну щелчки: `true` — курсор на кнопке свёрнутого
   * раздела, `false` — где угодно ещё (D285).
   *
   * Окно во весь экран и в остальное время сквозное: щелчки уходят в игру.
   * Прозрачность для мыши переключает главный процесс, а разметка только
   * сообщает, где курсор; наружу уходит строго булево значение.
   */
  setInteractive: (interactive: boolean): void => {
    electron.ipcRenderer.send('overlay:interactive', interactive === true);
  },
});
