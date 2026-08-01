# Power.log — что подтверждено фактически

Рабочие заметки по формату. **Правило: сюда попадает только то, что видно в реальном логе,
со ссылкой на источник.** Гипотезы живут в отдельном разделе и не используются в коде,
пока не подтверждены.

Источник для всего ниже, если не указано иное:
`Logs/Hearthstone_2026_08_01_22_30_56/Power.log` — выбор героя + один ход BG,
клиент русский, 2026-08-01, 14 561 строка / 1.3 МБ.

## Окружение

- Установка игры: `C:\Program Files (x86)\Hearthstone` (найдено через
  `HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone` → `InstallLocation`).
- Логи: `<install>/Logs/Hearthstone_YYYY_MM_DD_HH_MM_SS/Power.log`.
  **На каждый запуск клиента создаётся новая папка**, старый файл не дописывается.
  Watcher обязан находить свежайшую сессию и переключаться на новую, если она появилась.
- Включение: `%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`, секция `[Power]`
  с `FilePrinting=true` и `Verbose=true`. Требуется полный перезапуск клиента.
- Параллельно пишутся `Zone.log` и `LoadingScreen.log` (включены с запасом, нужность не проверена).

## Чтение файла

- **Кодировка UTF-8 без BOM.** Первые байты — сразу `44 20 32 32` (`D 22`), сигнатуры нет.
- **Переводы строк CRLF** (`0D 0A`).
- ⚠️ Читать строго как UTF-8. При чтении в системной кодировке Windows парсер не падает,
  а тихо портит кириллицу: `PlayerName=Клеопатра` превращается в `РљР»РµРѕРїР°С‚СЂР°`.
- ⚠️ **Файл держит запущенная игра.** Открытие без разделяемого доступа падает с
  «The process cannot access the file … used by another process».
  Нужен режим, разрешающий одновременную запись (FileShare.ReadWrite).

## Строка

```
D 22:32:25.3752664 GameState.DebugPrintPower() -     GameEntity EntityID=7
│ │               │                              │   └─ содержимое, вложенность отступами
│ │               │                              └───── разделитель " - "
│ │               └──────────────────────────────────── канал.метод()
│ └──────────────────────────────────────────────────── время HH:MM:SS.fffffff (7 знаков)
└────────────────────────────────────────────────────── уровень (наблюдался только D)
```

Каналы и их доля в файле:

| строк | канал |
|------:|-------|
| 6564 | `GameState.DebugPrintPower()` |
| 5913 | `PowerTaskList.DebugPrintPower()` |
| 796 | `PowerTaskList.DebugDump()` |
| 380 | `PowerProcessor.PrepareHistoryForCurrentTaskList()` |
| 379 | `PowerProcessor.EndCurrentTaskList()` |
| 325 | `GameState.DebugPrintOptions()` |
| 140 | `GameState.DebugPrintPowerList()` |
| 31 | `PowerProcessor.DoTaskListForCard()` |
| 11 | `GameState.DebugPrintEntityChoices()` |
| 6 | `GameState.DebugPrintGame()` |
| 5 | `GameState.SendOption()` |
| 4 | `GameState.DebugPrintEntitiesChosen()` |
| 4 | `GameState.SendChoices()` |
| 2 | `ChoiceCardMgr.WaitThenShowChoices()` |
| 1 | `ChoiceCardMgr.WaitThenHideChoicesFromPacket()` |

`GameState.*` и `PowerTaskList.*` дублируют одни и те же события — выбрать один канал
как источник истины, иначе теги применятся дважды. Какой именно — **не решено**.

## Конструкции внутри блоков

Наблюдались: `TAG_CHANGE` (5906), `BLOCK_START`/`BLOCK_END` (по 456), `FULL_ENTITY` (294),
`SHOW_ENTITY` (78), `HIDE_ENTITY` (62), `META_DATA` (84), `SUB_SPELL_START`/`SUB_SPELL_END` (по 26).

Дескриптор сущности:

```
[entityName=Выживший красный дракон id=408 zone=PLAY zonePos=1 cardId=BG35_814 player=11]
```

- `entityName` **локализован** — опираться нельзя, только `cardId`.
- `cardId` присутствует прямо в дескрипторе.

Зоны, встреченные в `tag=ZONE value=`: `PLAY`, `HAND`, `SETASIDE`, `GRAVEYARD`, `REMOVEDFROMGAME`.
**Отдельной зоны под магазин таверны нет.**

## Игроки

```
GameState.DebugPrintGame() - PlayerID=3, PlayerName=AngryMem#2886
GameState.DebugPrintGame() - PlayerID=11, PlayerName=Клеопатра
```

Партия BG моделируется как игра двух «игроков». `PlayerID=3` — реальный аккаунт (BattleTag).

## BG-специфичные теги

Именованные теги, встреченные в этом логе:

- Тир: `PLAYER_TECH_LEVEL`, `BACON_MAX_PLAYER_TECH_LEVEL`, `TECH_LEVEL` (тир миньона)
- Золото: `RESOURCES`
- Тройки: `BACON_TRIPLE_UPGRADE_MINION_ID`
- Тринкеты: `BACON_TRINKETS_ACTIVE`, `BACON_TURNS_LEFT_TO_DISCOVER_TRINKET`,
  `BACON_IS_POTENTIAL_TRINKET`, `BACON_IS_MAGIC_ITEM_DISCOVER`
- Племена в пуле: `BACON_SUBSET_DEMON`, `BACON_SUBSET_BEAST`, `BACON_SUBSET_ELEMENTALS`, `BACON_SUBSET_DRAGON`
- Прочее: `IS_BACON_POOL_MINION`, `BACON_ACTION_CARD`, `BACON_HEROPOWER_BASE_HERO_ID`,
  `BACON_COMPANION_ID`, `BACON_HERO_CAN_BE_DRAFTED`, `NUM_TURNS_IN_PLAY`, `NUM_TURNS_IN_HAND`

На `GameEntity` в `CREATE_GAME`: `GAME_SEED`, `BACON_GLOBAL_ANOMALY_DBID=119094`,
`BACON_BARTENDER_CARD_ID=57110`, `BACON_TRINKETS_ACTIVE=1`, `BACON_DUOS_PUNISH_LEAVERS=1`,
`BACON_MULLIGAN_HERO_REROLL_ACTIVE=1`.

⚠️ Аномалия задана через **dbId (119094), а не cardId** — нужен маппинг dbId→cardId из HearthstoneJSON.

Часть тегов приходит без имени, голым числом: `tag=937 value=3459`, `tag=1488 value=1`,
`tag=4730 value=5`. Парсер обязан переживать неизвестные числовые теги, а не падать на них.

## Известные cardId

- Слоты тринкетов: `BG30_Trinket_1st`, `BG30_Trinket_2nd`
- Призрак: `TB_BaconShop_HERO_KelThuzad` — лежит в `SETASIDE` заранее, ещё до боёв
- Кнопка реролла: `TB_BaconShop_8p_Reroll_Button`
- Кнопка заморозки: `TB_BaconShopLockAll_Button`
- Сила героя (пример): `TB_BaconShop_HP_103`
- Миньон (пример): `BG35_814`

## DebugPrintOptions

Перечисляет все доступные игроку действия с полными дескрипторами:

```
option 0 type=END_TURN mainEntity= error=INVALID errorParam=
option 1 type=POWER mainEntity=[… cardId=TB_BaconShop_HP_103 player=3] error=NONE
option 2 type=POWER mainEntity=[… cardId=TB_BaconShop_8p_Reroll_Button player=3] error=NONE
option 3 type=POWER mainEntity=[… cardId=TB_BaconShopLockAll_Button player=3] error=NONE
option 4 type=POWER mainEntity=[… id=408 zonePos=1 cardId=BG35_814 player=11] error=NONE
```

Потенциально это самый прямой способ узнать содержимое магазина и что сейчас доступно.

## Шум, который надо игнорировать

- `PowerProcessor.DoTaskListForCard() - unhandled BlockType PLAY for sourceEntity […]` —
  это клиент не нашёл анимацию, не ошибка парсинга.

## Гипотезы — НЕ использовать в коде до подтверждения

1. **Магазин отличается от своего борда по `player=`.** Наблюдение: кнопки таверны, сила героя
   и слоты тринкетов идут с `player=3`, а покупаемый миньон магазина — с `player=11`.
   Проверять на диагностической партии, где известно, что было на экране.
2. Кто такой `PlayerID=11 / Клеопатра` — второй слот, магазин, текущий оппонент или что-то ещё.
3. Какой из каналов (`GameState` vs `PowerTaskList`) брать как источник истины.

## Пробелы — данных пока нет

Ждут полной партии и диагностической партии:

- Переключение фаз таверна ↔ бой; момент «борд зафиксирован».
- Логируется ли перестановка миньонов мышкой, и как индексируется `zonePos`.
- Как выглядит бой: пошагово или только итог.
- Борд оппонента: когда виден, с какими статами.
- Известен ли следующий оппонент заранее.
- Энчанты: лежат ли в логе итоговые atk/hp или базовые + бафы.
- Золотые миньоны: отдельный cardId, тег, или и то и другое.
- Конец партии и финальное место.
- Граница между партиями внутри одного файла.
- Поведение при реконнекте.
