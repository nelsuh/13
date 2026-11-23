// ── Mongolian Poker (Big-Two style) ──────────────────────
// 2-4 players, 13 cards each from a standard 52-card deck (2p uses 26 random
// cards, 3p uses 39 — each player still gets 13). Be the first to empty your
// hand to win the round; everyone else is docked points for the cards they're
// left holding.
//
// Single-card strength high→low: 2 A K Q J 10 9 8 7 6 5 4 3.
// Suit strength high→low: ♠ ♥ ♣ ♦ (tiebreak only).
// Combos: single, pair, triple, four, and 5-card hands — straight, flush,
// full house (3+2), four+1, straight flush. 5-card category order (low→high):
//   straight < flush < full house < four+1 < straight flush.
// Straights run 2-3-4-5-6 (lowest) up to 10-J-Q-K-A (highest); no wrap, the 2
// is the low end of a straight only. You must follow with a bigger combo of
// the SAME size, or pass.
//
// Auto-win: being dealt all 13 ranks (a 3→A straight plus a 2).
//
// Modes: local = you (seat 0) + bots; online = humans via a shared deal seed
// and a turn-log of moves (deterministic engine on every client). A solo launch
// can be promoted into a live room mid-session (Usion.game.onRoomAssigned).
// UI is bilingual (mn/en) via the STR table + Usion.getLanguage().

// ── Card model ───────────────────────────────────────────
// rank: 3..15 where 11=J 12=Q 13=K 14=A 15=2 ; suit id: 0♠ 1♣ 2♦ 3♥
const SUITS = ["♠", "♣", "♦", "♥"];
const SUIT_RED = [false, false, true, true];
// Suit strength high→low: ♠ > ♥ > ♣ > ♦. Indexed by suit id.
const SUIT_RANK = [3, 1, 0, 2];
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" };
const PLAYER_COLORS = ["#2ed573", "#ff4757", "#1e90ff", "#ffa502"];
const HAND_OVER_SECONDS = 5;
const TURN_SECONDS = 90;   // each player gets 1:30 to act; on expiry they auto-pass (auto-lead if leading)
const TOUR_TURN_SECONDS = 60;   // …1:00 at a tournament table (2026-11-23), so a whole stage keeps moving
// Every client at a table agrees on it: all of them are at the same tournament
// table (tourCtx) or none is. A spectator of a tournament table shows the same.
// (tourWatching is a `let` further down: read before the script got there → plain games.)
function turnSeconds() {
  try { return tourCtx || tourWatching ? TOUR_TURN_SECONDS : TURN_SECONDS; } catch (_) { return TURN_SECONDS; }
}

// ── The two online modes ─────────────────────────────────
// A room is run one of two ways, decided entirely by HOW THE GAME WAS LAUNCHED:
//
//   CHAT INVITE (`mode: 'multiplayer'`) → the classic WAITING ROOM. The invited
//   players gather, each toggles READY, the host presses Start, and the seat
//   order is frozen for the whole match. Everyone who was invited plays; nobody
//   else can take a seat. This is the flow a group chat expects.
//
//   NO INVITE, "just play" (`mode: 'single'` from Explore / the GameTok feed) →
//   an OPEN ROOM. There is no lobby: the table always seats 4, deals itself
//   immediately with bots in every empty seat, and anyone who wanders in takes
//   over the bot carrying the FEWEST penalty points — inheriting that seat's
//   score and the cards it is holding, mid-round. A player who leaves hands the
//   seat (and its score) back to a bot, so the room outlives its players.
//
// `openTable` below is that switch. It is carried on the deal and on every
// checkpoint, so the ROOM decides the mode, not the client — a client can never
// end up running different rules from the table it is sitting at.
const OPEN_SEATS = 4;           // an open table is always 4 seats wide
const OPEN_START_MS = 600;      // let presence settle before the first deal
const BOT_MOVE_MS = 900;        // how long an online bot "thinks" before its move goes out
const OPEN_RESTART_MS = 8000;   // the champion screen auto-restarts an open table
const OPEN_LOSE_AT = 20;        // open tables run the 4-player road to 20 points
const SEAT_RETRY_MS = 3000;     // don't re-send a seat claim faster than this
const SEAT_STAGGER_MS = 2500;   // per authority rank, so a sleeping seat 0 can't lock newcomers out
const OPEN_REVIVE_MS = 20000;   // a room that owes us a seat and has gone silent is dead — reopen it
const OPEN_ABANDONED_MS = 8000; // alone in a MID-MATCH room full of ghosts → clear it and start over
const OPEN_EMPTY_MS = 2000;     // …but an empty room with only a stale log is ours almost immediately
const OPEN_PROBE_MS = 1500;     // how long we look at one public table before trying the next
const OPEN_STUCK_MS = 25000;    // never leave anybody staring at a spinner longer than this
const OPEN_REGROUP_MS = 20000;  // playing alone away from the front → go back and look again
// The hard floor under every other open-table timer: nobody waits longer than
// this for a game. Whatever the room is doing — a ghost roster holding all four
// seats, a claim nobody answers, an election that keeps deferring to a "live"
// table that is really just our own polling — at this point we fill the empty
// seats with bots and deal. Three people staring at a spinner while the table
// waits for a fourth who never comes is the failure this closes.
const OPEN_FORCE_START_MS = 20000;
const OPEN_COUNTDOWN_AT = 12;   // …and the cover starts counting it down out loud with this long left
// A no-invite launch must land in a room it SHARES with other no-invite players.
// The platform hands each such launch its own private `standalone_` room, so
// joining that would put every player at their own table with three bots and the
// open room could never fill — the whole point of it. So we pick the room
// ourselves: a small ladder of well-known public tables, tried in order, so
// people pile into the first one until it is full before a second one opens.
const OPEN_ROOM_PREFIX = "public-13-";
const OPEN_ROOM_SHARDS = 8;
const OPEN_HOP_MS = 12000;      // still seatless after this, with no free seat in sight → next table
const OPTIMISTIC_STUCK_MS = 6000;   // our own move has not come back → assume we are out of step

// ── i18n ─────────────────────────────────────────────────
// Mongolian is the default; every other host language falls back to English.
// The language comes from the platform (Usion.getLanguage(), i.e. the user's
// app-wide setting) — never hardcode UI strings to one locale.
const STR = {
  mn: {
    you: "Та",
    botNames: ["Та", "Бот Бат", "Бот Болд", "Бот Сүх"],
    pair: r => r + " хос",
    triple: r => r + " гурав",
    four: r => r + " дөрөв",
    sflush: r => r + " дараалал флэш",
    fourplus: r => "дөрөв+1 (" + r + ")",
    fullhouse: r => "фулл хаус (" + r + ")",
    flush: s => "флэш " + s,
    straight: r => r + " дараалал",
    max5: "Дээд тал нь 5 хөзөр",
    invalidPlay: "Хүчингүй тавилт",
    sending: "Илгээж байна…",
    yourTurn: "Таны ээлж",
    turnOf: n => n + "-ийн ээлж…",
    pass: "Өнжих",
    play: "Тавих",
    finished: "ДУУСГАВ! 🎉",
    leftGame: "Гарсан",
    dragon: n => n + " — ЛУУ! 🐉",
    youWonRound: "Та тойргийг хожлоо!",
    wonRound: n => n + " тойргийг хожлоо!",
    eliminatedTag: "ХОЖИГДСОН",
    wonTag: "🏆 хожлоо",
    cardsLeft: n => n + " үлдсэн",
    nextRoundIn: num => "Дараагийн тойрог " + num + " секундын дараа",
    nextRound: "Дараагийн тойрог",
    newGame: "Шинэ тоглоом",
    winnerLabel: "ЯЛАГЧ",
    survived: "үлдсэн",
    lostTag: "хожигдсон",
    playAgain: "ДАХИН ТОГЛОХ",
    lobbyTitle: "Нээлттэй ширээ",
    connecting: "Холбогдож байна…",
    waitingPlayers: (a, b) => "Тоглогчдыг хүлээж байна… (" + a + "/" + b + ")",
    readyStarting: n => n + " тоглогч бэлэн — эхэлж байна…",
    waitingJoin: "Тоглогчид нэгдэхийг хүлээж байна…",
    readyCount: (a, b) => a + "/" + b + " бэлэн",
    ready: "БЭЛЭН",
    readyOn: "✓ БЭЛЭН",
    notReady: "БЭЛЭН БИШ",
    hostTag: "ХОСТ",
    hintHostGo: "Бүгд бэлэн — Эхлүүлэх дар!",
    hintHostWait: "Бүх тоглогч бэлэн болмогц Эхлүүлэх нээгдэнэ.",
    hintWaitHost: "Хост эхлүүлэхийг хүлээж байна…",
    hintPressReady: "Бэлэн болсон бол БЭЛЭН гэж дар.",
    playerN: i => "Тоглогч " + i,
    startedWithoutYou: "Хост таныг оруулалгүй эхлүүллээ.",
    lobbyTitleInvite: "Хүлээх танхим",
    openBotNames: ["Бот Бат", "Бот Болд", "Бот Сүх", "Бот Дорж"],
    openWaitSeat: "Суудал чөлөөлөгдөхийг хүлээж байна…",
    openTableTag: "НЭЭЛТТЭЙ ШИРЭЭ",
    openStatus: "Нээлттэй ширээ — хэн ч дундаас нь нэгдэж болно",
    openStartIn: s => "Ботуудтай " + s + " секундын дараа эхэлнэ…",
    openJoined: n => n + " ширээнд оролоо",
    openLeftBot: n => n + " гарлаа — бот суудлыг нь авлаа",
    openRestarting: "Шинэ ширээ бэлдэж байна…",
    dealing: "Хөзөр тарааж байна…",
    startGame: "ТОГЛООМ ЭХЛҮҮЛЭХ",
    playBots: "БОТТОЙ ТОГЛОХ",
    menuOnline: "Онлайн",
    menuBots: "Боттой тоглох",
    menuInvite: "Найзаа урих",
    inviteFail: "Урилга нээж чадсангүй",
    disconnectedPaused: "Холболт тасарлаа — түр зогссон…",
    dealFail: "Тараалт илгээж чадсангүй",
    moveFail: "Нүүдэл илгээж чадсангүй",
    leaveFail: "Гаралтын төлөв илгээж чадсангүй",
    leftGrace: s => "Тоглогч гарлаа — дахин нэгдэхийг хүлээж байна… (" + s + "с)",
    rematchWait: "Хост дахин тоглолт эхлүүлэхийг хүлээж байна…",
    rematchWants: n => n + " дахин тоглохыг хүсэж байна",
    title: "МОНГОЛ ПОКЕР",
    docTitle: "Монгол Покер",
    setupSub: "2–4 тоглогч, тус бүр 13 хөзөр — хөзрөө хамгийн түрүүнд дуусга. Ганц, хос, гурав, дөрөв, эсвэл 5 хөзрийн хослол (дараалал, флэш, фулл хаус, дөрөв+1, дараалал флэш) тавь. Ширээн дээрхийг ижил тооны илүү том хослолоор дар, эсвэл Өнжих. ♠>♥>♣>♦.",
    playersLabel: "ТОГЛОГЧ",
    loseLabel: "ХОЖИГДОХ ОНОО",
    nameLabel: "ТАНЫ НЭР",
    setupFoot: "Урилгаар ороход хүлээх танхим. Урилгагүй тоглоход нээлттэй ширээ — хүн ирэхэд ботын суудлыг авна.",
    skinToggle: "Ширээний өнгө солих",
    chatAria: "Түргэн харилцах",
    customChat: "Өөрийн мессеж",
    customChatPlaceholder: "Мессеж бичих…",
    backToQuickChat: "Түргэн чат руу буцах",
    send: "Илгээх",
    qcHurry: "Хурдлаач",
    qcBad: "Муу юм бэ",
    qcGotit: "Чи болчихжээ",
    qcNice: "Юм авцаан",
    qcWow: "Аймар аймар",
    // ── Tournament ──
    tourMenu: "Тэмцээн",
    tourTitle: "Тэмцээн",
    tourBack: "Буцах",
    tourToday: hm => "Өнөөдөр " + hm,
    tourTomorrow: hm => "Маргааш " + hm,
    tourStartsIn: s => "Эхлэхэд " + s,
    tourRegistered: n => n + " бүртгүүлсэн",
    tourRegister: "БҮРТГҮҮЛЭХ",
    tourWithdraw: "Бүртгэлээ цуцлах",
    tourEnter: "ШИРЭЭНДЭЭ ОРОХ",
    tourToMenu: "ЦЭС РҮҮ",
    tourStGuest: "Бүртгүүлээгүй",
    tourStRegistered: "Бүртгүүлсэн",
    tourStWaiting: "Ширээ бэлэн",
    tourStPlaying: "Тоглож байна",
    tourStQualified: "Шалгарсан",
    tourStEliminated: "Хасагдсан",
    tourStChampion: "Аварга",
    tourStCancelled: "Цуцлагдсан",
    tourNoteReg: hm => "Бүртгэл " + hm + "-д хаагдаж, ширээ хуваарилагдана.",
    tourNoteRegDone: hm => "Та бүртгэгдсэн. " + hm + "-д ширээ тань нээгдэнэ.",
    tourNoteClosed: when => "Бүртгэл хаагдсан. Дараагийн тэмцээн: " + when + ".",
    tourNoteWaiting: "Ширээ тань нээгдлээ. Эхлэх цагт хөзөр тарна.",
    tourNotePlaying: "Таны ширээ эхэлсэн — одоо орно уу.",
    tourNoteQualified: (a, b, rest) => "Дараагийн шатыг хүлээж байна: " + a + "/" + b + " ширээ дууссан." + (rest ? " Тоглож байгаа: " + rest + "." : ""),
    tourNoteNextIn: s => "Дараагийн шат " + s + "-ын дараа эхэлнэ.",
    tourNoteEliminated: "Энэ удаа хасагдлаа. Бусад ширээг «Ширээ үзэх» товчоор үзэж болно.",
    tourWatch: "Ширээ үзэх",
    tourWatchWaiting: "Ширээний мэдээлэл ирэхийг хүлээж байна…",
    tourWatchNone: "Энэ ширээнд тоглолт явахгүй байна",
    tourWatchDealing: "Хөзөр тарааж байна…",
    tourWatchLobby: (a, b) => "Тоглогчид цугларч байна: " + a + "/" + b,
    tourTableClosed: "Ширээ тань хаагдсан: 3 минутын турш ширээнд хэн ч идэвхгүй байсан.",
    tourWatchTurn: n => "Ээлж: " + n,
    tourWatchWinner: n => "Ялагч: " + n,
    tourViewers: n => n + " үзэгч",
    tourSpecExit: "Гарах",
    tourNoteChampion: "Та тэмцээнд түрүүллээ!",
    tourNoteFew: "Бүртгүүлсэн тоглогч 2 хүрээгүй тул тэмцээн цуцлагдлаа.",
    tourNoteEmpty: "Бүх ширээ ялагчгүй дууссан тул тэмцээн дууслаа.",
    tourNoteLive: when => "Тэмцээн явагдаж байна. Дараагийнх нь: " + when + ".",
    // day: 0 today, 1 tomorrow, 2 later
    tourMoveNext: (day, hm, old) => "Анхаар! " + (day === 0 ? "Өнөөдрөөс" : day === 1 ? "Маргаашаас" : "Удахгүй") +
      " эхлэн тэмцээн өдөр бүр " + hm + "-д болно (одоо " + old + ").",
    tourMoveNow: (hm, old) => "Анхаар! Тэмцээн өнөөдрөөс эхлэн өдөр бүр " + hm + "-д болно (өмнө нь " + old + ").",
    tourEntrants: "БҮРТГҮҮЛСЭН ТОГЛОГЧИД",
    tourNoEntrants: "Одоогоор хэн ч бүртгүүлээгүй байна. Хамгийн түрүүнд бүртгүүлээрэй!",
    tourStage: n => n + "-р шат",
    tourFinal: "Финал",
    tourStageDone: (a, b) => a + "/" + b + " ширээ дууссан",
    tourTable: k => "Ширээ " + k,
    tourYours: "ТАНЫ",
    tourChampion: "АВАРГА",
    tourRules: "ДҮРЭМ",
    tourRulesList: [
      (hm, close) => "Өдөр бүр " + hm + "-д эхэлнэ. Бүртгэл " + close + "-д хаагдаж, ширээ хуваарилагдана.",
      "Бүртгүүлсэн бүх хүнийг санамсаргүйгээр 2–4 хүнтэй ширээнд аль болох тэнцүү хуваарилна.",
      "Ширээ бүр 20 оноо хүртэл тоглож, ганц ялагч нь дараагийн шатанд гарна. Нэг нүүдэлд 60 секунд.",
      "Бүх ширээ дуусахаас өмнө дараагийн шат эхлэхгүй; шат хооронд 20 секунд. Ганц ширээ үлдвэл тэр нь финал.",
      "Эхлэх цагаас 30 секундийн дотор ширээндээ ороогүй хүн хасагдана. Бот нөхөхгүй.",
      "Цагтаа ганцаараа ирвэл шууд шалгарна. Хоцорч ирсэн бол шалгарахгүй. Хэн ч ирээгүй, эсвэл 3 минут хэн ч идэвхгүй ширээ ялагчгүй хаагдана.",
      "2-оос цөөн хүн бүртгүүлбэл тэмцээн цуцлагдана."
    ],
    tourLobbyTitle: (st, k) => st + " · Ширээ " + k,
    tourLobbyStartsIn: s => "Эхлэхэд " + s,
    tourLobbyWaiting: (a, b) => a + "/" + b + " ирсэн",
    tourLobbyGrace: s => "Ирээгүй хүнийг " + s + "-ын дараа хасна",
    tourLobbyAll: "Бүгд ирлээ — эхэлж байна…",
    tourLobbyRule: "Эхлэх цагаас 30 секундийн дотор ирээгүй хүн хасагдана.",
    tourLobbyStarting: "Эхэлж байна…",
    tourHere: "ИРСЭН",
    tourAway: "ХҮЛЭЭЖ БАЙНА",
    tourBackToTour: "ТЭМЦЭЭН РҮҮ",
    tourWalkover: "Өөр хүн ирээгүй — та шалгарлаа!",
    tourLateOut: "Эхлэх цагаас 30 секундийн дотор ирээгүй тул хасагдлаа.",
    tourQualifiedMsg: "Та дараагийн шатанд шалгарлаа!",
    tourChampionMsg: "Та тэмцээнд түрүүллээ! 🏆",
    tourEliminatedMsg: "Та тэмцээнээс хасагдлаа.",
    tourRegFail: "Бүртгэж чадсангүй. Дахин оролдоно уу.",
    tourNoCloud: "Тэмцээн зөвхөн Usion апп дотор ажиллана.",
    tourLate: "Таны ширээ эхэлчихсэн тул энэ шатанд оролцох боломжгүй.",
    tourInviteTitle: "Өнөөдөр тэмцээнтэй! Оролцох уу?",
    tourInviteWhen: hm => "Өнөөдөр " + hm + "-д эхэлнэ",
    tourInviteFirst: "Хамгийн түрүүнд бүртгүүлээрэй",
    tourInviteClose: hm => "Бүртгэл " + hm + "-д хаагдана",
    tourInviteYes: "ОРОЛЦОЁ",
    tourInviteNo: "Үгүй",
    tourJoinFail: "Ширээнд холбогдож чадсангүй. «Ширээндээ орох» дээр дахин дарна уу.",
    tourRemindOffer: (hm, min) => "Тэмцээн эхлэхээс " + min + " минутын өмнө (" + hm + ") сануулга авах уу?",
    tourRemindOn: (hm, min) => "Сануулга асаалттай · эхлэхээс " + min + " минутын өмнө",
    tourRemindOff: "Тэмцээний сануулга унтраалттай",
    tourRemindBlocked: "Сануулга ирэхгүй байна — Usion-д энэ аппын мэдэгдлийг асаана уу",
    tourRemindYes: "Асаах",
    tourRemindLater: "Дараа",
    tourRemindTurnOff: "Унтраах",
    tourRemindTurnOn: "Асаах",
    tourRemindReason: "Тэмцээн эхлэхээс 3 минутын өмнө сануулга илгээхийн тулд",
    tourRemindDenied: "Мэдэгдлийн зөвшөөрөл өгөөгүй тул сануулга асаасангүй.",
    tourRemindOnToast: "Сануулга асаалаа!",
    tourRemindFail: "Сануулгыг тохируулж чадсангүй.",
    tourLastChamp: "СҮҮЛИЙН АВАРГА",
    tourFameTitle: "АВАРГУУД",
    tourLive: r => "● ШУУД · " + r + "-р тойрог",
    tourPts: (a, b) => a + "/" + b,
    tourOut: "хасагдсан",
    tourBannerTitle: "ӨДРИЙН ТЭМЦЭЭНИЙ АВАРГА",
    tourBannerStats: (n, s) => n + " тоглогч · " + s + " шат",
    tourBannerPlayers: n => n + " тоглогч",
    tourBannerStages: n => n + " шат",
    tourBannerGame: "♠  13 · МОНГОЛ ПОКЕР  ♥",
    tourPrizeTitle: "ТАНЫ АВАРГЫН БАННЕР",
    tourShareText: "Монгол Покерын өдрийн тэмцээнд түрүүллээ! 🏆",
    tourShareCardTitle: n => n + " — Тэмцээний аварга",
    tourShareBtn: "МЭДЭЭНД ХУВААЛЦАХ",
    tourSharedBtn: "✓ ХУВААЛЦСАН",
    tourShared: "Мэдээнд хуваалцлаа!",
    tourShareLater: "Түр хүлээгээд дахин оролдоорой.",
    tourShareFail: "Хуваалцаж чадсангүй.",
    tourShareNoHost: "Мэдээнд хуваалцах нь Usion аппын шинэ хувилбарт ажиллана.",
  },
  en: {
    you: "You",
    botNames: ["You", "Bot Bat", "Bot Bold", "Bot Sukh"],
    pair: r => r + " pair",
    triple: r => r + " triple",
    four: r => r + " four",
    sflush: r => r + "-high straight flush",
    fourplus: r => "four+1 (" + r + ")",
    fullhouse: r => "full house (" + r + ")",
    flush: s => "flush " + s,
    straight: r => r + "-high straight",
    max5: "Max 5 cards",
    invalidPlay: "Invalid play",
    sending: "Sending…",
    yourTurn: "Your turn",
    turnOf: n => n + "'s turn…",
    pass: "Pass",
    play: "Play",
    finished: "FINISHED! 🎉",
    leftGame: "Left",
    dragon: n => n + " — DRAGON! 🐉",
    youWonRound: "You won the round!",
    wonRound: n => n + " won the round!",
    eliminatedTag: "ELIMINATED",
    wonTag: "🏆 won",
    cardsLeft: n => n + " left",
    nextRoundIn: num => "Next round in " + num + " seconds",
    nextRound: "Next round",
    newGame: "New game",
    winnerLabel: "WINNER",
    survived: "survived",
    lostTag: "eliminated",
    playAgain: "PLAY AGAIN",
    lobbyTitle: "Open table",
    connecting: "Connecting…",
    waitingPlayers: (a, b) => "Waiting for players… (" + a + "/" + b + ")",
    readyStarting: n => n + " players ready — starting…",
    waitingJoin: "Waiting for players to join…",
    readyCount: (a, b) => a + "/" + b + " ready",
    ready: "READY",
    readyOn: "✓ READY",
    notReady: "NOT READY",
    hostTag: "HOST",
    hintHostGo: "Everyone is ready — press Start!",
    hintHostWait: "Start unlocks once every player is ready.",
    hintWaitHost: "Waiting for the host to start…",
    hintPressReady: "Press READY when you're set.",
    playerN: i => "Player " + i,
    startedWithoutYou: "The host started without you.",
    lobbyTitleInvite: "Waiting room",
    openBotNames: ["Bot Bat", "Bot Bold", "Bot Sukh", "Bot Dorj"],
    openWaitSeat: "Waiting for a seat to open…",
    openTableTag: "OPEN TABLE",
    openStatus: "Open table — anyone can drop in",
    openStartIn: s => "Starting with bots in " + s + "s…",
    openJoined: n => n + " joined the table",
    openLeftBot: n => n + " left — a bot took the seat",
    openRestarting: "Starting a fresh table…",
    dealing: "Dealing…",
    startGame: "START GAME",
    playBots: "PLAY VS BOTS",
    menuOnline: "Online",
    menuBots: "Play vs bots",
    menuInvite: "Invite a friend",
    inviteFail: "Couldn't open the invite",
    disconnectedPaused: "Connection lost — paused…",
    dealFail: "Couldn't send the deal",
    moveFail: "Couldn't send the move",
    leaveFail: "Couldn't send the leave outcome",
    leftGrace: s => "A player left — waiting for them to rejoin… (" + s + "s)",
    rematchWait: "Waiting for the host to start a rematch…",
    rematchWants: n => n + " wants a rematch",
    title: "MONGOL POKER",
    docTitle: "Mongol Poker",
    setupSub: "2–4 players, 13 cards each — be the first to empty your hand. Play a single, pair, triple, four, or a 5-card hand (straight, flush, full house, four+1, straight flush). Beat the table with a bigger combo of the same size, or Pass. ♠>♥>♣>♦.",
    playersLabel: "PLAYERS",
    loseLabel: "LOSE AT",
    nameLabel: "YOUR NAME",
    setupFoot: "A chat invite opens a waiting room. Playing without one opens a table anyone can drop into.",
    skinToggle: "Change table colour",
    chatAria: "Quick chat",
    customChat: "Custom message",
    customChatPlaceholder: "Type a message…",
    backToQuickChat: "Back to quick chat",
    send: "Send",
    qcHurry: "Hurry up!",
    qcBad: "So bad!",
    qcGotit: "You got it!",
    qcNice: "Nice one!",
    qcWow: "Wow wow!",
    tourMenu: "Tournament",
    tourTitle: "Tournament",
    tourBack: "Back",
    tourToday: hm => "Today " + hm,
    tourTomorrow: hm => "Tomorrow " + hm,
    tourStartsIn: s => "Starts in " + s,
    tourRegistered: n => n + " registered",
    tourRegister: "REGISTER",
    tourWithdraw: "Withdraw",
    tourEnter: "GO TO MY TABLE",
    tourToMenu: "MENU",
    tourStGuest: "Not registered",
    tourStRegistered: "Registered",
    tourStWaiting: "Table ready",
    tourStPlaying: "Playing",
    tourStQualified: "Qualified",
    tourStEliminated: "Eliminated",
    tourStChampion: "Champion",
    tourStCancelled: "Cancelled",
    tourNoteReg: hm => "Registration closes and tables are drawn at " + hm + ".",
    tourNoteRegDone: hm => "You're in. Your table opens at " + hm + ".",
    tourNoteClosed: when => "Registration is closed. Next tournament: " + when + ".",
    tourNoteWaiting: "Your table is open. Cards are dealt at the start time.",
    tourNotePlaying: "Your table has started — join now.",
    tourNoteQualified: (a, b, rest) => "Waiting for the next stage: " + a + "/" + b + " tables finished." + (rest ? " Still playing: " + rest + "." : ""),
    tourNoteNextIn: s => "Next stage starts in " + s + ".",
    tourNoteEliminated: "You're out this time. Tap «Watch table» to follow the other tables.",
    tourWatch: "Watch table",
    tourWatchWaiting: "Waiting for this table's first update…",
    tourWatchNone: "Nothing is being played at this table",
    tourWatchDealing: "Dealing…",
    tourWatchLobby: (a, b) => "Players gathering: " + a + "/" + b,
    tourTableClosed: "Your table was closed: nobody at it was active for 3 minutes.",
    tourWatchTurn: n => "Turn: " + n,
    tourWatchWinner: n => "Winner: " + n,
    tourViewers: n => n + " watching",
    tourSpecExit: "Leave",
    tourNoteChampion: "You won the tournament!",
    tourNoteFew: "Fewer than 2 players registered, so the tournament was cancelled.",
    tourNoteEmpty: "Every table ended without a winner.",
    tourNoteLive: when => "A tournament is under way. Next one: " + when + ".",
    tourMoveNext: (day, hm, old) => "Heads up! " + (day === 0 ? "From today" : day === 1 ? "From tomorrow" : "Soon") +
      " the tournament starts at " + hm + " every day (now " + old + ").",
    tourMoveNow: (hm, old) => "Heads up! From today the tournament starts at " + hm + " every day (it was " + old + ").",
    tourEntrants: "REGISTERED PLAYERS",
    tourNoEntrants: "Nobody has registered yet. Be the first!",
    tourStage: n => "Stage " + n,
    tourFinal: "Final",
    tourStageDone: (a, b) => a + "/" + b + " tables finished",
    tourTable: k => "Table " + k,
    tourYours: "YOURS",
    tourChampion: "CHAMPION",
    tourRules: "RULES",
    tourRulesList: [
      (hm, close) => "Starts every day at " + hm + ". Registration closes and tables are drawn at " + close + ".",
      "Everyone registered is seated at random at tables of 2–4, as evenly as possible.",
      "Each table plays to 20 points; its single winner moves on. 60 seconds a turn.",
      "The next stage waits for every table; 20 s break between stages. One table left is the final.",
      "Not at your table within 30 seconds of the start = out. No bots fill in.",
      "Alone at the table on time = you go through. Late = you don't. A table nobody came to, or nobody was active at for 3 minutes, closes without a winner.",
      "Fewer than 2 registrations cancels the tournament."
    ],
    tourLobbyTitle: (st, k) => st + " · Table " + k,
    tourLobbyStartsIn: s => "Starts in " + s,
    tourLobbyWaiting: (a, b) => a + "/" + b + " here",
    tourLobbyGrace: s => "No-shows are removed in " + s,
    tourLobbyAll: "Everyone is here — starting…",
    tourLobbyRule: "Anyone not here within 30 seconds of the start is out.",
    tourLobbyStarting: "Starting…",
    tourHere: "HERE",
    tourAway: "WAITING",
    tourBackToTour: "BACK TO TOURNAMENT",
    tourWalkover: "Nobody else showed up — you go through!",
    tourLateOut: "You arrived after the first 30 seconds, so you're out.",
    tourQualifiedMsg: "You're through to the next stage!",
    tourChampionMsg: "You won the tournament! 🏆",
    tourEliminatedMsg: "You're out of the tournament.",
    tourRegFail: "Couldn't register. Please try again.",
    tourNoCloud: "Tournaments only work inside the Usion app.",
    tourLate: "Your table already started, so you can't play this stage.",
    tourInviteTitle: "Tournament today! Want to play?",
    tourInviteWhen: hm => "Starts today at " + hm,
    tourInviteFirst: "Be the first to register",
    tourInviteClose: hm => "Registration closes at " + hm,
    tourInviteYes: "COUNT ME IN",
    tourInviteNo: "No thanks",
    tourJoinFail: "Couldn't connect to your table. Tap «Go to my table» again.",
    tourRemindOffer: (hm, min) => "Get a reminder " + min + " minutes before the start (" + hm + ")?",
    tourRemindOn: (hm, min) => "Reminder on · " + min + " min before the start",
    tourRemindOff: "Tournament reminder is off",
    tourRemindBlocked: "Reminders can't reach you — allow notifications for this app in Usion",
    tourRemindYes: "Turn on",
    tourRemindLater: "Later",
    tourRemindTurnOff: "Turn off",
    tourRemindTurnOn: "Turn on",
    tourRemindReason: "To remind you 3 minutes before the tournament starts",
    tourRemindDenied: "Notifications weren't allowed, so the reminder is off.",
    tourRemindOnToast: "Reminder on!",
    tourRemindFail: "Couldn't change the reminder.",
    tourLastChamp: "LATEST CHAMPION",
    tourFameTitle: "CHAMPIONS",
    tourLive: r => "● LIVE · round " + r,
    tourPts: (a, b) => a + "/" + b,
    tourOut: "out",
    tourBannerTitle: "DAILY TOURNAMENT CHAMPION",
    tourBannerStats: (n, s) => n + " players · " + s + (s === 1 ? " stage" : " stages"),
    tourBannerPlayers: n => n + " players",
    tourBannerStages: n => n + (n === 1 ? " stage" : " stages"),
    tourBannerGame: "♠  13 · MONGOL POKER  ♥",
    tourPrizeTitle: "YOUR CHAMPION BANNER",
    tourShareText: "I won today's Mongol Poker tournament! 🏆",
    tourShareCardTitle: n => n + " — Tournament champion",
    tourShareBtn: "SHARE TO NEWS FEED",
    tourSharedBtn: "✓ SHARED",
    tourShared: "Shared to your News Feed!",
    tourShareLater: "Please try again in a moment.",
    tourShareFail: "Couldn't share.",
    tourShareNoHost: "Sharing to the News Feed needs a newer Usion app.",
  },
};
let LANG = "mn";
// Names come from the platform profile and can be long enough to break the seat
// they are written under — or, in the turn line, to run straight through the
// seats on either side of it. Clip once, here, so every place a name is shown
// agrees on how long a name is allowed to be. The full name is kept in `players`
// and in playerMeta: result cards and tooltips still use the real thing.
const NAME_MAX = 10;
function shortName(n) {
  const s = String(n == null ? "" : n).trim();
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + "…" : s;
}
function t(key) {
  let v = STR[LANG] ? STR[LANG][key] : undefined;
  if (v === undefined) v = STR.mn[key];
  if (typeof v === "function") return v.apply(null, Array.prototype.slice.call(arguments, 1));
  return v !== undefined ? v : key;
}
function detectLang() {
  // This game ships Mongolian, so it always opens in Mongolian regardless of the
  // platform/browser language. The English (STR.en) table stays only as an
  // internal fallback for any key missing from STR.mn.
  return "mn";
}

// The rules live in rules.js (shared with the server). Page labels go through t().
T13Rules.setLabeler(function () { return t.apply(null, arguments); });
const { rankLabel, cardStrength, cardWire, cardKey, wireCard, sortCards, sameCard, straightPos, posToRank, mk, classify, classify5, comboName, cmpArr, canBeat, byRank, lowestCard, allCombos, pushAll5, chooseAcross, chooseCards, isPrecious, buildHandPlanner, comparePlannedMoves, plannedMoves, botLead, botFollow, buildDeck, mulberry32, dealHands, randomSeed, deduction } = T13Rules;

// ── Game state ───────────────────────────────────────────
let players = [];
let numPlayers = 4;
let hands = [];
let table = null;           // { combo, seat } | null
let turn = 0;
let firstPlay = true;       // first lead of the deal must include the lowest card
let lowCard = null;         // the globally lowest dealt card
let passed = new Set();
let passStreak = 0;         // consecutive passes since the last play (trick ends at active-1)
let lastAction = {};
let botTimer = null;
let turnTimer = null;       // ticks the active player's 2:00 turn clock
let turnLeft = TURN_SECONDS;
let turnDeadline = 0;       // wall-clock ms when the active seat's clock expires (survives a background freeze)
let pausedAt = 0;           // wall-clock ms when netPaused began, so the deadline can be pushed back on resume
let proxyTimer = null;      // fallback: act FOR a frozen/away player once their clock has long expired
// Did we WATCH this turn begin on a live move? A client that rebuilt the round
// from a checkpoint, or that was disconnected through it, restarts the clock from
// full and therefore has no idea how long the active player has really had — it
// must not be the one to auto-pass them. Peers that stayed live still can.
let turnTrusted = false;
let netPaused = false;      // true while our connection is dropped — freezes the turn clock so a disconnect can't auto-pass us
let dealActive = false;
let lastWinner = -1;
let loseAt = 30;            // a player who reaches this many penalty points is eliminated
let firstDeal = true;       // first deal of the game: lowest card (3♦) leads; later deals: winner leads
let trickPlays = [];        // plays in the current trick: [{ seat, combo }] (for the table history)
let endTimer = null;        // brief pause after the winning play before the results overlay
let dealWaitTimer = null;   // non-host: keep asking for the host's deal until it lands
let dealTimer = null;       // staggered fallback: deal the next round if the higher-ranked client didn't
// Declared up here (not next to showHandOver) because startDeal clears them and
// `let` would leave them in the temporal dead zone if a deal ever landed first.
let handCdInterval = null, handCdTimeout = null;
let dealEpoch = 0;          // bumped on every applied deal — lets a scheduled fallback detect "already dealt"
let awaitingDeal = false;   // the results countdown finished and the next round hasn't landed yet
let roundMoveNo = 0;        // moves applied in THIS round; carried on the wire as `ti` for duplicate/proxy dedup
let mySeat = 0;
// Round-start snapshot for host checkpoints: scores/elimination + the starter
// context (firstDeal/lastWinner) as they were when THIS round was dealt, so a
// reconnecting client can rebuild the live round from the checkpoint alone
// (deal + replay this round's moves) instead of the full action log.
let roundStartTotals = [];
let roundStartOuts = [];
let roundFirstDeal = true;
let roundLastWinner = -1;

// ── DOM ──────────────────────────────────────────────────
const oppEl = document.getElementById("opponents");
const turnLine = document.getElementById("turnLine");
const tableComboEl = document.getElementById("tableCombo");
const tableLabelEl = document.getElementById("tableLabel");
const meAvatarEl = document.getElementById("meAvatar");
const meNameEl = document.getElementById("meName");
const meScoreEl = document.getElementById("meScore");
const meStatusEl = document.getElementById("meStatus");
const handEl = document.getElementById("hand");
const playBtn = document.getElementById("playBtn");
const passBtn = document.getElementById("passBtn");
const setupOverlay = document.getElementById("setupOverlay");
const onlineOverlay = document.getElementById("onlineOverlay");
const menuOverlay = document.getElementById("menuOverlay");
// First paint: the menu is the HTML's initial screen. A chat-invite launch is
// already known from the launch params, so put up the waiting hall cover now
// rather than flashing the menu until Usion.init fires.
(function firstScreen() {
  try {
    const lp = window.Usion && typeof Usion.getLaunchParams === "function" ? (Usion.getLaunchParams() || {}) : {};
    if (lp.mode === "multiplayer") {
      menuOverlay.classList.remove("show");
      onlineOverlay.classList.add("show");
    }
  } catch (_) {}
})();
const handOverlay = document.getElementById("handOverlay");
const toastEl = document.getElementById("toast");

let selected = new Set();
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1300);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// Apply the chosen language to the static DOM (overlays, buttons, <html lang>).
// Runs once at load (navigator fallback) and again in Usion.init once the
// platform's language setting arrives.
function applyLang(lang) {
  LANG = lang === "en" ? "en" : "mn";
  document.documentElement.lang = LANG;
  document.title = t("docTitle");
  const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
  set("setupTitle", "title"); set("setupSub", "setupSub");
  set("playersLabel", "playersLabel"); set("loseLabel", "loseLabel"); set("nameLabelText", "nameLabel");
  set("startBtn", "startGame"); set("setupFoot", "setupFoot");
  set("lobbyTitle", "lobbyTitleInvite");   // enterLobby() swaps it for an open room
  set("startGameBtn", "startGame"); set("lobbyBotsBtn", "playBots");
  set("menuTitle", "title"); set("menuOnlineLabel", "menuOnline");
  set("menuBotsLabel", "menuBots"); set("menuInviteLabel", "menuInvite"); set("menuTourLabel", "tourMenu"); set("tourPrizeTitle", "tourPrizeTitle"); set("tourBackLabel", "tourBack"); set("tourTitle", "tourTitle"); set("lobbyTourBtn", "tourBackToTour");
  tourRenderMenuNotice();   // its text is in the language too
  set("lobbyLoseLabel", "loseLabel");
  set("winnerLabel", "winnerLabel"); set("playAgainBtn", "playAgain");
  set("passBtn", "pass"); set("playBtn", "play");
  const skinBtn = document.getElementById("skinToggle");
  if (skinBtn) skinBtn.setAttribute("aria-label", t("skinToggle"));
  const chatBtn = document.getElementById("chatToggle");
  if (chatBtn) chatBtn.setAttribute("aria-label", t("chatAria"));
  const customInput = document.getElementById("customChatInput");
  const customBack = document.getElementById("customChatBack");
  const customSend = document.getElementById("customChatSend");
  if (customInput) customInput.placeholder = t("customChatPlaceholder");
  if (customBack) customBack.setAttribute("aria-label", t("backToQuickChat"));
  if (customSend) customSend.textContent = t("send");
  buildChatPicker();
  // Swap the default placeholder name only if the user hasn't typed their own.
  const nameInput = document.getElementById("nameInput");
  if (nameInput && (!nameInput.value || nameInput.value === STR.mn.you || nameInput.value === STR.en.you)) nameInput.value = t("you");
  if (meNameEl && (meNameEl.textContent === STR.mn.you || meNameEl.textContent === STR.en.you)) meNameEl.textContent = t("you");
}
const MAX_CHAT_LENGTH = 80;
let customChatOpen = false;
applyLang(detectLang());

function makeCardEl(c) {
  const el = document.createElement("div");
  el.className = "card" + (SUIT_RED[c.s] ? " red" : "");
  el.dataset.cardKey = cardKey(c);
  const r = rankLabel(c.r), s = SUITS[c.s];
  el.innerHTML =
    '<span class="corner tl"><b>' + r + '</b><i>' + s + '</i></span>' +
    '<span class="pip">' + s + "</span>" +
    '<span class="corner br"><b>' + r + '</b><i>' + s + "</i></span>";
  return el;
}

// ── Rendering ────────────────────────────────────────────
function normalizeAvatar(value) {
  if (typeof value !== "string") return null;
  const src = value.trim();
  return src && src.length <= 2048 ? src : null;
}
function avatarInitial(name, isBot) {
  if (isBot) return "♣";
  const chars = Array.from(String(name || "").trim());
  return chars.length ? chars[0].toUpperCase() : "?";
}
function paintAvatar(el, name, avatar, isBot) {
  if (!el) return;
  const src = normalizeAvatar(avatar);
  el.textContent = avatarInitial(name, isBot);
  el.classList.toggle("bot-avatar", !!isBot);
  el.setAttribute("aria-label", String(name || t("you")));
  if (!src) return;
  const img = document.createElement("img");
  img.setAttribute("src", src);
  img.setAttribute("alt", "");
  img.setAttribute("draggable", "false");
  img.addEventListener("error", () => img.remove());
  el.appendChild(img);
}
function makeAvatarEl(name, avatar, className, isBot) {
  const el = document.createElement("span");
  el.className = "player-avatar" + (className ? " " + className : "");
  paintAvatar(el, name, avatar, isBot);
  return el;
}
function renderMyPlayer() {
  const p = players[mySeat];
  if (!p) return;
  meNameEl.textContent = shortName(p.name);
  paintAvatar(meAvatarEl, p.name, p.avatar, p.isBot);
  markVoiceAvatar(meAvatarEl, online ? roomPlayerIds[mySeat] : null, p.isBot);
}
function render() {
  syncVoiceButton();
  publishOpenTable();
  // Unseated (waiting for a seat at a full open table): there is no hand, no
  // opponents and no seat of our own to draw — only the chat button's state.
  if (mySeat < 0 || !players[mySeat]) { updateChatButton(); return; }
  renderMyPlayer(); renderOpponents(); renderTable(); renderHand(); renderControls(); updateTimers(); renderMyScore(); updateChatButton();
}
function renderMyScore() { if (meScoreEl && players[mySeat]) meScoreEl.textContent = players[mySeat].total; }

// ── Turn clock (per-player 2:00; auto-pass / auto-lead on expiry) ─────────
function fmtTime(s) { s = Math.max(0, s | 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
// A circular countdown ring around the profile photo. pathLength=100 lets us
// drive the arc with a 0–100 dashoffset regardless of its rendered size.
function ringSVG() {
  return '<svg viewBox="0 0 36 36">' +
    '<circle class="ring-bg" cx="18" cy="18" r="15.5"></circle>' +
    '<circle class="ring-fg" cx="18" cy="18" r="15.5" pathLength="100"></circle>' +
    '</svg>';
}
function setTimerEl(el, live, secs) {
  if (!el) return;
  el.classList.toggle("live", live);
  el.classList.toggle("warn", live && secs <= 10);
  const frac = Math.max(0, Math.min(1, secs / turnSeconds()));
  const fg = el.querySelector(".ring-fg");
  if (fg) fg.style.strokeDashoffset = (100 * (1 - frac)).toFixed(2);
}
// Refresh just the clock rings (cheap; runs every second without a full render).
function updateTimers() {
  document.querySelectorAll(".opp").forEach(div => {
    const seat = +div.dataset.seat;
    const live = dealActive && turn === seat;
    setTimerEl(div.querySelector(".opp-timer"), live, live ? turnLeft : turnSeconds());
  });
  const live = dealActive && turn === mySeat;
  setTimerEl(document.getElementById("meTimer"), live, live ? turnLeft : turnSeconds());
}
function stopTurnTimer() {
  if (turnTimer) { clearInterval(turnTimer); turnTimer = null; }
  if (proxyTimer) { clearTimeout(proxyTimer); proxyTimer = null; }
}
// The clock is driven by a wall-clock DEADLINE, not by counting ticks. A
// backgrounded WebView stops firing intervals entirely, so a tick-counting clock
// silently gains however long the app was away — a player could dodge their turn
// forever by toggling out and back. With a deadline, time passes whether we're
// running or not, and a resume just re-attaches the interval (resumeTurnTimer).
function startTurnTimer() {
  turnDeadline = Date.now() + turnSeconds() * 1000;
  resumeTurnTimer();
}
function resumeTurnTimer() {
  stopTurnTimer();
  if (!turnDeadline) turnDeadline = Date.now() + turnSeconds() * 1000;
  turnLeft = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
  // Frozen while disconnected: keep the clock displayed but don't tick (a dropped
  // player must not be auto-passed). The reconnect handler restarts it.
  if (!dealActive || netPaused) { updateTimers(); return; }
  updateTimers();
  const tick = () => {
    turnLeft = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
    updateTimers();
    if (turnLeft <= 0) { stopTurnTimer(); onTurnTimeout(); }
  };
  turnTimer = setInterval(tick, 1000);
  if (turnLeft <= 0) tick();   // deadline already blew past while we were away
}
// The active seat's own client resolves the timeout first — that keeps the normal
// case exactly as before. But a locked phone runs NO javascript, so if we stopped
// there a suspended player would hang the whole table forever (their auto-pass can
// only ever come from the one client that is asleep). After a further grace window
// the elected lowest-ranked live client will act FOR them.
const PROXY_GRACE_MS = 10000;
const PROXY_STAGGER_MS = 8000;   // each further seat in line waits this much longer
function onTurnTimeout() {
  if (srvMode) return;                    // the 13 server runs the clock
  if (!dealActive || netPaused) return;   // never resolve a timeout while our link is down
  if (!online) {
    if (players[turn].isBot) return;      // local bots act via botTimer, never time out
    autoMove(turn);
    return;
  }
  if (turn === mySeat) { autoMove(mySeat); return; }
  if (players[turn] && players[turn].isBot) { scheduleBotMove(turn); return; }   // a bot never times out
  scheduleProxyMove(turn);
}
// Fallback rank among the clients that could cover `seat` (everyone seated and
// still in the room except the stalled player), lowest seat first.
function proxyRank(seat) {
  const ids = roomPlayerIds.filter((id, s) => s !== seat && presentIds.has(id));
  return ids.indexOf(myId);
}
function scheduleProxyMove(seat) {
  if (proxyTimer) { clearTimeout(proxyTimer); proxyTimer = null; }
  const rank = proxyRank(seat);
  // The lowest present seat covers first; the others follow one stagger apart.
  // A single elected cover froze the table whenever that one phone was locked —
  // a locked phone never leaves presentIds. Duplicates collapse on `ti`, and the
  // content of a cover is fixed by the engine (see applyRemoteMove), so letting
  // the next seat in line send it changes nothing but who wakes the table up.
  if (rank < 0) return;                              // not in the room → not our job
  // If we didn't watch this turn start our clock is meaningless, so we hang back a
  // whole extra turn and let the clients that DID see it go first. We still act
  // eventually: if every client rebuilt during this turn, somebody has to, or the
  // table is frozen again — which is the exact failure we're removing.
  const extra = turnTrusted ? 0 : turnSeconds() * 1000;
  const epoch = dealEpoch, moveNo = roundMoveNo;
  proxyTimer = setTimeout(() => {
    proxyTimer = null;
    // Stand down if anything moved on: the player woke up and acted, the round
    // rolled over, or we lost our link.
    if (!online || !dealActive || netPaused) return;
    if (epoch !== dealEpoch || moveNo !== roundMoveNo || turn !== seat) return;
    autoMove(seat, true);
  }, extra + PROXY_GRACE_MS + rank * PROXY_STAGGER_MS);
}
// `proxy` = we are acting on behalf of a seat that isn't ours. Every client holds
// every hand (same seed → same deal), so the forced move is identical whoever
// generates it; `seat` on the wire tells receivers who it belongs to and `ti`
// ties it to the exact turn state it was generated for.
function autoMove(seat, proxy) {
  if (!proxy) selected.clear();
  if (table) {                                       // following → forfeit the trick
    if (online) sendMove({ kind: "pass" }, seat, proxy);
    else doPass(seat);
  } else {                                            // leading → can't pass, so play a forced minimal lead
    const combo = botLead(hands[seat], firstPlay);
    if (!combo) return;
    if (online) sendMove({ kind: "play", cards: combo.cards.map(cardWire) }, seat, proxy);
    else doPlay(seat, combo);
  }
}

// opponents are seated around the table; each shows a fan of face-down cards
// (one per card held) plus their count, so you can read everyone's hand size.
const OPP_POSITIONS = { 2: ["top"], 3: ["left", "right"], 4: ["left", "top", "right"] };
function renderOpponents() {
  oppEl.innerHTML = "";
  const positions = OPP_POSITIONS[numPlayers] || ["top", "left", "right"];
  // Side seats stand where the turn line wants to be. Tell the stylesheet they
  // are there so it can keep the line inside the corridor between them instead of
  // running a long name straight through somebody's label.
  if (document.body) document.body.classList.toggle("has-side-seats", positions.indexOf("left") >= 0);
  for (let i = 1; i < numPlayers; i++) {
    const seat = (mySeat + i) % numPlayers;
    const p = players[seat];
    const cnt = (hands[seat] || []).length;   // hands may be empty before the first deal
    const pos = positions[i - 1] || "top";
    const live = turn === seat && dealActive;
    const div = document.createElement("div");
    div.className = "opp opp--" + pos + (live ? " turn" : "") + (cnt === 0 ? " done" : "");
    div.dataset.seat = seat;
    const profileTimer = document.createElement("span");
    profileTimer.className = "profile-timer opp-profile-timer";
    const avatarEl = makeAvatarEl(p.name, p.avatar, "opp-avatar", p.isBot);
    markVoiceAvatar(avatarEl, online ? roomPlayerIds[seat] : null, p.isBot);
    profileTimer.appendChild(avatarEl);
    const timer = document.createElement("span");
    timer.className = "opp-timer seat-timer" + (live ? " live" : "");
    timer.innerHTML = ringSVG();
    profileTimer.appendChild(timer);
    div.appendChild(profileTimer);
    const nameRow = document.createElement("div");
    nameRow.className = "opp-name";
    nameRow.innerHTML =
        '<span class="opp-pname">' + escapeHtml(shortName(p.name)) + "</span>" +
        '<span class="opp-score">' + p.total + "</span>";
    div.appendChild(nameRow);
    const fan = document.createElement("div");
    fan.className = "opp-fan";
    fan.innerHTML = '<div class="mini-back"></div>'.repeat(cnt);
    div.appendChild(fan);
    oppEl.appendChild(div);
  }
}
function renderTable() {
  tableComboEl.innerHTML = "";
  if (trickPlays.length) {
    tableLabelEl.textContent = "";
    const shown = trickPlays.slice(-4);   // current trick's recent plays, oldest → newest
    shown.forEach((tp, idx) => {
      const latest = idx === shown.length - 1;
      const p = players[tp.seat] || { name: "?", avatar: null, isBot: false };
      const row = document.createElement("div");
      row.className = "tp-play" + (latest ? " latest" : "");
      row.dataset.seat = tp.seat;
      const owner = document.createElement("div");
      owner.className = "tp-owner";
      owner.title = p.name;
      owner.appendChild(makeAvatarEl(p.name, p.avatar, "tp-avatar", p.isBot));
      const cards = document.createElement("div");
      cards.className = "tp-cards";
      tp.combo.cards.forEach(c => cards.appendChild(makeCardEl(c)));
      cards.appendChild(owner);
      row.appendChild(cards);   // cards only — no name, no colour
      tableComboEl.appendChild(row);
    });
  } else {
    tableLabelEl.textContent = "";
  }
  if (!dealActive) { turnLine.textContent = "—"; turnLine.className = "turn-line"; return; }
  if (turn === mySeat) { turnLine.textContent = t("yourTurn"); turnLine.className = "turn-line mine"; }
  else { turnLine.textContent = t("turnOf", shortName(players[turn].name)); turnLine.className = "turn-line"; }
}
function renderHand() {
  clearHandDropIndicator();
  handEl.innerHTML = "";
  const mine = hands[mySeat] || [];
  mine.forEach((c, i) => {
    const el = makeCardEl(c);
    if (selected.has(cardKey(c))) el.classList.add("sel");
    if (dealActive) el.addEventListener("pointerdown", (e) => beginHandDrag(e, i, el));
    el.addEventListener("click", () => {
      if (consumeSuppressedCardClick()) return;
      if (dealActive) toggleCard(c);
    });
    handEl.appendChild(el);
  });
  layoutHand();
}

// Spread the fanned cards to fill the row so each exposes the largest possible
// tap target; gaps widen automatically as the hand shrinks, and a clear gap
// opens beside selected cards so multi-card picks are easy to read.
const CARD_W = 52, SEL_GAP = 8, MIN_EXPOSED = 16;
function layoutHand() {
  const cards = [...handEl.children];
  const n = cards.length;
  if (!n) return;
  const avail = (handEl.clientWidth || 440) - 12;
  const sel = cards.map(el => el.classList.contains("sel"));
  // reserve extra width for the gap on either side of each selected card
  let extra = 0;
  for (let i = 1; i < n; i++) if (sel[i] || sel[i - 1]) extra += SEL_GAP;
  let step = n > 1 ? (avail - CARD_W - extra) / (n - 1) : 0;
  step = Math.min(CARD_W + 6, Math.max(step, MIN_EXPOSED));   // cap gap; floor overlap
  cards.forEach((el, i) => {
    let ml = i === 0 ? 0 : step - CARD_W;
    if (i > 0 && (sel[i] || sel[i - 1])) ml += SEL_GAP;
    el.style.marginLeft = ml + "px";
  });
}
window.addEventListener("resize", () => {
  if (customChatOpen) updateChatKeyboardInset();
  else layoutHand();
});
function renderControls() {
  meStatusEl.textContent = "";
  meStatusEl.className = "me-status";
  const myTurn = dealActive && turn === mySeat;
  if (pendingAction) {
    playBtn.disabled = true; passBtn.disabled = true;
    meStatusEl.textContent = t("sending");
    meStatusEl.className = "me-status";
    return;
  }
  if (!myTurn) {
    playBtn.disabled = true; passBtn.disabled = true;
    return;
  }
  const combo = classify(selectedCards());
  const legal = isLegalPlay(combo);
  playBtn.disabled = !legal;
  passBtn.disabled = !table;
}
function lowLabel() { return lowCard ? rankLabel(lowCard.r) + SUITS[lowCard.s] : "the lowest card"; }

function selectedCards() {
  const mine = hands[mySeat] || [];
  return mine.filter(c => selected.has(cardKey(c)));
}
function isLegalPlay(combo) {
  if (!combo) return false;
  if (firstPlay && !combo.cards.some(c => sameCard(c, lowCard))) return false;
  return canBeat(combo, table ? table.combo : null);
}

// ── Selection / human input ──────────────────────────────
function toggleCard(card) {
  const key = cardKey(card);
  if (selected.has(key)) selected.delete(key);
  else if (selected.size >= 5) { toast(t("max5")); return; }   // never select/raise more than 5
  else selected.add(key);
  renderHand(); renderControls();   // selection only — playing happens via the Play button
}
const HAND_DRAG_THRESHOLD = 8;
let handDrag = null;
let suppressCardClick = false;

function consumeSuppressedCardClick() {
  if (!suppressCardClick) return false;
  suppressCardClick = false;
  return true;
}

function suppressNextCardClick() {
  suppressCardClick = true;
  setTimeout(() => { suppressCardClick = false; }, 0);
}

function beginHandDrag(e, index, el) {
  if (!dealActive || pendingAction) return;
  if (e.button != null && e.button !== 0) return;
  const key = el.dataset.cardKey;
  const mine = hands[mySeat] || [];
  const keys = selected.has(key) ? mine.map(cardKey).filter(k => selected.has(k)) : [key];
  handDrag = {
    pointerId: e.pointerId,
    key,
    keys,
    fromIndex: index,
    el,
    startX: e.clientX || 0,
    startY: e.clientY || 0,
    dragging: false,
    dropIndex: -1,
  };
  if (el.setPointerCapture && e.pointerId != null) el.setPointerCapture(e.pointerId);
}

function updateHandDrag(e) {
  if (!handDrag || (handDrag.pointerId != null && e.pointerId !== handDrag.pointerId)) return;
  const x = e.clientX || 0, y = e.clientY || 0;
  const dx = x - handDrag.startX, dy = y - handDrag.startY;
  if (!handDrag.dragging) {
    if (Math.hypot(dx, dy) < HAND_DRAG_THRESHOLD) return;
    handDrag.dragging = true;
    handEl.classList.add("reordering");
    setHandDraggingCards(handDrag.keys, true);
    suppressNextCardClick();
  }
  handDrag.dropIndex = handDropIndex(handDrag.keys, x);
  updateHandDropIndicator(handDrag.keys, handDrag.dropIndex);
  moveHandDraggingCards(handDrag.keys, dx, dy);
  if (e.preventDefault) e.preventDefault();
}

function finishHandDrag(e) {
  if (!handDrag || (handDrag.pointerId != null && e.pointerId !== handDrag.pointerId)) return;
  const drag = handDrag;
  const wasDragging = drag.dragging;
  handDrag = null;
  handEl.classList.remove("reordering");
  clearHandDropIndicator();
  setHandDraggingCards(drag.keys, false);
  if (drag.el.releasePointerCapture && drag.pointerId != null) {
    try { drag.el.releasePointerCapture(drag.pointerId); } catch (_) {}
  }
  if (!wasDragging) return;
  suppressNextCardClick();
  reorderHandTo(drag.keys, drag.dropIndex >= 0 ? drag.dropIndex : handDropIndex(drag.keys, e.clientX || drag.startX));
  renderHand();
  renderControls();
  if (e.preventDefault) e.preventDefault();
}

function cancelHandDrag(e) {
  if (!handDrag || (handDrag.pointerId != null && e.pointerId !== handDrag.pointerId)) return;
  const drag = handDrag;
  handDrag = null;
  handEl.classList.remove("reordering");
  clearHandDropIndicator();
  setHandDraggingCards(drag.keys, false);
}

function handDropIndex(keys, clientX) {
  const moving = new Set(keys);
  const cards = [...handEl.children].filter(el => !moving.has(el.dataset.cardKey));
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return cards.length;
}

function clearHandDropIndicator() {
  [...handEl.children].forEach(el => el.classList.remove("drop-before", "drop-after"));
}

function updateHandDropIndicator(keys, targetIndex) {
  clearHandDropIndicator();
  const moving = new Set(keys);
  const cards = [...handEl.children].filter(el => !moving.has(el.dataset.cardKey));
  if (!cards.length) return;
  if (targetIndex >= cards.length) cards[cards.length - 1].classList.add("drop-after");
  else cards[targetIndex].classList.add("drop-before");
}

function setHandDraggingCards(keys, on) {
  const moving = new Set(keys);
  [...handEl.children].forEach(el => {
    if (!moving.has(el.dataset.cardKey)) return;
    el.classList.toggle("dragging", on);
    if (!on) el.style.transform = "";
  });
}

function moveHandDraggingCards(keys, dx, dy) {
  const moving = new Set(keys);
  [...handEl.children].forEach(el => {
    if (!moving.has(el.dataset.cardKey)) return;
    const lift = el.classList.contains("sel") ? -34 : 0;
    el.style.transform = "translate(" + dx + "px, " + (dy + lift) + "px) scale(1.04)";
  });
}

function reorderHandTo(keys, targetIndex) {
  const mine = hands[mySeat] || [];
  const moving = new Set(keys);
  const dragged = mine.filter(c => moving.has(cardKey(c)));
  if (!dragged.length) return;
  const rest = mine.filter(c => !moving.has(cardKey(c)));
  const to = Math.max(0, Math.min(targetIndex, rest.length));
  mine.length = 0;
  rest.slice(0, to).concat(dragged, rest.slice(to)).forEach(c => mine.push(c));
}

window.addEventListener("pointermove", updateHandDrag, { passive: false });
window.addEventListener("pointerup", finishHandDrag);
window.addEventListener("pointercancel", cancelHandDrag);
playBtn.addEventListener("click", humanPlay);
passBtn.addEventListener("click", () => { if (!passBtn.disabled) humanPass(); });

function humanPlay() {
  if (turn !== mySeat) return;
  const combo = classify(selectedCards());
  if (!isLegalPlay(combo)) { toast(t("invalidPlay")); return; }
  if (srvMode) { srvMove({ kind: "play", cards: combo.cards.map(cardWire) }); return; }
  selected.clear();
  if (online) sendMove({ kind: "play", cards: combo.cards.map(cardWire) });
  else doPlay(mySeat, combo);
}
function humanPass() {
  if (turn !== mySeat || !table) return;
  if (srvMode) { srvMove({ kind: "pass" }); return; }
  selected.clear();
  if (online) sendMove({ kind: "pass" });
  else doPass(mySeat);
}

// ── Engine ───────────────────────────────────────────────
function activeSeats() { return players.map((p, s) => s).filter(s => !players[s].out); }
function nextActiveAfter(seat) {
  for (let i = 1; i <= numPlayers; i++) { const s = (seat + i) % numPlayers; if (!players[s].out) return s; }
  return seat;
}
function startDeal(seed) {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (dealWaitTimer) { clearInterval(dealWaitTimer); dealWaitTimer = null; }
  // Kill every next-round timer: the deal we're applying IS the next round. A
  // countdown or a staggered fallback left running here would fire into the live
  // round and deal it a SECOND time, re-dealing everyone's cards mid-hand.
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  if (handCdInterval) { clearInterval(handCdInterval); handCdInterval = null; }
  if (handCdTimeout) { clearTimeout(handCdTimeout); handCdTimeout = null; }
  if (openRestartTimer) { clearTimeout(openRestartTimer); openRestartTimer = null; }
  dealEpoch += 1;
  awaitingDeal = false;
  roundMoveNo = 0;
  optimisticMoves = []; optimisticStale = false;   // a new round retires any in-flight move
  stopTurnTimer();
  // snapshot scores/elimination + starter context AT THE START of this round, so
  // a host checkpoint replays deterministically on reconnecting clients (replay
  // adds this round's deltas on top of these, avoiding double-counting).
  roundStartTotals = players.map(p => p.total);
  roundStartOuts = players.map(p => p.out);
  roundFirstDeal = firstDeal;
  roundLastWinner = lastWinner;
  // deal 13 only to players still in the game; eliminated seats sit out
  const active = activeSeats();
  const dealt = dealHands(seed, active.length);
  hands = players.map(() => []);
  active.forEach((s, i) => { hands[s] = dealt[i]; });
  table = null;
  passed = new Set();
  passStreak = 0;
  trickPlays = [];
  lastAction = {};
  selected.clear();
  dealActive = true;
  // auto-win: an active hand with all 13 distinct ranks (3→A + 2)
  const dragon = active.find(s => new Set(hands[s].map(c => c.r)).size === 13);
  // first deal of the game → lowest-card (3♦) holder leads; later deals → the
  // previous round's winner leads. No mandatory 3♦-inclusion on the first move.
  let starter;
  if (firstDeal) {
    starter = active[0];
    active.forEach(s => { if (cardStrength(lowestCard(hands[s])) < cardStrength(lowestCard(hands[starter]))) starter = s; });
  } else {
    starter = (lastWinner >= 0 && !players[lastWinner].out) ? lastWinner : active[0];
  }
  lowCard = lowestCard(hands[starter]);
  turn = starter;
  firstPlay = false;
  firstDeal = false;
  handOverlay.classList.remove("show");
  onlineOverlay.classList.remove("show");   // cards are in — clear the "Dealing…" cover
  render();
  if (dragon !== undefined) { toast(t("dragon", shortName(players[dragon].name))); dealActive = false; endHand(dragon, true); return; }
  beginTurn();
}

function beginTurn() {
  render();
  turnTrusted = !replayingSync;   // replay → we're reconstructing, not observing
  startTurnTimer();
  if (!dealActive) return;
  if (!online) {
    if (players[turn].isBot) botTimer = setTimeout(botAct, 750 + Math.floor(Math.random() * 500));
    return;
  }
  // Open table: a bot seat is played by the engine, broadcast as a normal stored
  // move by exactly one elected client. Never during a replay — we're
  // reconstructing history there, not producing it.
  if (!replayingSync && players[turn] && players[turn].isBot) scheduleBotMove(turn);
}
function botAct() {
  botTimer = null;
  if (!dealActive || online) return;
  const d = botDecision(turn);
  if (!d) return;
  if (d.kind === "pass") doPass(turn);
  else doPlay(turn, d.combo);
}

// ── Bot seats, online ────────────────────────────────────
// The engine's choice for `seat`, derived ONLY from replayable state (the seat's
// hand, the table, firstPlay). Every client computes the same answer, which is
// what makes a broadcast bot move verifiable: the sender does not get to pick
// the cards, the engine does — the same rule that guards a proxy cover.
function botDecision(seat) {
  const hand = hands[seat] || [];
  if (!hand.length) return null;
  const others = activeSeats().filter(s => s !== seat);
  const opponentMin = others.length ? Math.min(...others.map(s => (hands[s] || []).length)) : 13;
  const context = {
    opponentMin,
    urgent: !!table && table.seat !== seat && (hands[table.seat] || []).length <= 2,
  };
  if (!table) {
    const combo = botLead(hand, firstPlay, context);
    return combo ? { kind: "play", combo } : null;
  }
  const m = botFollow(hand, table.combo, context);
  return m ? { kind: "play", combo: m } : { kind: "pass" };
}
// One deterministic writer per bot seat: the lowest-seated human still in the
// room. Bot seats hold `null` in roomPlayerIds and are never in presentIds, so
// they can never elect themselves.
function botAuthorityId(seat) { return proxyAuthorityId(seat); }
// Our place in line to drive a bot seat: 0 = the elected relay, -1 = not at all.
// Everyone else in line follows one stagger later, so one locked phone (which
// never leaves presentIds) cannot freeze every bot at the table. A duplicate
// collapses on `ti`, and a bot move must equal the engine's own choice.
const BOT_STAGGER_MS = 5000;
function botRank(seat) {
  return roomPlayerIds.filter((id, s) => s !== seat && id != null && mayActForTable(id)).indexOf(myId);
}
function scheduleBotMove(seat) {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (!online || !dealActive || netPaused) return;
  if (!players[seat] || !players[seat].isBot || players[seat].out) return;
  if (turn !== seat) return;
  const rank = botRank(seat);
  if (rank < 0) return;                                   // not seated here → not our bot to play
  const epoch = dealEpoch, moveNo = roundMoveNo;
  botTimer = setTimeout(function () {
    botTimer = null;
    if (!online || !dealActive || netPaused) return;
    if (epoch !== dealEpoch || moveNo !== roundMoveNo || turn !== seat) return;
    if (!players[seat] || !players[seat].isBot || players[seat].out) return;
    if (botRank(seat) < 0) return;
    // Our own move is still awaiting its echo — sendMove would drop this on the
    // floor, so come back once the latch clears rather than stalling the seat.
    if (pendingAction) { scheduleBotMove(seat); return; }
    const d = botDecision(seat);
    if (!d) return;
    const mv = d.kind === "pass" ? { kind: "pass" } : { kind: "play", cards: d.combo.cards.map(cardWire) };
    mv.bot = true;
    sendMove(mv, seat, true);
  }, BOT_MOVE_MS + rank * BOT_STAGGER_MS);
}
// Nudge a bot seat that is on turn but has nobody driving it — after a replay,
// after a seat change, or after the elected authority disappeared. Idempotent.
function kickBotTurn() {
  if (!online || !dealActive || replayingSync) return;
  if (!players[turn] || !players[turn].isBot) return;
  if (botTimer) return;
  scheduleBotMove(turn);
}

function doPlay(seat, combo) {
  const hand = hands[seat];
  combo.cards.forEach(pc => { const idx = hand.findIndex(c => sameCard(c, pc)); if (idx >= 0) hand.splice(idx, 1); });
  table = { combo, seat };
  trickPlays.push({ seat, combo });
  firstPlay = false;
  passStreak = 0;                       // a play resets the consecutive-pass count
  lastAction[seat] = { kind: "play", text: comboName(combo) };
  if (hand.length === 0) { lastAction[seat] = { kind: "win", text: t("finished") }; dealActive = false; endHand(seat, false); return; }
  advanceTurn();
}
function doPass(seat) {
  passed.add(seat);
  passStreak += 1;
  lastAction[seat] = { kind: "pass", text: t("pass") };
  // No lock-out: a passer is NOT skipped on later turns. The trick ends only when
  // every OTHER active player has passed in a row since the last play.
  if (table && passStreak >= activeSeats().length - 1) { render(); clearTrick(table.seat); return; }
  advanceTurn();
}
// Hand the turn to the next active (non-eliminated) seat. Passers keep their seat
// in the rotation — they get asked again instead of being skipped for the trick.
function advanceTurn() {
  render();
  if (!dealActive) return;
  turn = nextActiveAfter(turn);
  beginTurn();
}
function clearTrick(winnerSeat) {
  table = null;
  passed = new Set();
  passStreak = 0;
  trickPlays = [];
  for (const k in lastAction) if (lastAction[k] && lastAction[k].kind !== "win") delete lastAction[k];
  turn = (players[winnerSeat] && players[winnerSeat].out) ? nextActiveAfter(winnerSeat) : winnerSeat;
  beginTurn();
}

function endHand(winnerSeat, dragon) {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  stopTurnTimer();
  // The round is over — no move can legitimately be awaiting its echo now. Clear the
  // latch so a stale pendingAction (e.g. an own-move echo dropped mid-round) can never
  // block the host's next-round hostDeal() and freeze the whole table on the last trick.
  pendingAction = false;
  lastWinner = winnerSeat;
  // losers ADD their leftover-card penalty toward the lose-at threshold
  const deltas = Array(numPlayers).fill(0);
  for (let s = 0; s < numPlayers; s++) {
    if (players[s].out || s === winnerSeat) continue;
    const n = hands[s].length;
    const ded = dragon ? 3 * n : deduction(n);
    deltas[s] = ded;
    players[s].total += ded;
  }
  // eliminate anyone who reached the threshold (the round winner added 0, stays safe)
  const newlyOut = [];
  for (let s = 0; s < numPlayers; s++) {
    if (!players[s].out && players[s].total >= loseAt) { players[s].out = true; newlyOut.push(s); }
  }
  render();   // show the winning play on the table first, so everyone sees the last trick
  if (endTimer) clearTimeout(endTimer);
  endTimer = setTimeout(function () {
    endTimer = null;
    if (activeSeats().length <= 1) showGameOver();
    else showHandOver(winnerSeat, deltas, newlyOut);
  }, 2400);
}

// ── Hand-over overlay ────────────────────────────────────
function showHandOver(winnerSeat, deltas, newlyOut) {
  newlyOut = newlyOut || [];
  document.getElementById("handTitle").textContent = winnerSeat === mySeat ? t("youWonRound") : t("wonRound", shortName(players[winnerSeat].name));
  const sb = document.getElementById("handScoreboard");
  sb.innerHTML = "";
  // lower total is safer → list best (lowest) first
  const order = players.map((p, s) => s).sort((a, b) => players[a].total - players[b].total);
  const best = Math.min(...players.filter(p => !p.out).map(p => p.total));
  order.forEach(seat => {
    const p = players[seat];
    const justOut = newlyOut.includes(seat);
    const row = document.createElement("div");
    row.className = "sb-row" + (!p.out && p.total === best ? " lead" : "");
    const tag = p.out ? '<span class="rv-foul">' + t("eliminatedTag") + "</span>" : (seat === winnerSeat ? t("wonTag") : t("cardsLeft", hands[seat].length));
    row.innerHTML =
      '<div class="sb-dot" style="background:' + p.color + (p.out ? ";opacity:.4" : "") + '"></div>' +
      '<div class="sb-name"' + (p.out ? ' style="opacity:.55"' : "") + '>' + escapeHtml(shortName(p.name)) + "</div>" +
      '<div class="sb-rank" style="width:auto;opacity:.7">' + tag + "</div>" +
      '<div class="sb-delta" style="color:' + (deltas[seat] ? "#ff9aa2" : "#7be8a8") + '">' + (deltas[seat] ? "+" + deltas[seat] : "—") + "</div>" +
      '<div class="sb-score">' + p.total + '<small> / ' + loseAt + "</small></div>";
    sb.appendChild(row);
  });
  const cd = document.getElementById("handCountdown");
  const actions = document.getElementById("handActions");
  actions.innerHTML = "";
  if (handCdInterval) clearInterval(handCdInterval);
  if (handCdTimeout) clearTimeout(handCdTimeout);

  // Big ticking countdown to the next round (5 → 4 → 3 …), shown the same way
  // online and offline so everyone sees how long until the next deal.
  let left = HAND_OVER_SECONDS;
  const renderCd = (pop) => {
    cd.innerHTML = t("nextRoundIn", '<span class="cd-num' + (pop ? " pop" : "") + '">' + left + "</span>");
  };
  renderCd(false);
  handCdInterval = setInterval(() => {
    left--;
    if (left < 0) left = 0;
    renderCd(true);
    if (left <= 0) {
      clearInterval(handCdInterval); handCdInterval = null;
      if (!online) startNextLocal();
      else scheduleNextDeal();
    }
  }, 1000);

  if (!online) {
    const next = document.createElement("button");
    next.className = "btn-next"; next.textContent = t("nextRound");
    next.addEventListener("click", startNextLocal);
    const quit = document.createElement("button");
    quit.className = "btn-quit"; quit.textContent = t("newGame");
    quit.addEventListener("click", backToSetup);
    actions.appendChild(next); actions.appendChild(quit);
  }
  handOverlay.classList.add("show");
}
function startNextLocal() {
  if (handCdInterval) clearInterval(handCdInterval);
  handOverlay.classList.remove("show");
  startDeal(randomSeed());
}
// ── Who deals the next round ─────────────────────────────
// The platform has NO host migration (multiplayer.md): if player_ids[0] locks
// their phone, leaves, or is eliminated and walks away, nobody is promoted — and
// this used to be the ONLY client allowed to deal, so the table froze on "Next
// round in 0" forever. Every client now schedules the deal, staggered by rank, and
// stands down the moment someone else's deal lands. No election, no extra state:
// the worst case is a duplicate `deal` action, which the server orders so every
// client still lands on the same round.
const DEAL_STAGGER_MS = 2500;
// Who may write on the table's behalf, in seat order. A GHOST MUST NOT BE IN
// HERE: the roster keeps naming somebody who closed the app days ago, and every
// election — the next deal, the seat claim for a newcomer, the release of an
// abandoned seat — hands the job to the lowest such seat and then waits forever
// for them to do it. That is how a live player ends up sitting opposite a name
// that never moves, unable to do anything about it: the ghost outranks them.
//
// Only open tables, and only once the room has had time to answer us — before
// that, silence proves nothing and the roster is the best we have.
function mayActForTable(id) {
  if (!presentIds.has(id)) return false;
  const settled = openTable && roomJoinedAt && Date.now() - roomJoinedAt >= GHOST_SETTLE_MS;
  return !settled || isLivePeer(id);
}
function authoritySeats() {
  return roomPlayerIds.map((id, s) => s).filter(s => mayActForTable(roomPlayerIds[s]));
}
function authorityRank() { return authoritySeats().indexOf(mySeat); }
// Primary = lowest-seated client still in the room. Falls through to the host when
// presence is unknown, so behaviour is unchanged in a healthy room.
function isPrimaryAuthority() {
  if (!online) return false;
  const seats = authoritySeats();
  if (!seats.length) return isHostPlayer();
  return seats[0] === mySeat;
}
function scheduleNextDeal() {
  if (srvMode) return;                    // the server deals the next hand
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  if (!online || dealActive) return;
  awaitingDeal = true;
  const rank = authorityRank();
  if (rank < 0) return;
  if (rank === 0) { handOverlay.classList.remove("show"); hostDeal(); return; }
  const epoch = dealEpoch;
  dealTimer = setTimeout(() => {
    dealTimer = null;
    if (!online || dealActive || epoch !== dealEpoch) return;   // someone dealt — stand down
    handOverlay.classList.remove("show");
    hostDeal();
  }, rank * DEAL_STAGGER_MS);
}
// Re-run the election, but ONLY if the table is genuinely waiting on a deal (the
// countdown already finished). Called when the room changes under us or we come
// back from the background — the client that owed the deal may be the one that
// just disappeared. Never fires during the results countdown.
function retryNextDeal() {
  if (online && gameStarted && awaitingDeal && !dealActive) scheduleNextDeal();
}
function backToSetup() {
  if (handCdInterval) clearInterval(handCdInterval);
  if (handCdTimeout) clearTimeout(handCdTimeout);
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  awaitingDeal = false;
  stopTurnTimer();
  handOverlay.classList.remove("show");
  dealActive = false;
  setupOverlay.classList.add("show");
}

// Game over: only one player has avoided the lose-at threshold — they win.
function showGameOver() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  stopTurnTimer();
  if (handCdInterval) { clearInterval(handCdInterval); handCdInterval = null; }
  if (handCdTimeout) { clearTimeout(handCdTimeout); handCdTimeout = null; }
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  awaitingDeal = false;   // the match is over — no fallback client should deal again
  handOverlay.classList.remove("show");
  dealActive = false;
  const survivors = activeSeats();
  const ranked = players.map((p, s) => s).sort((a, b) => players[a].total - players[b].total);
  const champ = survivors.length ? survivors[0] : ranked[0];
  recordOutcome(champ === mySeat);   // multiplayer-only, idempotent per match
  reportMatchResult(champ, ranked);  // host reports to the originating group or players' DMs
  document.getElementById("winnerName").textContent = champ === mySeat ? t("you") : shortName(players[champ].name);
  const sb = document.getElementById("finalScoreboard");
  sb.innerHTML = "";
  ranked.forEach(seat => {
    const p = players[seat];
    const row = document.createElement("div");
    row.className = "sb-row" + (seat === champ ? " lead" : "");
    row.innerHTML =
      '<div class="sb-dot" style="background:' + p.color + '"></div>' +
      '<div class="sb-name">' + escapeHtml(shortName(p.name)) + "</div>" +
      '<div class="sb-rank" style="width:auto;opacity:.7">' + (seat === champ ? t("survived") : t("lostTag")) + "</div>" +
      '<div class="sb-score">' + p.total + "</div>";
    sb.appendChild(row);
  });
  document.getElementById("winnerOverlay").classList.add("show");
  if (tourCtx) { tourMatchOver(champ); return; }
  scheduleOpenRestart();
}
// An open table does not really end: the champion screen sits for a few seconds
// and then the elected client deals a fresh match, so whoever is in the room
// (plus bots for the empty seats) simply keeps playing. PLAY AGAIN still works —
// it just brings the restart forward.
let openRestartTimer = null;
function scheduleOpenRestart() {
  if (srvMode) { const rs = document.getElementById("rematchStatus"); if (rs) rs.textContent = t("openRestarting"); return; }
  if (openRestartTimer) { clearTimeout(openRestartTimer); openRestartTimer = null; }
  if (!online || !openTable) return;   // a chat-invite match ends on PLAY AGAIN, not a timer
  const rank = authorityRank();
  if (rank < 0) return;
  const rs = document.getElementById("rematchStatus");
  if (rs) rs.textContent = t("openRestarting");
  openRestartTimer = setTimeout(function () {
    openRestartTimer = null;
    if (!online || dealActive) return;
    hostDeal(true);   // reset deal → every client zeroes the match and deals as one
  }, OPEN_RESTART_MS + rank * DEAL_STAGGER_MS);
}
// Play again. Offline: reset locally. Online: platform mode has no server-side
// restart event — the HOST restarts by broadcasting a normal stored `deal`
// action with reset:true (every client zeroes its match state in onDeal), and a
// non-host asks for one via Usion.game.requestRematch() (a pure broadcast: the
// other players' onRematchRequest fires, so the host sees who wants a rematch).
document.getElementById("playAgainBtn").addEventListener("click", () => {
  if (tourCtx) { tourBackToScreen(); return; }
  if (srvMode) { srvPlayAgain(); return; }
  if (online) {
    if (isPrimaryAuthority()) { hostDeal(true); return; }   // reset deal → every client restarts
    try { if (window.Usion && Usion.game && Usion.game.requestRematch) Usion.game.requestRematch(); } catch (_) {}
    const rs = document.getElementById("rematchStatus");
    if (rs) rs.textContent = t("rematchWait");
    return;
  }
  document.getElementById("winnerOverlay").classList.remove("show");
  players.forEach(p => { p.total = 0; p.out = false; });
  firstDeal = true; lastWinner = -1;
  startDeal(randomSeed());
});

// ── Table skin (green ↔ red velvet) — a per-client cosmetic, persisted ──
let skin = "green";
try { skin = localStorage.getItem("mp_skin") || "green"; } catch (e) {}
function applySkin(s) {
  skin = (s === "red") ? "red" : "green";
  document.body.classList.toggle("skin-red", skin === "red");
  try { localStorage.setItem("mp_skin", skin); } catch (e) {}
}
applySkin(skin);
document.getElementById("skinToggle").addEventListener("click", () => applySkin(skin === "green" ? "red" : "green"));

// ── Quick chat (emoji reactions + canned phrases) ────────
// A tap sends a realtime "reaction" broadcast and pops a bubble over the
// sender's seat. Purely cosmetic — no game state, never blocks play.
// NB: the emoji/phrase lists live INSIDE buildChatPicker so applyLang() can
// call it during early module init without tripping a const TDZ.
function buildChatPicker() {
  const REACTION_EMOJIS = ["😂", "😘", "😔", "😡", "😱", "😜", "😎", "🔥", "🎉", "😴", "👏", "👍"];
  const REACTION_PHRASE_KEYS = ["qcHurry", "qcBad",  "qcGotit", "qcNice", "qcWow"];
  const em = document.getElementById("chatEmojis");
  const ph = document.getElementById("chatPhrases");
  if (!em || !ph) return;
  em.innerHTML = ""; ph.innerHTML = "";
  REACTION_EMOJIS.forEach(e => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chat-emoji"; b.textContent = e;
    b.addEventListener("click", () => sendReaction("emoji", e));
    em.appendChild(b);
  });
  REACTION_PHRASE_KEYS.forEach(k => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chat-phrase"; b.textContent = t(k);
    b.addEventListener("click", () => sendReaction("text", t(k)));
    ph.appendChild(b);
  });
  const custom = document.createElement("button");
  custom.type = "button";
  custom.className = "chat-phrase chat-custom-toggle";
  custom.textContent = t("customChat");
  custom.setAttribute("aria-expanded", "false");
  custom.addEventListener("click", () => setCustomChatOpen(true, true));
  ph.appendChild(custom);
}

let chatOpen = false;
function openChatPicker() {
  const p = document.getElementById("chatPicker");
  if (!p) return;
  chatOpen = true;
  p.classList.add("show"); p.setAttribute("aria-hidden", "false");
}
function closeChatPicker() {
  const p = document.getElementById("chatPicker");
  if (!p) return;
  setCustomChatOpen(false, false);
  chatOpen = false;
  p.classList.remove("show"); p.setAttribute("aria-hidden", "true");
}
function toggleChatPicker() { chatOpen ? closeChatPicker() : openChatPicker(); }

let lastReactionAt = 0;
function normalizeChatMessage(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_CHAT_LENGTH) : "";
}
function normalizeReaction(kind, value) {
  if (kind === "emoji") return typeof value === "string" ? value.trim().slice(0, 8) : "";
  if (kind === "text") return normalizeChatMessage(value);
  return "";
}
function updateChatKeyboardInset() {
  const picker = document.getElementById("chatPicker");
  if (!picker || !customChatOpen) return;
  const viewport = window.visualViewport;
  const inset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
  setChatKeyboardInset(picker, inset + "px");
}
function setChatKeyboardInset(picker, value) {
  if (!picker) return;
  if (typeof picker.style.setProperty === "function") picker.style.setProperty("--chat-keyboard-inset", value);
  else picker.style["--chat-keyboard-inset"] = value;
}
function setCustomChatOpen(open, focusInput) {
  customChatOpen = Boolean(open);
  const picker = document.getElementById("chatPicker");
  const toggle = document.getElementById("chatToggle");
  const form = document.getElementById("customChatForm");
  const input = document.getElementById("customChatInput");
  const custom = picker && picker.querySelector(".chat-custom-toggle");
  if (picker) picker.classList.toggle("custom-mode", customChatOpen);
  if (toggle) toggle.classList.toggle("custom-mode", customChatOpen);
  if (form) form.hidden = !customChatOpen;
  if (custom) custom.setAttribute("aria-expanded", customChatOpen ? "true" : "false");
  if (customChatOpen) {
    updateChatKeyboardInset();
    // Focus inside the tap itself: mobile WebViews only raise the keyboard for a
    // focus() that runs in the user gesture, and a rAF callback is outside it.
    if (focusInput && input) {
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }
  } else {
    setChatKeyboardInset(picker, "0px");
    if (input && document.activeElement === input) input.blur();
  }
}
function sendReaction(kind, value) {
  const cleanValue = normalizeReaction(kind, value);
  if (!cleanValue) return false;
  const now = Date.now();
  if (now - lastReactionAt < 700) return false;   // throttle spam
  lastReactionAt = now;
  closeChatPicker();
  const seat = (typeof mySeat === "number" && mySeat >= 0) ? mySeat : 0;
  showReaction(seat, kind, cleanValue);
  if (srvMode) { if (srv) srv.emit("react", { kind: kind, value: cleanValue }); return true; }
  if (online && window.Usion && Usion.game && Usion.game.realtime) {
    try { Usion.game.realtime("reaction", { kind: kind, value: cleanValue }); } catch (e) {}
  }
  return true;
}

// Pop a transient bubble anchored over a seat's on-screen element. Uses a
// fixed-position layer + live bounding rects so it survives seat re-renders.
function showReaction(seat, kind, value) {
  value = normalizeReaction(kind, value);
  if (!value) return;
  const layer = document.getElementById("reactionLayer");
  if (!layer) return;
  let anchor;
  if (seat === mySeat) anchor = document.querySelector(".me-bar") || document.querySelector(".me-area");
  else anchor = oppEl.querySelector('.opp[data-seat="' + seat + '"]');
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const bubble = document.createElement("div");
  bubble.className = "reaction-bubble " + (kind === "emoji" ? "is-emoji" : "is-text");
  bubble.textContent = value;
  layer.appendChild(bubble);
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - bw - 6));
  const below = anchor.classList.contains("opp--top");   // top seat: drop the bubble below it
  let top = below ? r.bottom + 8 : r.top - bh - 8;
  top = Math.max(6, Math.min(top, window.innerHeight - bh - 6));
  bubble.style.left = left + "px";
  bubble.style.top = top + "px";
  requestAnimationFrame(() => bubble.classList.add("pop"));
  setTimeout(() => bubble.classList.add("out"), 1900);
  setTimeout(() => bubble.remove(), 2400);
}

// The chat button is only meaningful once a match is on screen — i.e. seats are
// dealt and we're past the setup/lobby overlays (works for both offline vs-bots
// and online play; gameStarted is only set on the online path).
function updateChatButton() {
  const btn = document.getElementById("chatToggle");
  if (!btn) return;
  const setup = document.getElementById("setupOverlay");
  const lobby = document.getElementById("onlineOverlay");
  const show = players.length > 0 &&
    !(setup && setup.classList.contains("show")) &&
    !(lobby && lobby.classList.contains("show"));
  btn.classList.toggle("show-btn", show);
  if (!show && chatOpen) closeChatPicker();
}

document.getElementById("chatToggle").addEventListener("click", (e) => { e.stopPropagation(); toggleChatPicker(); });
document.getElementById("customChatBack").addEventListener("click", () => setCustomChatOpen(false, false));
document.getElementById("customChatForm").addEventListener("submit", e => {
  e.preventDefault();
  const input = document.getElementById("customChatInput");
  if (input && sendReaction("text", input.value)) input.value = "";
});
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateChatKeyboardInset);
  window.visualViewport.addEventListener("scroll", updateChatKeyboardInset);
}
// Tap anywhere outside the picker closes it.
document.addEventListener("click", (e) => {
  if (!chatOpen) return;
  const p = document.getElementById("chatPicker");
  const btn = document.getElementById("chatToggle");
  if (p && !p.contains(e.target) && e.target !== btn) closeChatPicker();
});
buildChatPicker();
// NB: no load-time updateChatButton() — it reads `gameStarted`, which is
// declared later (TDZ). The button stays hidden by default (CSS) until
// render() reveals it once a match begins.

// ── Setup (local) ────────────────────────────────────────
document.querySelectorAll("#countRow .count-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#countRow .count-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    numPlayers = +btn.dataset.count;
  });
});
document.querySelectorAll("#loseRow .count-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#loseRow .count-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    loseAt = +btn.dataset.lose;
  });
});
document.getElementById("startBtn").addEventListener("click", () => {
  const myName = (document.getElementById("nameInput").value || t("you")).slice(0, 10);
  players = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({ name: i === 0 ? myName : t("botNames")[i], avatar: i === 0 ? myAvatar : null,
                   color: PLAYER_COLORS[i], isBot: i !== 0, total: 0, out: false });
  }
  online = false;
  mySeat = 0;
  firstDeal = true; lastWinner = -1;
  setupOverlay.classList.remove("show");
  meNameEl.textContent = myName;
  startDeal(randomSeed());
});

// ── Online (Usion) ───────────────────────────────────────
// Native voice, matching Muushig: opt in with a tap; every table has its own channel.
let voiceRoomId = null, voiceJoined = false;
let voiceOn = false, voiceBusy = false, voiceWanted = null, voiceLastChannel = null;
let voiceSeq = 0, voiceApiBound = null, voicePeers = [];
let voicePending = false;
let voiceClosing = null;
let voiceSpeakers = new Set();
function markVoiceAvatar(el, id, isBot) {
  if (!el) return;
  el.dataset.voiceId = !isBot && id != null ? String(id) : "";
  el.classList.toggle("is-speaking", !!el.dataset.voiceId && voiceSpeakers.has(el.dataset.voiceId));
}
function setVoiceSpeakers(ids) {
  voiceSpeakers = new Set(voiceOn && voiceWanted && !voiceClosing
    ? (ids || []).filter(id => typeof id === "string") : []);
  document.querySelectorAll(".player-avatar").forEach(el => {
    el.classList.toggle("is-speaking", !!el.dataset.voiceId && voiceSpeakers.has(el.dataset.voiceId));
  });
}
function nativeVoiceApi() {
  const v = window.Usion && Usion.call;
  try { return v && typeof v.isAvailable === "function" && v.isAvailable() ? v : null; }
  catch (_) { return null; }
}
function voiceChannelFor(id) {
  // Preserve a readable prefix and hash the full id so long room names don't collide.
  let h = 2166136261;
  const text = String(id);
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "13-" + text.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 30) + "-" + (h >>> 0).toString(36);
}
function syncVoiceButton() {
  const b = document.getElementById("voiceToggle");
  if (!b) return;
  b.hidden = !nativeVoiceApi() || ((!online || !voiceJoined || !voiceRoomId) && !voiceOn && !voiceBusy);
  b.classList.toggle("on", voiceOn);
  b.classList.toggle("busy", voiceBusy);
  b.setAttribute("aria-pressed", String(voiceOn));
  b.setAttribute("aria-busy", String(voiceBusy));
  const label = LANG === "en" ? (voiceClosing ? "Turning microphone off" : voiceBusy ? "Cancel voice connection" : voiceOn ? "Turn microphone off" : "Turn microphone on")
    : voiceClosing ? "Микрофон унтарч байна" : voiceBusy ? "Дуут холболтыг цуцлах" : voiceOn ? "Микрофон унтраах" : "Микрофон асаах";
  b.setAttribute("aria-label", label); b.title = label;
  const count = document.getElementById("voiceCount");
  if (count) { count.hidden = !voiceOn || !voicePeers.length; count.textContent = voicePeers.length; }
}
function voiceStateChanged(st) {
  if (!st) return;
  const matches = voiceWanted && st.channel === voiceWanted.channel && st.scope === voiceWanted.scope;
  // A permission prompt may complete after cancellation or after a room switch.
  if (st.on && !matches && st.channel === voiceLastChannel) {
    const v = nativeVoiceApi();
    if (v) closeNativeVoice(v);
  }
  voiceOn = !!(st.on && (matches || st.channel === voiceLastChannel));
  if (matches) voiceBusy = !!voiceClosing || st.status === "connecting" || st.status === "reconnecting";
  voicePeers = matches && Array.isArray(st.peers) ? st.peers : [];
  setVoiceSpeakers(voicePeers.filter(p => p.speaking && p.micOn !== false).map(p => p.userId));
  if (!st.on && st.status === "idle" && !voicePending) voiceWanted = null;
  syncVoiceButton();
}
function initNativeVoice() {
  const v = nativeVoiceApi();
  if (v && v !== voiceApiBound) {
    voiceApiBound = v;
    v.onChange(voiceStateChanged);
    if (typeof v.onSpeaking === "function") v.onSpeaking(setVoiceSpeakers);
  }
  syncVoiceButton();
}
function closeNativeVoice(v) {
  if (voiceClosing) return voiceClosing;
  // Keep the close request in flight until its native acknowledgement arrives.
  // Otherwise a slow old micOff could close the next micOn session.
  voiceBusy = true;
  voiceClosing = Promise.resolve().then(() => v.micOff()).then(() => {
    voiceOn = false;
  }).catch(() => {
    toast(LANG === "en" ? "Microphone shutdown was not confirmed. Tap to retry."
      : "Микрофон унтарсныг баталгаажуулж чадсангүй. Дахин дарна уу");
  }).finally(() => {
    voiceClosing = null; voiceBusy = voicePending; syncVoiceButton();
  });
  setVoiceSpeakers([]);
  syncVoiceButton();
  return voiceClosing;
}
function stopVoice() {
  const hadVoice = voiceWanted || voiceOn || voiceBusy;
  ++voiceSeq; voiceWanted = null; voiceBusy = voicePending || !!voiceClosing; voicePeers = [];
  setVoiceSpeakers([]);
  const v = nativeVoiceApi();
  if (v && hadVoice) closeNativeVoice(v);
  syncVoiceButton();
}
async function toggleVoice() {
  const v = nativeVoiceApi();
  if (!v) return;
  initNativeVoice();
  if (voiceClosing) return;
  if (voiceWanted || voiceOn || voiceBusy) { stopVoice(); return; }
  if (!online || !voiceJoined || !voiceRoomId) return;
  if (voicePending) return;
  const seq = ++voiceSeq;
  const opts = { channel: voiceChannelFor(voiceRoomId), scope: openTable ? "game" : "room" };
  voiceWanted = opts; voiceLastChannel = opts.channel; voiceBusy = voicePending = true; syncVoiceButton();
  try {
    const st = await v.micOn(opts);
    if (seq !== voiceSeq) {
      // Serialize new attempts until the old micOn has returned, so a late result
      // cannot turn a cancelled microphone back on.
      if (!voiceWanted) await closeNativeVoice(v);
      return;
    }
    if (st) voiceStateChanged(st);
  } catch (e) {
    if (seq !== voiceSeq) return;
    stopVoice();
    const denied = e && (e.code === "VOICE_MIC_DENIED" || e.code === "VOICE_DECLINED");
    toast(LANG === "en" ? (denied ? "Microphone permission was denied" : "Voice could not connect. Try again.")
      : denied ? "Микрофоны зөвшөөрөл өгсөнгүй" : "Дуу холбогдсонгүй. Дахин оролдоно уу");
  } finally {
    voicePending = false;
    if (seq === voiceSeq || !voiceWanted) voiceBusy = !!voiceClosing;
    syncVoiceButton();
  }
}
const voiceToggleEl = document.getElementById("voiceToggle");
if (voiceToggleEl) voiceToggleEl.addEventListener("click", toggleVoice);
window.addEventListener("pagehide", stopVoice);
// Keep the game fixed under browser pinch and keyboard zoom gestures.
window.addEventListener("gesturestart", e => e.preventDefault(), { passive: false });
window.addEventListener("wheel", e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
window.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
window.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0"].includes(e.key)) e.preventDefault();
});

let online = false;
// false → chat-invite room (waiting room, READY/Start, frozen roster)
// true  → no-invite open room (self-dealing, bots fill empty seats, drop-in)
// See "The two online modes" at the top of this file. Adopted from the deal /
// checkpoint so every client in a room agrees which rules it is playing under.
let openTable = false;
let myId = null, myName = "", myAvatar = null;   // display-name fallback is t("you")
let roomPlayerIds = [];
let connectedCount = 0;
let isHost = false;
let gameStarted = false;
let lastSeq = 0;
let curSeed = 0;
let moveLog = [];
let checkpointVersion = 0;
let replayingSync = false;
// Replaying moves out of a CHECKPOINT, which is different from replaying the raw
// action log. Checkpoint moves were already validated by the client that wrote
// them and carry no sender id, so they are trusted. Raw log actions are not:
// anyone can write to the log, and the log keeps what the live table rejected.
// Skipping the sender checks for both (they used to share `replayingSync`) meant
// a forged fold or cover the whole table refused was still applied by whoever
// resynced next — the same live-vs-replay split that froze the deal path.
let replayTrusted = false;
let appliedSequences = new Set();
// High-water mark: every action at or below this sequence is already baked into
// our state (it came in via a checkpoint, whose individual sequences we can't
// enumerate). Without it, applying a checkpoint wiped `appliedSequences` and a
// following sync happily re-played moves the snapshot already contained —
// duplicate cards on the table. Replay only what is PROVABLY new.
let appliedBaseSeq = 0;
let pendingAction = false;

// ── Server tables ────────────────────────────────────────
// On the Usion game host (13.games.usions.com) the online table is run by the
// 13 server (server/rooms.mjs): it shuffles, holds every hand, runs the turn
// clock and settles whoever leaves. This client only draws what it is sent and
// sends taps. The relay code above stays for the old static host and as the
// fallback when the server cannot be reached.
let srv = null;               // socket.io connection
let srvMode = false;          // the table on screen is a server table
let srvView = null;           // last { room, game } from the server
let srvWant = null;           // what to (re)ask for on every connect: { ev, data }
let srvHandNo = -1;
let srvShown = "";            // "handNo:phase" whose results screen is already up
let srvOverTimer = null;
let srvFallbackTimer = null;
let srvFailed = false;        // could not reach the server this session → relay

function srvAvailable() {
  return !srvFailed && !window.T13_NO_SERVER && typeof window.io === "function" && !!tourAuthToken();
}
function srvConnect() {
  if (srv) return srv;
  srv = window.io({
    // Read on every (re)connect: the Usion token is re-minted hourly.
    auth: function (cb) { cb({ token: tourAuthToken(), name: myName || "", avatar: myAvatar || "" }); },
    transports: ["websocket", "polling"],
  });
  srv.on("state", srvApply);
  srv.on("react", function (d) {
    if (!srvMode || !srvView || !srvView.game || !d) return;
    const seat = srvView.game.players.findIndex(p => p.id === d.from);
    if (seat >= 0) showReaction(seat, d.kind, d.value);
  });
  // The server keeps our seat for 15 s; on every connect ask for the table again
  // (a no-op when we still have it, a fresh seat after a server restart).
  srv.on("connect", function () {
    netPaused = false;
    if (srvMode && srvWant) srv.emit(srvWant.ev, srvWant.data || {});
  });
  srv.on("disconnect", function () { if (srvMode) { netPaused = true; stopTurnTimer(); } });
  srv.on("connect_error", function () { if (srvMode && !srvView) srvArmFallback(4000); });
  return srv;
}
function srvArmFallback(ms) {
  if (srvFallbackTimer) clearTimeout(srvFallbackTimer);
  srvFallbackTimer = setTimeout(function () {
    srvFallbackTimer = null;
    if (srvMode && !(srvView && srvView.game)) srvGiveUp();
  }, ms);
}
// The server never answered: play over the relay like before.
function srvGiveUp() {
  srvFailed = true;
  srvMode = false; srvWant = null;
  if (srv) { try { srv.close(); } catch (_) {} srv = null; }
  online = false; openTable = false;
  onlineOverlay.classList.remove("show");
  menuPlayOnline();
}
function srvStartOpen() {
  hideMenu();
  stopLocalRound();
  setupOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  online = true; openTable = true; srvMode = true;
  gameStarted = false; dealActive = false;
  srvView = null; srvHandNo = -1; srvShown = "";
  srvWant = { ev: "open:join" };
  const s = document.getElementById("onlineStatus");
  if (s) s.textContent = t("connecting");
  onlineOverlay.classList.add("show");
  const c = srvConnect();
  if (c.connected) c.emit("open:join", {});
  srvArmFallback(10000);
}

// Keep the player's own drag order across updates of the same hand.
function srvKeepOrder(prev, next) {
  const want = new Set(next.map(cardKey));
  const kept = (prev || []).filter(c => c && want.has(cardKey(c)));
  const have = new Set(kept.map(cardKey));
  return kept.concat(next.filter(c => !have.has(cardKey(c))));
}

function srvApply(st) {
  if (!srvMode || !st) return;
  const g = st.game;
  if (!g) return;                      // between tables; the connect handler asks again
  srvView = st;
  if (srvFallbackTimer) { clearTimeout(srvFallbackTimer); srvFallbackTimer = null; }
  onlineOverlay.classList.remove("show");
  gameStarted = true;

  const newHand = g.handNo !== srvHandNo;
  if (newHand) {
    if (g.handNo === 1) { statsRecordedThisGame = false; resultReportedThisGame = false; }
    selected.clear();
    if (handCdInterval) { clearInterval(handCdInterval); handCdInterval = null; }
    if (handCdTimeout) { clearTimeout(handCdTimeout); handCdTimeout = null; }
    if (srvOverTimer) { clearTimeout(srvOverTimer); srvOverTimer = null; }
    handOverlay.classList.remove("show");
    if (g.phase === "playing") document.getElementById("winnerOverlay").classList.remove("show");
  }
  const sameHand = !newHand;
  srvHandNo = g.handNo;

  numPlayers = g.players.length;
  mySeat = g.mySeat >= 0 ? g.mySeat : 0;
  loseAt = g.loseAt;
  roomPlayerIds = g.players.map(p => (p.isBot ? null : p.id));
  players = g.players.map((p, i) => ({
    name: p.isBot ? botSeatName(i) : (p.name || t("playerN", i + 1)),
    avatar: p.isBot ? null : normalizeAvatar(p.avatar),
    isBot: !!p.isBot, total: p.total, out: !!p.out, color: PLAYER_COLORS[i],
  }));
  hands = g.players.map((p, i) => {
    if (g.reveal) return g.reveal[i].map(wireCard);
    if (i === g.mySeat) { const mine = g.myHand.map(wireCard); return sameHand ? srvKeepOrder(hands[i], mine) : mine; }
    return Array.from({ length: p.count }, () => ({ r: 0, s: 0 }));
  });
  const mineKeys = new Set((hands[mySeat] || []).map(cardKey));
  [...selected].forEach(k => { if (!mineKeys.has(k)) selected.delete(k); });

  table = g.table ? { seat: g.table.seat, combo: classify(g.table.cards.map(wireCard)) } : null;
  trickPlays = (g.trickPlays || []).map(tp => ({ seat: tp.seat, combo: classify(tp.cards.map(wireCard)) }));
  lastAction = {};
  Object.keys(g.lastAction || {}).forEach(k => {
    const a = g.lastAction[k];
    lastAction[k] = a.kind === "play" ? { kind: "play", text: comboName(classify(a.cards.map(wireCard))) }
      : a.kind === "pass" ? { kind: "pass", text: t("pass") }
      : a.kind === "win" ? { kind: "win", text: t("finished") }
      : { kind: "pass", text: t("leftGame") };
  });
  turn = g.turn;
  firstPlay = false; lowCard = null;
  dealActive = g.phase === "playing";

  stopTurnTimer();
  if (dealActive && !netPaused) {
    turnDeadline = Date.now() + Math.max(0, Number(st.room && st.room.deadline) || 0);
    turnTrusted = true;
    resumeTurnTimer();
  } else {
    turnDeadline = 0;
  }
  render();

  // Results: the last trick stays on the table a moment, then the screen comes
  // up. The server deals the next hand (or restarts the table) on its own clock.
  const key = g.handNo + ":" + g.phase;
  if ((g.phase === "hand" || g.phase === "over") && srvShown !== key) {
    srvShown = key;
    const lh = g.lastHand, handNo = g.handNo;
    if (srvOverTimer) clearTimeout(srvOverTimer);
    srvOverTimer = setTimeout(function () {
      srvOverTimer = null;
      const now = srvView && srvView.game;
      if (!srvMode || !now || now.handNo !== handNo) return;
      if (now.phase === "over") showGameOver();
      else if (lh) showHandOver(lh.winner, lh.deltas, lh.newlyOut);
    }, 2400);
  }
}

function srvMove(mv) {
  if (!srv || !srv.connected || !srvView || !srvView.game || pendingAction) return;
  mv.moveNo = srvView.game.moveNo;
  pendingAction = true; renderControls();
  srv.timeout(8000).emit("move", mv, function (err, r) {
    pendingAction = false;
    if (err || !r || r.error) {
      // "stale": the clock moved for us a moment ago; the new state is on its way.
      if (!(r && r.error === "stale")) toast(t("moveFail"));
      renderControls();
      return;
    }
    selected.clear();
    render();
  });
}
// An open table restarts by itself a few seconds after the champion screen.
function srvPlayAgain() {
  const rs = document.getElementById("rematchStatus");
  if (rs) rs.textContent = t("openRestarting");
}

// Moves we have already played on our own board but the relay has not echoed
// back yet. Waiting for that echo costs a full round trip on EVERY tap, which is
// what makes a two-player game feel sluggish — so we apply our own move (and any
// bot move we relay) the moment it is sent, and recognise the echo as a no-op
// when it arrives. Each entry is { ti, key, at }.
let optimisticMoves = [];
let optimisticStale = false;    // an echo is overdue → let a same-sequence checkpoint correct us
const playerMeta = {};
// ── Lobby (waiting room): who's connected + their ready state, pre-game ──
const presentIds = new Set();   // player ids currently in the room (connected)
// Players whose seat we have already handed back to a bot. The server's
// `player_ids` roster is frozen once a match starts, so it still lists them — and
// a roster echo would otherwise mark them present again, put them back in the
// queue for a seat, and hand them the very bot seat they just vacated. Only a
// join event that NAMES them counts as actually coming back.
const releasedIds = new Set();
// Waiting-room state. Used by the chat-invite mode only — an open room has no
// READY gate, because nobody waits.
let lobbyReady = {};            // id → bool ready flag
let myReady = false;            // my own ready toggle

// ── Usion capabilities: cloud stats · leaderboard · checkpoint ──
// All wrappers are defensive: missing modules / standalone preview must never
// throw (a thrown error in init blanks the game). They no-op gracefully.
let myStats = { wins: 0, losses: 0, games: 0 };
let statsRecordedThisGame = false;
const STATS_KEY = "mp13:stats";

function isHostPlayer() {
  return online && Array.isArray(roomPlayerIds) && roomPlayerIds.length > 0 && roomPlayerIds[0] === myId;
}

// Cross-device stats: prefer Cloud KV, fall back to localStorage cache.
async function loadStats() {
  try {
    if (window.Usion && Usion.cloud) {
      const remote = await Usion.cloud.get(STATS_KEY);
      if (remote && typeof remote === "object") {
        myStats = Object.assign(myStats, remote);
        try { localStorage.setItem(STATS_KEY, JSON.stringify(myStats)); } catch (_) {}
        return;
      }
    }
  } catch (_) {}
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) myStats = Object.assign(myStats, JSON.parse(raw));
  } catch (_) {}
}

function persistStats() {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(myStats)); } catch (_) {}
  try { if (window.Usion && Usion.cloud) Usion.cloud.set(STATS_KEY, myStats); } catch (_) {}
}

function submitLeaderboard() {
  try {
    if (window.Usion && Usion.leaderboard) {
      // Score = total cumulative wins; ranked highest-first. (Needs leaderboard.enabled on the service.)
      Usion.leaderboard.submit(myStats.wins);
    }
  } catch (_) {}
}

// Record MY outcome exactly once per multiplayer match (idempotent across paths).
function recordOutcome(iWon) {
  if (statsRecordedThisGame || !online) return;
  statsRecordedThisGame = true;
  myStats.games += 1;
  if (iWon) {
    myStats.wins += 1;
  } else {
    myStats.losses += 1;
  }
  persistStats();
  submitLeaderboard();
  try { if (window.Usion && Usion.cloud && Usion.cloud.shared) Usion.cloud.shared.incr("games_total", 1); } catch (_) {}
}

// Report the authoritative 2–4 player result once. Explicit standings make the
// lower-is-better penalty system unambiguous. Usion routes the card to the
// originating group chat or to the players' DMs automatically.
let resultReportedThisGame = false;
function reportMatchResult(champSeat, rankedSeats) {
  if (resultReportedThisGame || srvMode) return;   // no Usion room behind a server table
  // Primary authority, not strictly the host: while the host is present that IS
  // the host (seat 0), but an eliminated host who walked away must not take the
  // result card with them.
  if (!online || !isPrimaryAuthority()) return;
  if (!Array.isArray(roomPlayerIds) || roomPlayerIds.length < 2 || roomPlayerIds.length > 4) return;
  const champ = Number(champSeat);
  if (!Number.isInteger(champ) || champ < 0 || champ >= roomPlayerIds.length) return;
  // A bot can win an open table. There is no platform identity to hand the result
  // card to, so simply don't file one — the winner screen still shows the bot.
  if (roomPlayerIds[champ] == null) return;
  if (!window.Usion || !Usion.game || typeof Usion.game.reportResult !== "function") return;

  // Champion first, then the final lower-penalty ranking. This keeps a forfeit
  // winner first even when a folded player happened to have fewer penalty points.
  const forfeitedSeats = players
    .map((p, seat) => ({ p, seat }))
    .filter(({ p, seat }) => seat !== champ && p && p.out && p.total < loseAt)
    .map(({ seat }) => seat);
  const orderedSeats = [champ];
  for (const seat of Array.isArray(rankedSeats) ? rankedSeats : []) {
    const s = Number(seat);
    if (Number.isInteger(s) && s >= 0 && s < roomPlayerIds.length &&
        !forfeitedSeats.includes(s) && !orderedSeats.includes(s)) orderedSeats.push(s);
  }
  for (let s = 0; s < roomPlayerIds.length; s++) {
    if (!forfeitedSeats.includes(s) && !orderedSeats.includes(s)) orderedSeats.push(s);
  }
  for (const seat of forfeitedSeats) if (!orderedSeats.includes(seat)) orderedSeats.push(seat);

  const payload = { winnerId: roomPlayerIds[champ] };
  // Standings and scores name PLAYERS, so bot seats drop out of both.
  const humanStandings = orderedSeats.map(seat => roomPlayerIds[seat]).filter(id => id != null);
  if (humanStandings.length > 2) payload.standings = humanStandings;

  // Normal elimination: penalty totals are meaningful (lower is better).
  // Forfeit/fold: omit them because they did not determine the placement.
  const hasForfeit = forfeitedSeats.length > 0;
  if (!hasForfeit) {
    const scores = {};
    for (let seat = 0; seat < roomPlayerIds.length; seat++) {
      if (roomPlayerIds[seat] == null) continue;
      if (players[seat] && Number.isFinite(Number(players[seat].total))) {
        scores[roomPlayerIds[seat]] = Number(players[seat].total);
      }
    }
    if (Object.keys(scores).length) {
      payload.scores = scores;
      payload.metric = "penalty points";
    }
  }

  resultReportedThisGame = true;
  try {
    Usion.game.reportResult(payload).catch(function () {});
  } catch (_) { /* result delivery must never block the winner screen */ }
}

// Persist the authoritative round state so a reconnecting/returning client
// rebuilds from it instead of replaying the whole turn-log from zero.
//
// ⚠️ Written by WHOEVER JUST ACTED (the mover / the dealing host) — NOT only the
// room host. A host-only checkpoint goes STALE the moment the host backgrounds:
// while the host is away an opponent's move is never snapshotted (only the host
// used to write it), so on recovery everyone rebuilds from a checkpoint that's
// missing that move and it's silently lost (the move you see on the table
// reverts). The actor always holds current state (it just played), so its
// checkpoint is fresh regardless of who's backgrounded. Callers gate WHO writes.
// The full snapshot needed to rebuild the live round from scratch: deal seed,
// seating order, this round's moves so far, and the round-start scores/starter
// context (so replay re-derives the same lead and adds penalties on the correct
// baseline). Used both for the server checkpoint and for peer state-pushes.
function currentCheckpoint() {
  return {
    seed: curSeed, order: roomPlayerIds, moves: moveLog.slice(),
    totals: roundStartTotals, outs: roundStartOuts,
    firstDeal: roundFirstDeal, lastWinner: roundLastWinner,
    loseAt: loseAt,          // host's elimination threshold, so reconnects/late joiners match
    open: openTable,         // which of the two modes this room runs — never inferred locally
    tour: tourTag(),         // a tournament table says so: an open-table client must not stay
    names: nameMap(),
    avatars: avatarMap(),
    // Freshness is the SERVER's action sequence, never a wall clock: `version`
    // used to be Date.now(), which is compared ACROSS DEVICES — a few seconds of
    // clock skew (routine on phones) made a stale snapshot look newer than a live
    // one, or a fresh one get rejected. `seq` is server-issued and monotonic.
    version: lastSeq,
    seq: lastSeq          // the action sequence this snapshot already includes
  };
}
// Is an incoming snapshot ahead of what we already applied? Prefer the server
// sequence; fall back to `version` only when a peer didn't send one (older build,
// whose version is a Date.now() timestamp and therefore incomparable to ours).
function snapshotIsNewer(state) {
  const seq = Number(state && state.seq);
  if (Number.isFinite(seq)) return seq > lastSeq;
  return Number((state && state.version) || 0) > checkpointVersion;
}
function writeCheckpoint() {
  // Our log holds a move the relay has not sequenced yet, so a snapshot of it
  // would tell a rebuilding client to replay a move that may never exist.
  if (optimisticMoves.length) return;
  try {
    if (window.Usion && Usion.game && Usion.game.setState) {
      const checkpoint = Usion.game.setState(currentCheckpoint());
      if (checkpoint && checkpoint.then) {
        checkpoint.then(res => {
          // STALE_STATE means the server has moves we haven't applied — we are
          // behind. The SDK contract is to resync, never to retry the write.
          if (res && res.success === false && res.code === "STALE_STATE") {
            try { Usion.game.requestSync(lastSeq); } catch (_) {}
          }
        }).catch(() => {});
      }
    }
  } catch (_) {}
}

// Peer recovery: when a player (re)joins, a present player PUSHES the current
// state to them over the room broadcast (realtime). A returning player's OWN
// sync round-trip can silently fail after a socket cycle (host recovers, but a
// non-host could sit on stale state forever) — but the room broadcast still
// reaches them once they've rejoined, so this is a reliable second path. Only
// the host pushes, to avoid a push storm in 3–4p; the host is the authority and
// is present whenever a non-host returns.
function broadcastStatePush() {
  if (!online || !dealActive || !isPrimaryAuthority()) return;
  if (optimisticMoves.length) return;   // see writeCheckpoint
  try {
    if (window.Usion && Usion.game && Usion.game.realtime) Usion.game.realtime("state_push", currentCheckpoint());
  } catch (_) {}
}
// Apply a pushed/synced snapshot if it's newer than what we already have.
function applyStateSnapshot(state) {
  if (!state || state.seed === undefined || !Array.isArray(state.order)) return;
  if (!gameStarted || snapshotIsNewer(state)) applyCheckpoint(state);
}

// An open table's seat order carries `null` for every seat a bot is holding, so
// only the human ids have to be unique — and at least one of them must exist.
function validSeatOrder(order) {
  if (!Array.isArray(order) || order.length < 2 || order.length > 4) return false;
  const ids = order.filter(id => id != null);
  if (!ids.length) return false;
  return new Set(ids).size === ids.length;
}

function sameSeatOrder(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((id, i) => id === b[i]);
}
// An open table's roster legitimately changes mid-match (bot ↔ human, and a
// player who was released while away comes back to a DIFFERENT seat), so a
// recovery snapshot can no longer be required to match ours seat for seat — that
// rule locked a returning player out of the round for good. What still bounds a
// forged roster is unchanged: a peer's state_push is only read when it comes from
// the elected authority (onNetRealtime), and any snapshot must be strictly newer
// than what we have already applied (snapshotIsNewer).
function seatOrderCompatible(next) {
  return validSeatOrder(next) && Array.isArray(roomPlayerIds) &&
    (!roomPlayerIds.length || next.length === roomPlayerIds.length);
}

// The room's authoritative state no longer seats us: we were away long enough for
// the table to release our seat back to a bot, and it may already belong to
// somebody else. Clinging to it is what splits a table in two — every move the
// room makes for that seat is one we reject, forever. So drop back to the waiting
// state and let the table's own reconcileOpenSeats deal us in again.
function becomeUnseated() {
  if (!openTable) return;              // a chat-invite roster never reassigns a seat
  stopLocalRound();
  gameStarted = false;
  dealActive = false;
  players = []; hands = []; moveLog = [];
  table = null; trickPlays = []; lastAction = {};
  handOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  showNotSeated();
  startSeatPoll();
  render();
}
// We have no seat in this match. In a chat-invite room that is final for the
// match — the host started without us. In an open room it just means all four
// seats are human right now, so sit tight: the next one to free up is ours
// (startSeatPoll keeps asking).
function showNotSeated() {
  if (!gameStarted) mySeat = -1;   // we hold no seat — renderers must not draw one
  onlineOverlay.classList.add("show");
  const status = document.getElementById("onlineStatus");
  if (status) status.textContent = openTable ? t("openWaitSeat") : t("startedWithoutYou");
  // …unless we are on the clock to deal this table ourselves, in which case
  // "waiting for a seat" is no longer what is happening. The seat poll runs this
  // every 1.5s, so without it the countdown would only ever flicker.
  renderOpenWaitStatus();
}

// Rebuild the current round from a host checkpoint (received as game_state on a
// reconnect/join). Restores round-start state, re-deals the same seed, then
// replays the round's moves so the board matches everyone else's. Returns true
// if a valid checkpoint was applied.
function applyCheckpoint(state) {
  if (!state || typeof state !== "object" || state.seed === undefined || !validSeatOrder(state.order)) return false;
  if (strayInTournamentRoom(state)) return false;
  if (tourCtx && !tourSeatsOk(state.order, state.open)) return false;
  if (state.order.indexOf(myId) < 0) {
    // Whatever else we do with it, this snapshot tells us the shape of the table
    // we are queuing at — and a `null` in it means a bot is holding a seat, so one
    // is coming free for us and we should stay put rather than wander off.
    if (openTable) lastSeenOrder = state.order.slice();
    // Not in this snapshot's roster. Before the match that means the host started
    // without us (chat invite) or all four seats are human (open room).
    if (!gameStarted || !openTable) { showNotSeated(); return false; }
    // Mid-match it means one of two very different things. A snapshot that is
    // BEHIND us simply predates our (re)seating — acting on it would throw away a
    // seat we do hold. A snapshot that is genuinely AHEAD of everything we have
    // applied is the room telling us our seat is gone, and arguing with it strands
    // us in a private copy of the round.
    const cpSeq = Number(state.seq);
    const ahead = Number.isFinite(cpSeq) ? cpSeq > syncResumePoint() : snapshotIsNewer(state);
    if (ahead) becomeUnseated();
    return false;
  }
  // A live match has frozen seating. A checkpoint may restore that match, but it
  // must never be able to replace its roster (including via a forged state_push).
  // A chat-invite match has a frozen roster, so a snapshot may not change it at
  // all. An open room's roster legitimately moves, so only the weaker check
  // applies there — see seatOrderCompatible.
  if (gameStarted && !(openTable ? seatOrderCompatible(state.order) : sameSeatOrder(state.order, roomPlayerIds))) return false;
  applyNames(state.names);                              // host-supplied identities before seating
  applyAvatars(state.avatars);
  if (!gameStarted && !startOnlineGame({ order: state.order })) return false;
  // An open room's roster moves while we are away, so the seats' identities have
  // to follow the snapshot's order, not just the order itself. Keeping a stale
  // isBot/name made this client disagree with everyone else about which seat a
  // newcomer takes (takeoverSeat reads isBot) and split the table. Somebody the
  // snapshot no longer seats has left: drop them from presence too, exactly as
  // seatBot() would have if we had seen the seat_release live.
  if (gameStarted && openTable) {
    const prev = roomPlayerIds.slice();
    state.order.forEach((id, s) => {
      if (!players[s]) return;
      if (id == null) {
        if (!players[s].isBot) { players[s].isBot = true; players[s].name = botSeatName(s); players[s].avatar = null; }
      } else if (players[s].isBot || prev[s] !== id) {
        players[s].isBot = false;
        const meta = playerMeta[id] || {};
        players[s].name = meta.name || (id === myId ? (myName || t("you")) : t("playerN", s + 1));
        players[s].avatar = normalizeAvatar(meta.avatar) || (id === myId ? myAvatar : null);
      }
    });
    prev.forEach(id => {
      if (id != null && id !== myId && state.order.indexOf(id) < 0) { presentIds.delete(id); releasedIds.add(id); clearForfeitGrace(id); }
    });
  }
  roomPlayerIds = state.order.slice();
  numPlayers = roomPlayerIds.length;
  mySeat = roomPlayerIds.indexOf(myId);
  // restore round-start scores/elimination (startOnlineGame zeroes them), then
  // replaying the moves re-applies this round's penalties exactly once.
  if (Array.isArray(state.totals)) state.totals.forEach((total, s) => {
    const value = Number(total);
    if (players[s] && Number.isFinite(value) && value >= 0) players[s].total = value;
  });
  if (Array.isArray(state.outs)) state.outs.forEach((o, s) => { if (players[s]) players[s].out = o === true; });
  firstDeal = !!state.firstDeal;
  lastWinner = (typeof state.lastWinner === "number") ? state.lastWinner : -1;
  if (Number.isFinite(state.loseAt) && state.loseAt > 0) loseAt = state.loseAt;   // adopt host's elimination threshold
  if (typeof state.open === "boolean") openTable = state.open;   // the ROOM decides which mode it runs
  if (tourCtx) openTable = false;                                // …except a tournament table: never open
  curSeed = state.seed;
  moveLog = [];
  optimisticMoves = []; optimisticStale = false;   // the snapshot is the truth now
  onlineOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  startDeal(state.seed);                                 // same seed → same hands & lead
  checkpointVersion = Number(state.version || checkpointVersion || 0);
  appliedSequences = new Set();
  const cpSeq = Number(state.seq);
  if (Number.isFinite(cpSeq)) {
    appliedBaseSeq = cpSeq;
    lastSeq = Math.max(lastSeq, cpSeq);   // else a later requestSync(lastSeq) re-sends what we just applied
  }
  replayingSync = true;
  replayTrusted = true;
  (state.moves || []).forEach(mv => applyRemoteMove(mv));
  replayTrusted = false;
  replayingSync = false;
  // We just rebuilt the whole round from authoritative state, so nothing can
  // still be legitimately awaiting its echo. Checkpoint moves carry no sender id,
  // so the usual "my own move came back" release in applyRemoteMove cannot fire
  // for them — without this, a move recovered THROUGH a checkpoint would leave us
  // latched on "Sending…" forever. Re-sending after a false clear is harmless:
  // roundMoveNo has moved on, so the duplicate is dropped on `ti`.
  pendingAction = false;
  renderControls();
  kickBotTurn();   // we may have rebuilt straight into a bot's turn
  return true;
}
// Have we already applied this action sequence? Either explicitly, or implicitly
// because a checkpoint at/above it rebuilt our state.
function alreadyApplied(seq) {
  if (seq === undefined) return false;
  const n = Number(seq);
  if (!Number.isFinite(n)) return false;
  return n <= appliedBaseSeq || appliedSequences.has(n);
}
// Where a catch-up has to resume from: the highest point with NO holes below it.
// `lastSeq` is not that — it advances the moment an action is SEEN, even one we
// could not apply. A client that missed actions 8-19 and then received 20 has
// lastSeq 20, so requestSync(lastSeq) asks for "everything after 20" and the gap
// is gone for good. Walking the applied set instead asks from 7, where our state
// actually ends.
function syncResumePoint() {
  let n = appliedBaseSeq;
  while (appliedSequences.has(n + 1)) n++;
  return n;
}

// Legacy hint: some hosts pass a "play with bots"/solo ref or path. Kept only as
// a fallback signal inside launchedSolo (below) for SDKs that don't expose mode.
function isBotsLaunch(config) {
  try {
    let lp = {};
    if (window.Usion && typeof Usion.getLaunchParams === "function") lp = Usion.getLaunchParams() || {};
    const hint = [config && config.ref, config && config.launchPath, lp.ref, lp.path]
      .filter(Boolean).join(" ").toLowerCase();
    return /\b(bot|bots|solo|practice|single|ai|offline)\b/.test(hint);
  } catch (_) { return false; }
}

// Did the platform open us solo (GameTok / Explore) rather than a real chat
// game-invite? Trust the launch MODE — never infer from roomId alone, because a
// solo launch may still be handed an auto-created (standalone_) room for SDK
// plumbing (gametok.md / sdk-reference). Only a 'multiplayer' launch goes online.
function launchedSolo(config) {
  try {
    let lp = {};
    if (window.Usion && typeof Usion.getLaunchParams === "function") lp = Usion.getLaunchParams() || {};
    if (lp.mode === "single") return true;
    if (lp.mode === "multiplayer") return false;
    // SDK without the mode field: boolean shortcut, then the legacy bot/solo hint,
    // then "only a non-standalone roomId is a real multiplayer room".
    if (window.Usion && Usion.game && typeof Usion.game.isMultiplayer === "function")
      return !Usion.game.isMultiplayer();
    if (isBotsLaunch(config)) return true;
    const rid = config && config.roomId ? String(config.roomId) : "";
    return !rid || /^standalone[_-]/i.test(rid);
  } catch (_) { return false; }
}

if (window.Usion && Usion.init) {
  try {
    Usion.init(async function (config) {
      applyLang(detectLang());   // the platform's language setting is known now
      myId = config.userId;
      initNativeVoice();
      if (config.userName) myName = config.userName;
      if (config.userAvatar) myAvatar = normalizeAvatar(config.userAvatar);
      if (config.playerIds) roomPlayerIds = config.playerIds.slice();   // platform-provided roster (playerIds[0] = host)
      playerMeta[myId] = { name: myName || t("you"), avatar: myAvatar };
      presentIds.add(myId);
      loadStats(); // fire-and-forget; never block init/render
      syncClock(); // the tournament's clock offset (fire-and-forget)
      // Registered up front REGARDLESS of launch mode: a solo launch can be
      // promoted into a live room mid-session via the host's Share button.
      try {
        if (Usion.game && Usion.game.onRoomAssigned) Usion.game.onRoomAssigned(function () { onRoomPromoted(); });
      } catch (_) {}
      // Which of the two online modes are we in? It is the LAUNCH that decides:
      //   chat game-invite (mode 'multiplayer') → waiting room, READY + Start,
      //     frozen roster: exactly the people who were invited play.
      //   no invite (mode 'single', from Explore or the GameTok feed) → the open
      //     room: 4 seats, bots in the empty ones, deals itself, anyone can drop
      //     in mid-round by taking over the weakest bot.
      // Without a roomId at all (self-hosted preview) there is nothing to join,
      // so fall back to a purely local table.
      setupOverlay.classList.remove("show");
      if (config.roomId && !launchedSolo(config)) {
        // Chat invite → straight into the private room the invite created.
        openTable = false;
        online = true;
        hideMenu();
        onlineOverlay.classList.add("show");
        await setupMultiplayer(config.roomId);
      } else {
        // No invite → the player picks: Online (shared public table), vs bots
        // (private, you + 3 bots), or Invite a friend (picker → waiting room).
        launchRoomId = config.roomId || null;
        showMenu();
        // A tap on a champion's News Feed post lands here.
        try {
          const lp = (Usion.getLaunchParams && Usion.getLaunchParams()) || {};
          tourResumeOnLaunch(/^\/tournament(\/|$)/.test(String(lp.path || "")));
        } catch (_) {}
      }
    });
  } catch (e) { /* standalone preview */ }
}

// ── Foreground catch-up ──────────────────────────────────────────────────
// While the app/iframe is backgrounded the WebView is suspended: our turn clock
// freezes and any move the host relays in that window is dropped (postMessage to
// a frozen WebView). Nothing in the platform reliably tells us we missed it —
// so on return we'd sit on stale state (you see the opponent's old card; they
// see your turn) until a full exit+rejoin.
//
// Recovery rule: ask the server to replay everything AFTER OUR OWN last-applied
// sequence (lastSeq) — NOT from 0 (which would re-walk old rounds) and NOT from
// the host's checkpoint alone (it only holds the HOST's view; a non-host move
// made while the host was away isn't in it — the missing move lives in the
// action log). requestSync(lastSeq) returns the host checkpoint PLUS the action
// log past our point, so we replay exactly what we missed. Idempotent.
// Coming back from a paused link: the turn clock owes us the time we spent
// disconnected (we must not be auto-passed for a gap we couldn't play through),
// but NOT the time we merely spent backgrounded with a live connection.
function resumeFromPause() {
  if (netPaused && pausedAt) turnDeadline += Date.now() - pausedAt;
  pausedAt = 0;
  netPaused = false;
}
function foregroundResync() {
  if (!online || !gameStarted) return;
  resumeFromPause();
  try {
    if (window.Usion && Usion.game) {
      if (Usion.game.requestSync) Usion.game.requestSync(lastSeq);
      if (Usion.game.realtime) Usion.game.realtime("request_state", {});
    }
  } catch (_) {}
  // resume, never restart: the deadline is wall-clock, so a player can't win extra
  // thinking time by toggling out of the app and back.
  if (dealActive) { resumeTurnTimer(); render(); }
  retryNextDeal();   // we may have owed everyone the next deal while we were away
}

// On resume the host socket can take several seconds to reconnect + rejoin the
// room; a few fixed retries can ALL fire during that gap and get no response
// (observed: 5× requestSync, 0× sync back). So keep requesting until our own
// sequence actually advances (a response landed) or we hit a long timeout.
var _resyncBaseSeq = -1;
var _resyncDeadline = 0;
function beginResync(reason) {
  turnTrusted = false;   // we were frozen/dropped — our view of the active player's clock is meaningless
  // Re-announce ourselves. A resync is a REQUEST — it makes no sound the others
  // can hear — so a client coming back from a freeze is, to everybody else, still
  // a seat that has said nothing since they arrived. Saying so out loud is what
  // keeps a sleeper's seat from being handed to a bot the moment they wake.
  try { if (online && window.Usion && Usion.game && Usion.game.realtime) sendPlayerInfo(); } catch (_) {}
  _resyncBaseSeq = lastSeq;
  // Keep trying for ~60s: with the host zombie-socket fix this resolves almost
  // immediately; WITHOUT it, a dead socket only self-heals via Socket.IO's own
  // ping-timeout (~45s), so we must outlast that to recover at all.
  _resyncDeadline = Date.now() + 60000;
  pumpResync();
}
function pumpResync() {
  if (!online || !gameStarted) return;
  if (lastSeq > _resyncBaseSeq) return;   // caught up
  if (Date.now() > _resyncDeadline) return;
  foregroundResync();
  setTimeout(pumpResync, 1200);
}

// Web fires visibilitychange on tab refocus — use it there.
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") beginResync("visible");
  });
}

// Mobile: React Native WebViews do NOT fire visibilitychange on app
// background/foreground, so the line above never runs in the Usion app. Detect
// the resume from the wall clock instead: a 1s heartbeat that sees a big jump
// means our JS was frozen (we were backgrounded). The host socket may still be
// reconnecting/rejoining the room on return, so retry the sync a few times over
// the next few seconds until our state catches up.
(function resumeWatchdog() {
  var lastBeat = Date.now();
  setInterval(function () {
    var now = Date.now();
    var gap = now - lastBeat;
    lastBeat = now;
    if (gap > 3000 && online && gameStarted && !srvMode) {
      beginResync("gap=" + Math.round(gap / 1000) + "s");
    }
  }, 1000);
})();

// ── Catch-up of last resort ──────────────────────────────────────────────
// Every OTHER resync trigger we have is an event: visibilitychange, the freeze
// watchdog above, or onReconnect. So a message lost while the socket stays up
// and the app stays in the foreground has no recovery path at all — and for our
// own action's echo that is permanent: pendingAction never clears, Play and Pass
// stay dead for the rest of the round, and hostDeal()/sendMove() both bail while
// it is set. These two nets close that hole without adding steady traffic:
// nothing here fires in a healthy game.
// ── The bot-fill deadline ────────────────────────────────
// An open table is supposed to deal in under a second, and every mechanism above
// exists to get the player into a REAL game with REAL people first. Each of them
// prefers to wait a little longer: the election defers to a table that looks
// live, the hop defers to a bot seat that is coming free, the stuck check goes
// off to look at another table. Individually each is right. Together they can
// loop — three people circling the ladder, each politely waiting for the others,
// nobody ever dealing — and the player just sees a spinner.
//
// So this clock is the one that never yields. It starts when the player first
// asks for an open table and, unlike openSeekSince, a hop or a fresh search does
// NOT restart it: it measures the player's wait, not the room's. When it expires
// we deal here, seating everyone actually present and a bot for every seat
// nobody took.
let openWaitSince = 0;
let openPendingSince = 0;
function noteOpenWait() { if (!openWaitSince) openWaitSince = Date.now(); }
// ── Proof of life ────────────────────────────────────────
// `presentIds` is seeded from the relay's ROSTER, which still lists everybody who
// ever sat down at this table. Walk into a room somebody abandoned and it hands
// you four "present" players who are all long gone — and every one of them is
// then treated as a live peer whose table must not be disturbed. The only thing
// that actually proves a peer is here is a message we received FROM them.
//
// "Ever heard from, in THIS room" — not a recency window. A seated player can be
// legitimately silent for a long time (it is somebody else's turn, their phone is
// asleep and a peer is covering for them), and timing that out would hand a real
// player's seat to a bot while they are still holding cards. What a ghost can
// never do is answer: every live client broadcasts player_info the moment
// somebody joins, so anybody who is really here is heard from within a second of
// our arrival. The set is per-room — resetRoomState() clears it.
const heardFrom = new Set();
function noteHeardFrom(id) { if (id != null && id !== myId) heardFrom.add(id); }
function isLivePeer(id) {
  if (id == null) return false;
  return id === myId || heardFrom.has(id);
}
// Everybody the room says is here, minus the ones only the roster believes in.
function livePresentIds() {
  const out = [];
  presentIds.forEach(id => { if (isLivePeer(id)) out.push(id); });
  return out;
}
// Is anybody else actually here? `connected_count` is the server's own answer and
// normally the best one — but a relay that counts room MEMBERSHIP rather than
// live sockets reports everybody who ever joined as connected, and then a room
// full of people who closed the app months ago can never be cleared out by
// anyone. Once the room has had time to answer us, what we have HEARD is the
// better evidence of the two, so either one saying we are alone is enough.
function aloneInRoom() {
  if (roomJoinedAt && Date.now() - roomJoinedAt >= GHOST_SETTLE_MS && livePresentIds().length <= 1) return true;
  return Number.isFinite(connectedCount) && connectedCount === 1;
}
// ── Seats held by people who are not here ────────────────
// A seat only goes back to a bot when we SEE its player leave (onPlayerLeft →
// forfeit grace → seat_release). Walk into a table somebody abandoned before we
// arrived and there is no such event to see: their name, avatar and score sit at
// the table forever, the turn stops on them every round, and the seat is not
// available to the next person who wants to play. That is the "he still looks
// like he is there, but he is offline" report.
//
// So: once the room has had time to answer us, any seat held by somebody who
// never did is handed back to a bot. GHOST_SETTLE_MS is generous next to the
// sub-second round trip of a player_info answer.
const GHOST_SETTLE_MS = 5000;    // long enough for a live client to answer our arrival
// Taking a seat away is the destructive one, so it waits far longer. A player who
// is merely backgrounded (their WebView frozen, running no javascript at all,
// indistinguishable from a departed one) re-announces the moment they resume, and
// this window is many times the round trip that takes.
const GHOST_SEAT_MS = 45000;
let roomJoinedAt = 0;
function sweepGhostSeats(now) {
  if (!online || !openTable || !gameStarted || pendingAction) return;
  if (!roomJoinedAt || now - roomJoinedAt < GHOST_SEAT_MS) return;
  if (authorityRank() !== 0) return;               // exactly one elected writer
  for (let seat = 0; seat < roomPlayerIds.length; seat++) {
    const id = roomPlayerIds[seat];
    if (id == null || id === myId || isLivePeer(id)) continue;
    if (pendingLeaves.has(id)) continue;           // their grace window is already running
    presentIds.delete(id);                         // …which is what lets sendSeatRelease act
    sendSeatRelease(seat);
    return;                                        // one at a time; the echo re-renders the table
  }
}
// The 4-seat order to deal the table with when the deadline expires: everybody we
// have heard from, in ROSTER order so every client computes the same seating, and
// a bot — `null` — for every seat nobody is in. Ghosts are simply not there.
function liveOpenOrder() {
  const order = new Array(OPEN_SEATS).fill(null);
  let n = 0;
  roomPlayerIds.forEach(id => {
    if (id != null && presentIds.has(id) && isLivePeer(id) && n < OPEN_SEATS && order.indexOf(id) < 0) order[n++] = id;
  });
  if (order.indexOf(myId) < 0 && n < OPEN_SEATS) order[n++] = myId;
  return order;
}
// A table that is genuinely full of people who are really here is not stuck — it
// simply has no seat for us, and dealing over it would wipe a live game. That is
// the one case where waiting (and hopping) stays the right answer.
function openTableIsLiveElsewhere() {
  if (!Array.isArray(lastSeenOrder)) return false;
  if (lastSeenOrder.indexOf(null) >= 0) return false;   // a bot holds a seat → one is coming free
  if (lastSeenOrder.indexOf(myId) >= 0) return false;   // it seats us; we are not queuing at all
  // Every seat held by somebody we have actually heard from, on a room that is
  // still moving. Roster presence alone is not enough: a table four people walked
  // away from names four "present" players and would otherwise look live forever,
  // kept warm by nothing but our own polling.
  if (!lastSeenOrder.every(id => presentIds.has(id) && isLivePeer(id))) return false;
  return Date.now() - lastRoomActivityAt < OPEN_REVIVE_MS;
}
// Seconds left on the bot-fill clock, or -1 when it is not running (we are not
// waiting, or the table we are queuing at is a real live one). Staggered by our
// position in the order so three clients hitting the deadline together do not
// each deal a rival table — the first stored deal wins and the rest stand down.
function openStartCountdown(now) {
  if (!online || !openTable || gameStarted || dealActive || !openWaitSince) return -1;
  if (openTableIsLiveElsewhere()) return -1;
  const rank = liveOpenOrder().indexOf(myId);
  if (rank < 0) return -1;                              // four other humans got here first
  const left = OPEN_FORCE_START_MS + rank * DEAL_STAGGER_MS - ((now || Date.now()) - openWaitSince);
  return left > 0 ? Math.ceil(left / 1000) : 0;
}
// Deal the table ourselves, bots in every empty seat. Returns true if it fired.
function forceOpenStart(now) {
  if (pendingAction) return false;                      // a deal is already in flight
  if (openStartCountdown(now) !== 0) return false;
  // Rate-limited on the same cooldown as every other unsolicited reset deal: the
  // countdown sits at 0 until a deal actually lands, so without this we would
  // fire one on every tick of the watchdog.
  if (Date.now() - lastOpenResetAt < OPEN_RESET_COOLDOWN_MS) return false;
  lastOpenResetAt = Date.now();
  stopProbe();
  stopHop();
  if (openStartTimer) { clearTimeout(openStartTimer); openStartTimer = null; }
  const order = liveOpenOrder();
  // Drop the ghosts from presence too, or reconcileOpenSeats will spend the whole
  // match trying to seat them into the bot seats we just opened. Anyone really
  // here re-announces through onPlayerJoined / player_info within a second — the
  // same reasoning reopenOpenTable() clears presence on.
  presentIds.forEach(id => { if (!isLivePeer(id)) presentIds.delete(id); });
  releasedIds.clear(); seatWaitSince.clear(); lastSeatClaimAt = 0;
  moveLog = []; optimisticMoves = []; optimisticStale = false;
  roomPlayerIds = order;
  numPlayers = OPEN_SEATS;
  isHost = roomPlayerIds[0] === myId;
  loseAt = OPEN_LOSE_AT;
  firstDeal = true; lastWinner = -1;
  hostDeal(true);   // reset: a brand-new match on whoever is actually here
  return true;
}
// Keep the cover honest while that clock runs. A spinner over "waiting for a
// seat" reads as an open-ended wait; a countdown says a game is coming.
function renderOpenWaitStatus(now) {
  const el = document.getElementById("onlineStatus");
  if (!el || !openTable || gameStarted || dealActive) return;
  const left = openStartCountdown(now);
  if (left < 0) return;                                 // a real table owes us a seat — leave the text alone
  // A healthy open table deals in well under a second, and a countdown flashing
  // up on it would only make a working game look broken. This is for the wait
  // that has already gone wrong.
  if (left > OPEN_COUNTDOWN_AT) return;
  el.textContent = left > 0 ? t("openStartIn", left) : t("dealing");
}
// Everything an open room has to keep an eye on, seated or not.
function openTableWatchdog(now) {
  publishOpenTable();
  renderOpenWaitStatus(now);
  if (openRoomIsAbandoned()) {
    // An empty room holding nothing but a stale log is ours as soon as the join
    // ack says so; only a room with a match still on screen gets the longer
    // settle, in case a peer simply has not announced themselves yet.
    const settle = gameStarted ? OPEN_ABANDONED_MS : OPEN_EMPTY_MS;
    if (!abandonedSince) abandonedSince = now;
    else if (now - abandonedSince >= settle) { abandonedSince = 0; reopenOpenTable(); }
  } else abandonedSince = 0;
  // Pre-game, NOTHING else clears a wedged action latch: the net watchdog's own
  // pending check below is gated on gameStarted, and hostDeal() bails while the
  // latch is set. So a deal whose echo never came back used to lock the table
  // shut permanently — the table stays on the cover and every later attempt to
  // open it returns at the first line. Ask for the state and let go of the latch;
  // if the deal did land, onDeal seats us, and if two deals race the server
  // orders them and the second is dropped as mid-round.
  if (!gameStarted && pendingAction) {
    if (!openPendingSince) openPendingSince = now;
    else if (now - openPendingSince >= PENDING_STUCK_MS) {
      openPendingSince = 0;
      pendingAction = false;
      try { if (window.Usion && Usion.game && Usion.game.requestSync) Usion.game.requestSync(0); } catch (_) {}
      renderLobby();
    }
  } else openPendingSince = 0;
  // The hard deadline. Everything below this line prefers to keep looking for a
  // seat somebody else owes us; this is the point where we stop asking and just
  // deal, with bots in whatever seats nobody took.
  if (forceOpenStart(now)) return;
  // Last resort: we have been hunting for a seat far too long. Something here is
  // not answering — a peer on an older build, a wedged authority, a relay that
  // will not take our claims. Take the room over and deal against bots rather
  // than leave the player on a spinner. Deliberately NOT a local game: staying in
  // a real room is what lets the next person's search find us.
  //
  // Skipped while the bot-fill clock is running (openStartCountdown() >= 0):
  // hopping to another table restarts the seat hunt there, and three clients all
  // doing that in step is exactly the merry-go-round that left everybody circling
  // the ladder for minutes. If we are going to deal here shortly, wait for it.
  if (!gameStarted && openSeekSince && now - openSeekSince >= OPEN_STUCK_MS
      && openStartCountdown(now) < 0) {
    stopProbe();
    if (roomPlayerIds.some(id => id != null && id !== myId)) {
      // People are here and simply will not seat us. Their table is not ours to
      // clear out, so go and find — or make — a different one.
      searchAgainFrom(openShard + 1 < OPEN_ROOM_SHARDS ? openShard + 1 : 0);
    } else {
      openSeekSince = Date.now();     // and if taking it over fails, try again later
      lastOpenResetAt = 0;
      reopenOpenTable();
    }
    return;
  }
  // Sitting alone at a table that is not the one searches look at first? Go back
  // and look again — somebody may have been at the front the whole time. Between
  // rounds only, so we never walk out on our own hand.
  if (gameStarted && openShard > 0 && aloneAtTable()) {
    if (!lastRegroupAt) lastRegroupAt = now;
    else {
      const waited = now - lastRegroupAt;
      // Prefer a round boundary so we do not walk out on our own hand — but a
      // round against three bots can run for a while, and sitting at the wrong
      // table is the thing we are trying to stop. After twice as long, go anyway.
      if (waited >= OPEN_REGROUP_MS && (!dealActive || waited >= OPEN_REGROUP_MS * 2)) {
        lastRegroupAt = 0; regroupToFront(); return;
      }
    }
  } else lastRegroupAt = 0;
  // Hand back any seat whose player was gone before we ever got here…
  sweepGhostSeats(now);
  // …then seat anyone waiting, and make sure a bot seat that is on turn actually
  // has somebody driving it (the elected client may have changed mid-turn).
  reconcileOpenSeats();
}

const CATCH_UP_DEBOUNCE_MS = 5000;
const PENDING_STUCK_MS = 6000;
const IDLE_SYNC_MS = 20000;
let lastCatchUpAt = 0;
let pendingSince = 0;
let lastNetAt = 0;      // when anything last arrived on a state-bearing channel
function requestCatchUp() {
  if (!online || !gameStarted || netPaused) return;
  const now = Date.now();
  if (now - lastCatchUpAt < CATCH_UP_DEBOUNCE_MS) return;   // never storm the server
  lastCatchUpAt = now;
  try { if (window.Usion && Usion.game && Usion.game.requestSync) Usion.game.requestSync(syncResumePoint()); } catch (_) {}
}
(function netWatchdog() {
  setInterval(function () {
    if (srvMode) return;                  // a server table needs none of this upkeep
    if (!online || netPaused) { pendingSince = 0; return; }
    const now = Date.now();
    // Open-room upkeep runs BEFORE the gameStarted gate, because the client that
    // needs it most is the one that has no seat yet: it is the one that can end up
    // staring at a spinner while a dead room, or a room where nobody will answer,
    // quietly refuses to let it in.
    if (openTable) {
      openTableWatchdog(now);
      if (!gameStarted) { pendingSince = 0; return; }
    }
    // netPaused already freezes everything and the reconnect path resyncs for us.
    if (!gameStarted) { pendingSince = 0; return; }
    // 1. our own action's echo never came back
    if (!pendingAction) pendingSince = 0;
    else if (!pendingSince) pendingSince = now;
    else if (now - pendingSince >= PENDING_STUCK_MS) { pendingSince = now; requestCatchUp(); }
    // 2. nothing at all is arriving. If the round is live and we are waiting on
    // SOMEBODY ELSE, silence past a turn's worth of thinking means we may simply
    // have stopped hearing the table — a client that misses every message has
    // nothing to reject and so no other way to notice. An up-to-date client just
    // gets an empty tail back, so this costs one small request per idle window.
    // 3. our own move never came back. We are playing a board the room may not
    // share, so ask for the authoritative state and let it overwrite us.
    if (optimisticMoves.length && now - optimisticMoves[0].at >= OPTIMISTIC_STUCK_MS) {
      optimisticStale = true;
      requestCatchUp();
    }
    // 4. we may have walked back into a room everybody else has left. Give
    // presence a few seconds to settle first — a peer who is really there just
    // has not said so yet.
    kickBotTurn();
    if (!dealActive || turn === mySeat) { lastNetAt = now; return; }
    if (!lastNetAt) { lastNetAt = now; return; }
    if (now - lastNetAt >= IDLE_SYNC_MS) { lastNetAt = now; requestCatchUp(); }
  }, 1000);
})();

// All game handlers in one place, registered exactly once. Kept separate from
// setupMultiplayer so a solo launch can register them the moment it is PROMOTED
// into a room (onRoomAssigned) — per the multiplayer contract, never gate
// handler registration behind the launch mode.
let netHandlersRegistered = false;
function registerNetHandlers() {
  if (netHandlersRegistered) return;
  netHandlersRegistered = true;
  Usion.game.onJoined(onJoined);
  Usion.game.onPlayerJoined(onPlayerJoined);
  Usion.game.onPlayerLeft(onPlayerLeft);
  if (Usion.game.onPlayerConnection) Usion.game.onPlayerConnection(onPlayerConnection);
  Usion.game.onAction(onNetAction);
  Usion.game.onRealtime(onNetRealtime);
  Usion.game.onSync(onNetSync);
  // A rematch request is a pure broadcast (no server-side restart in platform
  // mode) — surface WHO wants one; the actual restart is the host's reset deal.
  if (Usion.game.onRematchRequest) Usion.game.onRematchRequest((d) => {
    if (dealActive || !gameStarted) return;   // only meaningful on the game-over screen
    const seat = (d && d.player_id) ? roomPlayerIds.indexOf(d.player_id) : -1;
    const nm = (d && d.player_id && playerMeta[d.player_id] && playerMeta[d.player_id].name) ||
               (seat >= 0 && players[seat] && players[seat].name) || t("playerN", seat + 1);
    const rs = document.getElementById("rematchStatus");
    if (rs) rs.textContent = t("rematchWants", nm);
  });
  // Real pause on a dropped link: freeze the turn clock (so we can't be
  // auto-passed while offline) and tell the player. onTurnTimeout/startTurnTimer
  // both honor netPaused, so the clock sits frozen until we're back.
  if (Usion.game.onDisconnect) Usion.game.onDisconnect(() => {
    stopVoice();
    netPaused = true;
    pausedAt = Date.now();
    turnTrusted = false;   // we're about to miss whatever happens next
    stopTurnTimer();
    if (dealActive) toast(t("disconnectedPaused"));
  });
  if (Usion.game.onReconnect) Usion.game.onReconnect(() => {
    resumeFromPause();
    beginResync("reconnect");   // persistent retry — the round-trip can be flaky right after reconnect
    if (dealActive) resumeTurnTimer();   // give back the disconnected time, don't reset the clock
  });
}

// ── Finding a public table ───────────────────────────────
//
// The whole point of a public table is that the next person to tap Play finds
// the one you are already sitting at. That does not happen by itself: tables are
// spread over a ladder of rooms, people leave gaps in it, and a client that only
// ever looked at the first room would open a brand-new table right next to
// somebody playing alone with bots two rooms along. Neither of them would ever
// know. So arriving is a SEARCH, not a join.
//
// We walk the ladder, spending at most OPEN_PROBE_MS on each rung, and the join
// acknowledgement tells us what is there:
//
//   somebody here + a bot seat free  → stay: this is the table we came for
//   somebody here + all seats human  → full, try the next rung
//   nobody here, never used at all   → tables fill in order, so nothing lies
//                                      beyond this: open ours right here
//   nobody here, but used before     → a table somebody has left behind. Remember
//                                      it as somewhere we could set up, and keep
//                                      looking for actual people first.
//
// Only when the ladder holds nobody at all do we settle into the emptiest rung we
// saw and deal against bots — still in a real room, so the NEXT person's search
// finds us. Going offline here would make us invisible, which is the one thing
// this must never do.
let openShard = 0;
let openFallbackRoom = null;    // the platform's own room, if we can't pick our own
let hopTimer = null;
let probeTimer = null;
// True from the moment we ask to leave one public table until the next one
// acknowledges us. Walking the ladder means messages from the room we just left
// are still in flight, and applying one of those — a checkpoint, a move, a sync —
// would drag the previous table's state into the new room.
let joiningRoom = false;
let probeSettled = false;       // stopped searching: this room is where we are playing
let staleCandidate = -1;        // first rung we found empty — where we set up if nobody is home
// The seat order of the table we are queuing at, learned from a checkpoint we
// could not apply because it does not seat us. A `null` in it means a bot is
// holding a seat, so one is coming free for us and we should stay put.
let lastSeenOrder = null;
function publicRoomId(n) { return OPEN_ROOM_PREFIX + ((n % OPEN_ROOM_SHARDS) + 1); }

let openSeekSince = 0;          // when we started looking for a seat — survives hops
// Publish occupancy without joining other tables and accidentally taking seats.
const TABLE_DIRECTORY_PREFIX = "public13.table.v1.";
const TABLE_DIRECTORY_TTL = 45000;
let directoryLastKey = null, directoryLastSignature = null, directoryLastAt = 0;
let directoryWriting = false, openSearchSeq = 0;
let preferredOpenShards = [];
function publishOpenTable() {
  if (worldTables === true) return;
  const shared = window.Usion && Usion.cloud && Usion.cloud.shared;
  if (!shared || typeof shared.set !== "function" || !online || !openTable || !gameStarted || netPaused || joiningRoom) return;
  if (authorityRank() !== 0) return;
  const roomId = publicRoomId(openShard);
  const shard = openShard;
  if (voiceRoomId && voiceRoomId !== roomId) return;
  const humans = roomPlayerIds.filter(id => id != null && presentIds.has(id) && isLivePeer(id)).length;
  const freeSeats = openBotSeats().length;
  const signature = humans + ":" + freeSeats;
  const now = Date.now();
  const sameRoom = directoryLastKey === roomId;
  if (directoryWriting || (sameRoom && now - directoryLastAt < 5000) ||
      (sameRoom && signature === directoryLastSignature && now - directoryLastAt < 15000)) return;
  directoryWriting = true;
  directoryLastKey = roomId; directoryLastSignature = signature; directoryLastAt = now;
  Promise.resolve().then(() => shared.set(TABLE_DIRECTORY_PREFIX + shard,
    { version: 1, humans, freeSeats, updatedAt: now })).catch(() => {
      directoryLastSignature = null;
  }).finally(() => { directoryWriting = false; });
}
async function fullestOpenShard(fallback, candidates) {
  const shared = window.Usion && Usion.cloud && Usion.cloud.shared;
  if (!shared || typeof shared.get !== "function") return fallback;
  let timer;
  try {
    const entries = await Promise.race([
      Promise.all(Array.from({ length: OPEN_ROOM_SHARDS }, (_, shard) =>
        Promise.resolve().then(() => shared.get(TABLE_DIRECTORY_PREFIX + shard)).catch(() => null))),
      new Promise(resolve => { timer = setTimeout(() => resolve([]), 1500); })
    ]);
    const eligible = [];
    entries.forEach((entry, shard) => {
      if (!entry || entry.version !== 1 || !Number.isInteger(entry.humans) ||
          entry.humans <= 0 || entry.humans >= OPEN_SEATS ||
          !Number.isInteger(entry.freeSeats) || entry.freeSeats <= 0 || entry.freeSeats > OPEN_SEATS ||
          !Number.isFinite(entry.updatedAt) || Date.now() - entry.updatedAt > TABLE_DIRECTORY_TTL ||
          entry.updatedAt > Date.now() + 5000) return;
      eligible.push({ shard, humans: entry.humans });
    });
    eligible.sort((a,b) => b.humans - a.humans || a.shard - b.shard);
    if (candidates) candidates.push(...eligible);
    return eligible.length ? eligible[0].shard : fallback;
  } finally { if (timer) clearTimeout(timer); }
}
async function findOpenTable(fallbackShard, fallbackRoomId) {
  const seq = ++openSearchSeq;
  // The real relay only admits rooms that exist (and their players), so the
  // made-up public-13-N ladder below never seats anybody in production. A Usion
  // WORLD room is the platform's shared drop-in table: joinWorld() places us in
  // the world we are in, else one with a free seat (max 4), else a fresh one.
  // The ladder stays only for an SDK or service without world rooms.
  if (fallbackRoomId !== undefined) openFallbackRoom = soloFallbackRoom(fallbackRoomId);
  if (worldTables !== false && window.Usion && Usion.game && typeof Usion.game.joinWorld === "function") {
    const placed = await joinWorldTable(seq);
    if (placed !== null) return;
    worldTables = false;          // this service has no world rooms: use the old search
    if (seq !== openSearchSeq || !online || !openTable) return;
  }
  const candidates = [];
  const shard = await fullestOpenShard(fallbackShard, candidates);
  if (seq !== openSearchSeq || !online || !openTable) return;
  preferredOpenShards = candidates.map(entry => entry.shard).filter(candidate => candidate !== shard);
  joinOpenRoom(shard, fallbackRoomId);
}
// null = world rooms unavailable (fall back to the ladder); true/false = handled.
let worldTables = null;       // null unknown · true works · false not on this service
async function joinWorldTable(seq) {
  openShard = 0;                      // one shared table: never "away from the front"
  if (!openSeekSince) openSeekSince = Date.now();
  noteOpenWait();
  resetRoomState();
  onlineOverlay.classList.add("show");
  try {
    await Usion.game.connect();
    registerNetHandlers();
  } catch (err) {
    console.error("Open room failed:", err);
    online = false; openTable = false;
    onlineOverlay.classList.remove("show");
    startBotsGame();
    return false;
  }
  let roomId;
  try {
    const placed = await Usion.game.joinWorld();
    roomId = placed && (placed.roomId || placed.room_id);
    if (!roomId) throw new Error("no world room");
  } catch (err) {
    console.warn("World placement unavailable:", err && (err.code || err.message));
    return null;
  }
  if (seq !== openSearchSeq || !online || !openTable) return false;
  worldTables = true;
  try {
    joiningRoom = true;
    voiceRoomId = roomId;
    stopProbe();                      // the server placed us: there is nothing to search
    await Usion.game.join(roomId);
    return true;
  } catch (err) {
    joiningRoom = false;
    console.error("World room join failed:", err);
    if (openFallbackRoom) {
      try { voiceRoomId = openFallbackRoom; await Usion.game.join(openFallbackRoom); return true; } catch (_) {}
    }
    online = false; openTable = false;
    onlineOverlay.classList.remove("show");
    startBotsGame();
    return false;
  }
}
async function joinOpenRoom(shard, fallbackRoomId) {
  // Hops, probes and "search again" paths land here; with world rooms they all
  // mean "ask the server for a seat" again (leaving first frees ours).
  if (worldTables === true) return joinWorldTable(++openSearchSeq);
  openShard = shard;
  if (!openSeekSince) openSeekSince = Date.now();
  noteOpenWait();                     // deliberately NOT reset by a hop or a re-search
  if (fallbackRoomId !== undefined) openFallbackRoom = soloFallbackRoom(fallbackRoomId);
  resetRoomState();
  onlineOverlay.classList.add("show");
  const giveUp = (err) => {
    console.error("Open room failed:", err);
    online = false; openTable = false;
    onlineOverlay.classList.remove("show");
    startBotsGame();          // no relay at all → the same table, played locally
    return false;
  };
  try {
    await Usion.game.connect();
    registerNetHandlers();
  } catch (err) {
    return giveUp(err);       // the relay itself is unreachable
  }
  try {
    joiningRoom = true;
    voiceRoomId = publicRoomId(shard);
    await Usion.game.join(publicRoomId(shard));
    armProbe();               // the join ack decides whether we stay here
    return true;
  } catch (err) {
    joiningRoom = false;
    // We could reach the relay but it would not let us pick our own room. Fall
    // back to the room the platform gave us: a private table against bots is
    // still a game, it just isn't a shared one.
    if (openFallbackRoom) {
      try { voiceRoomId = openFallbackRoom; await Usion.game.join(openFallbackRoom); return true; } catch (_) { /* fall through */ }
    }
    return giveUp(err);
  }
}
// If the acknowledgement never arrives, treat the rung as a dead end and move on
// rather than sitting on it.
function armProbe() {
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  if (probeSettled) return;
  probeTimer = setTimeout(function () { probeTimer = null; probeNextRung(); }, OPEN_PROBE_MS);
}
function stopProbe() {
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  probeSettled = true;
}
// Read the join acknowledgement and decide: is this the table we came for?
// Returns false when we are moving on, so the caller stops making use of an
// acknowledgement that belongs to a room we are already leaving.
function probeRoom(data) {
  if (!online || !openTable || probeSettled || gameStarted) return true;
  if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  const others = Math.max(0, Number(data && data.connected_count) - 1) || 0;
  const cp = data && data.game_state;
  const table = !!(cp && cp.seed !== undefined && Array.isArray(cp.order));
  const freeSeat = table && cp.order.indexOf(null) >= 0;
  const used = table || Number(data && data.sequence) > 0;

  // People are here. Stay if there is room for us — or if they have not dealt
  // yet, because they are about to and we would be walking away from a table
  // that is still being set up.
  if (others >= 1 && (!table || freeSeat)) { stopProbe(); return true; }
  // Nobody here. Remember the FIRST such rung: if the search turns up no people
  // at all we come back and set up there, which keeps tables bunched at the front
  // of the ladder where the next person's search reaches them soonest.
  if (!others && staleCandidate < 0) staleCandidate = openShard;
  if (!others && preferredOpenShards.length) return probeNextRung();
  // Never used at all. Tables are only ever opened on the lowest empty rung, so
  // an untouched one means nothing beyond it has ever existed either — there is
  // nobody further along to find, and the search is over.
  if (!used) return settleOnEmptyRung();
  return probeNextRung();
}
function probeNextRung() {
  if (!online || !openTable || probeSettled || gameStarted) return true;
  if (preferredOpenShards.length) {
    const next = preferredOpenShards.shift();
    try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
    joinOpenRoom(next);
    return false;
  }
  if (openShard + 1 >= OPEN_ROOM_SHARDS) return settleOnEmptyRung();
  try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
  joinOpenRoom(openShard + 1);
  return false;
}
// Nobody on the whole ladder. Set up on the lowest empty rung we saw — going back
// for it if we have walked past it — and deal against bots there. Still a real
// room, so the next person's search finds this table instead of opening another.
function settleOnEmptyRung() {
  const target = staleCandidate >= 0 ? staleCandidate : openShard;
  staleCandidate = -1;
  stopProbe();
  if (target === openShard) return true;   // already standing on it
  claimOnArrival = true;                   // going back for a rung with leftovers on it
  try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
  joinOpenRoom(target);
  return false;
}
let claimOnArrival = false;    // the room we are joining is ours to clear out

// Two people playing bots at two different tables is the one outcome this whole
// mechanism exists to prevent, and no amount of care over a single join
// acknowledgement can rule it out: an ack can be stale, a relay can report a room
// differently than we assumed, two searches can cross. So rather than trust the
// search to be right first time, a player sitting ALONE anywhere but the front of
// the ladder periodically walks back and searches again. Whoever guessed wrong
// drifts down to the front, where everybody looks first, and the two tables
// become one. Alone means nothing is lost by moving: the seat we vacate becomes a
// bot, and the table we leave behind is a ghost the next arrival clears out.
let lastRegroupAt = 0;
function aloneAtTable() {
  return Array.isArray(roomPlayerIds) && roomPlayerIds.filter(id => id != null).length <= 1;
}
function searchAgainFrom(shard) {
  if (!online || !openTable) return;
  staleCandidate = -1;
  claimOnArrival = false;
  openSeekSince = 0;
  probeSettled = false;          // search again, properly, from here
  try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
  findOpenTable(shard);
}
function regroupToFront() {
  if (openShard > 0) searchAgainFrom(0);
}

// Seatless for a while means this table is full. Rather than queue behind four
// people we hop to the next public table, where we'll either find a bot seat or
// open a fresh table of our own. The last shard is the end of the ladder — stay
// there and wait for a seat.
function scheduleHop() {
  if (hopTimer || !online || !openTable || gameStarted) return;
  hopTimer = setTimeout(function () {
    hopTimer = null;
    if (!online || !openTable || gameStarted) return;
    const stuck = openSeekSince && Date.now() - openSeekSince >= OPEN_STUCK_MS;
    // A bot still holds a seat here, so this table owes us one — the claim is
    // just taking its time. Moving on now would leave us alone at an empty table
    // while there are people right here to play with. Unless we have been told
    // that for far too long, in which case nobody in this room is going to seat
    // us and waiting politely is just a spinner.
    if (!stuck && Array.isArray(lastSeenOrder) && lastSeenOrder.indexOf(null) >= 0) { scheduleHop(); return; }
    if (openShard + 1 >= OPEN_ROOM_SHARDS) { scheduleHop(); return; }
    try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
    joinOpenRoom(openShard + 1);
  }, OPEN_HOP_MS);
}
function stopHop() { if (hopTimer) { clearTimeout(hopTimer); hopTimer = null; } }

async function setupMultiplayer(roomId) {
  try {
    await Usion.game.connect();
    registerNetHandlers();
    voiceRoomId = roomId;
    await Usion.game.join(roomId);
  } catch (err) {
    console.error("Multiplayer failed:", err);
    online = false; onlineOverlay.classList.remove("show");
    // The no-invite launch owes the player a zero-tap game (GameTok contract), so
    // a room we cannot reach degrades to the same table played locally rather
    // than dumping them on a menu.
    if (openTable) { openTable = false; startBotsGame(); return; }
    setupOverlay.classList.add("show");
  }
}

// ── Tournament tables never get bots ──
// Hardening (2026-11-18). A player reported a bot in the 2026-11-17 event; the
// database showed every tournament room seated only humans, and the bot seats
// that evening were solo «Онлайн» tables. But a test showed that an open table
// COULD run inside a tournament room if «Онлайн» fell back to it. Three locks:
// the fallback is only ever a standalone_ room; a tournament table rejects any
// open/bot/off-list seating, live or replayed; and every tournament deal and
// checkpoint carries `tour`, which sends an open-table client back out.
function tourTag() { return tourCtx ? tourCtx.startsAt + ":" + tourCtx.stage + ":" + tourCtx.table : undefined; }
function tourSeatsOk(order, open) {
  if (!tourCtx || !Array.isArray(order) || open === true) return false;
  return order.length >= 2 && order.every(id => id != null && tourCtx.roster.indexOf(id) >= 0);
}
function soloFallbackRoom(id) { return typeof id === "string" && /^standalone_/.test(id) ? id : null; }
let strayLeftAt = 0;
function strayInTournamentRoom(st) {
  if (tourCtx || !openTable || !st || typeof st.tour !== "string" || !st.tour) return false;
  const now = Date.now();
  if (now - strayLeftAt < 3000) return true;
  strayLeftAt = now;
  console.warn("open table landed in a tournament room — leaving it");
  try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
  resetRoomState();
  online = false; openTable = false;
  openFallbackRoom = null;
  onlineOverlay.classList.remove("show");
  startBotsGame();            // a private table against bots, in no room at all
  return true;
}

// ── Start menu (no-invite launch) ────────────────────────
// Online       → the shared public-table ladder (tables fill 4 | 4 | 4 …)
// Play vs bots → a private local table: you + 3 bots, no relay at all
// Invite       → the host's friend picker; the promoted room opens the waiting hall
let launchRoomId = null;      // the platform's own room — fallback if the ladder refuses us
let inviting = false;
function showMenu() {
  online = false; openTable = false;
  onlineOverlay.classList.remove("show");
  setupOverlay.classList.remove("show");
  if (menuOverlay) menuOverlay.classList.add("show");
  tourRenderMenuNotice();   // "from tomorrow at 19:00" while the time is moving
  tourLoadFame();   // who won lately → the strip under the title
}
function hideMenu() { if (menuOverlay) menuOverlay.classList.remove("show"); }
function menuPlayOnline() {
  if (srvAvailable()) { srvStartOpen(); return; }
  if (!(window.Usion && Usion.game)) { hideMenu(); startBotsGame(); return; }
  hideMenu();
  openTable = true;
  online = true;
  onlineOverlay.classList.add("show");
  findOpenTable(0, launchRoomId || undefined);
}
function menuPlayBots() {
  hideMenu();
  startBotsGame();
}
async function menuInvite() {
  if (inviting) return;
  if (!(window.Usion && Usion.game && typeof Usion.game.invite === "function")) { toast(t("inviteFail")); return; }
  inviting = true;
  const btn = document.getElementById("menuInviteBtn");
  if (btn) btn.disabled = true;
  try {
    const res = await Usion.game.invite();
    // Picked somebody → the host has made us a room (onRoomAssigned may have
    // already fired); make sure the waiting hall is up either way. Closing the
    // picker without picking anyone leaves us on the menu.
    if (res && res.success) {
      hideMenu();
      if (!(online && !openTable)) onRoomPromoted();
    }
  } catch (err) {
    console.error("Invite failed:", err);
    toast(t("inviteFail"));
  } finally {
    inviting = false;
    if (btn) btn.disabled = false;
  }
}
(function wireMenu() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("menuOnlineBtn", menuPlayOnline);
  on("menuBotsBtn", menuPlayBots);
  on("menuInviteBtn", menuInvite);
})();

// Solo → host promotion (SDK ≥ 2.20): the user tapped the host's top-bar Share
// button mid-solo and invited someone. The SDK has ALREADY updated
// getLaunchParams().roomId and is connect()+join()ing us as playerIds[0] — our
// job is to drop the bots round, register the handlers, and open the waiting
// room; onJoined lands right after and the normal lobby flow takes over.
function onRoomPromoted() {
  if (online && !openTable) return;   // already in an invite room with a waiting room
  // Sharing IS inviting, so the promoted room follows the chat-invite rules: a
  // waiting room, READY, and a roster frozen at Start. It is also a DIFFERENT
  // room from whatever we were in, so every piece of per-room bookkeeping has to
  // start over or we would judge the new room's log against the old one's.
  resetRoomState();
  ++openSearchSeq;
  openTable = false;
  // A sync or checkpoint still in flight from the open table we were at must not
  // land in the new room (it would rebuild the old table, open:true and all):
  // drop old-room traffic until the promoted room's join ack arrives.
  joiningRoom = true;
  try { voiceRoomId = Usion.getLaunchParams().roomId || Usion.config.roomId || null; } catch (_) {}
  openFallbackRoom = null;
  online = true;
  myReady = false; lobbyReady = {};
  stopLocalRound();
  hideMenu();
  setupOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  const s = document.getElementById("onlineStatus");
  if (s) s.textContent = t("connecting");
  onlineOverlay.classList.add("show");
  registerNetHandlers();
}

// Tear down a local (vs-bots) round completely: every timer that could fire
// into the promoted online state.
function stopLocalRound() {
  if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (dealWaitTimer) { clearInterval(dealWaitTimer); dealWaitTimer = null; }
  if (handCdInterval) { clearInterval(handCdInterval); handCdInterval = null; }
  if (handCdTimeout) { clearTimeout(handCdTimeout); handCdTimeout = null; }
  if (dealTimer) { clearTimeout(dealTimer); dealTimer = null; }
  awaitingDeal = false;
  stopTurnTimer();
  selected.clear();
}
// The host's player_info doubles as the lobby-settings broadcast: it already
// fires on join, on every (re)join of a peer, and on each ready toggle, so the
// match length reaches late arrivals without a channel of its own.
function sendPlayerInfo() {
  const info = { name: myName || t("you"), avatar: myAvatar || null, ready: myReady };
  if (!openTable && isHostPlayer()) info.loseAt = loseAt;
  Usion.game.realtime("player_info", info);
}
// Point targets offered in the waiting room. The deal carries the chosen value,
// so this list only has to agree with itself — older clients still adopt
// whatever the host deals.
const LOSE_OPTIONS = [15, 20, 30];
function joinedPlayerId(data) {
  if (data && data.player_id != null) return data.player_id;
  if (data && data.player && data.player.id != null) return data.player.id;
  return null;
}

function reconcilePresence(ids, confirmedId) {
  if (Array.isArray(ids)) {
    presentIds.clear();
    ids.forEach(id => {
      // player_ids is the room roster and may still contain another player whose
      // custom leave grace is running, or one whose seat has already gone back to
      // a bot. Only the player named by THIS join event is confirmed back; keep
      // every other departed player absent.
      if (id === confirmedId || (!pendingLeaves.has(id) && !releasedIds.has(id))) presentIds.add(id);
    });
  }
  if (confirmedId != null) { presentIds.add(confirmedId); releasedIds.delete(confirmedId); }
}

function onJoined(data) {
  const joinedVoiceRoom = data.room_id || voiceRoomId;
  if (voiceRoomId && joinedVoiceRoom !== voiceRoomId) stopVoice();
  voiceRoomId = joinedVoiceRoom; voiceJoined = true;
  initNativeVoice();
  joiningRoom = false;        // this ack is the new room speaking
  roomJoinedAt = Date.now();  // …and starts the clock the ghost sweep settles on
  // Seats are locked to the roster the match was DEALT with (only the ready
  // players get seated), so once the game is running the server roster — which
  // also lists spectators who never got a seat — must not renumber us. Mid-game
  // seating comes from the checkpoint/deal `order` alone.
  if (!gameStarted) roomPlayerIds = data.player_ids || [];
  // The join acknowledgement is the authoritative CURRENT room membership.
  // Replace (rather than append to) presence so a leave missed while this client
  // was offline cannot keep a departed authority alive locally.
  reconcilePresence(data.player_ids || [], myId);
  connectedCount = Number(data.connected_count || 0);
  // data.sequence is the SERVER'S high-water mark, not proof that this client has
  // applied those actions. lastSeq advances only while processing onAction/onSync.
  isHost = roomPlayerIds[0] === myId;
  sendPlayerInfo(); updateOnlineStatus();
  // The join ack may carry the host's checkpoint as game_state — rebuild the
  // live round straight away so a rejoin resumes instead of stalling on
  // "Dealing…". Guarded by !dealActive (don't disturb an in-progress round);
  // applying it marks the game started so maybeStart won't re-deal.
  // Is this the table we came for? If not we are already on our way to the next
  // one, and the rest of this acknowledgement — the roster, the checkpoint —
  // describes a room we are leaving. Applying any of it would drag that table's
  // state along with us.
  if (openTable && !gameStarted && !probeRoom(data)) return;
  if (data.game_state && data.game_state.seed !== undefined) noteRoomActivity();
  if (!dealActive && data.game_state && data.game_state.seed !== undefined) applyCheckpoint(data.game_state);
  Usion.game.requestSync(0);   // SDK replays the stored deal + moves via onSync
  maybeStart();
  reconcileOpenSeats();
}
function onPlayerJoined(data) {
  const joinedId = joinedPlayerId(data);
  if (!gameStarted) {   // seats are frozen once dealt — see onJoined
    if (data.player_ids) roomPlayerIds = data.player_ids;
    else if (joinedId != null && !roomPlayerIds.includes(joinedId)) roomPlayerIds.push(joinedId);
  }
  reconcilePresence(data.player_ids, joinedId);
  noteHeardFrom(joinedId);      // a join event is the strongest proof of life there is
  if (typeof data.connected_count === "number") connectedCount = data.connected_count;
  else if (data.player && data.player.is_connected) connectedCount = Math.min(roomPlayerIds.length, connectedCount + 1);
  isHost = roomPlayerIds[0] === myId;
  // Cancel only the ID explicitly named by this join event. `player_ids` is a
  // roster, not evidence that every listed player just reconnected.
  if (joinedId != null && pendingLeaves.has(joinedId)) {
    clearForfeitGrace(joinedId);
    if (pendingLeaves.size) renderForfeitGrace();
    else render();
  }
  sendPlayerInfo(); updateOnlineStatus(); maybeStart();
  // Open table: the newcomer drops straight into the round by taking over the
  // lowest-scoring bot seat (and its points). One elected client writes it.
  reconcileOpenSeats();
  // Someone (re)joined — push them the current state so they catch up even if
  // their own sync is failing. Slight delay so they've finished rejoining the
  // room (and registered their realtime handlers) before the broadcast lands.
  if (gameStarted && dealActive) setTimeout(broadcastStatePush, 600);
}
// ── Forfeit grace period ──────────────────────────────────
// Defer every departure for a grace window so a quick rejoin does not create a
// durable fold. If the player stays gone, settle their seat after the deadline.
let forfeitTimer = null;
// More than one player can disappear inside the same grace window. Track each
// departure independently instead of letting the latest one overwrite the first.
const pendingLeaves = new Map();   // player id → { seat, deadline }
// 15 s from the moment a player is gone to their seat being settled, whichever
// way they went. An explicit leave (player_left) waits the full window here. A
// dropped socket has ALREADY waited it on the relay ("reconnecting" → "gone"
// after 15 s), so "gone" and a heartbeat prune settle on the next tick.
const FORFEIT_GRACE_MS = 15000;
const RELAY_WAITED = { gone: true, timeout: true };

function clearForfeitGrace(playerId) {
  if (playerId != null) pendingLeaves.delete(playerId);
  else pendingLeaves.clear();
  if (!pendingLeaves.size && forfeitTimer) {
    clearInterval(forfeitTimer);
    forfeitTimer = null;
  }
}

function renderForfeitGrace() {
  if (!pendingLeaves.size || !turnLine) return;
  let nearest = FORFEIT_GRACE_MS;
  pendingLeaves.forEach(p => { nearest = Math.min(nearest, Math.max(0, p.deadline - Date.now())); });
  turnLine.textContent = t("leftGrace", Math.max(1, Math.ceil(nearest / 1000)));
  turnLine.className = "turn-line";
}

function applyLeaveFold(seat) {
  if (seat < 0 || !players[seat] || players[seat].out) return;
  players[seat].out = true;
  passed.delete(seat);
  lastAction[seat] = { kind: "pass", text: t("leftGame") };
  if (!dealActive) return;

  // A folded seat is removed, not counted as a pass. Counting it after marking it
  // out lowers activeSeats().length and can clear the trick before the next live
  // player gets a chance to respond.
  if (table && passStreak >= activeSeats().length - 1) {
    clearTrick(table.seat);
  } else if (turn === seat) {
    turn = nextActiveAfter(seat);
    beginTurn();
  }
}

function applyLeaveOutcome(seat, endMatch) {
  applyLeaveFold(seat);
  if (endMatch || activeSeats().length <= 1) {
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    dealActive = false;
    showGameOver();
  } else {
    render();
  }
}

// Chat-invite mode: a departed seat is FOLDED out of the match, because the
// roster is the people who were invited and nobody may take their place. (An
// open room releases the seat to a bot instead — see sendSeatRelease.) Exactly
// one deterministic authority (the lowest live seat) may write it.
function sendHostLeaveOutcome(seat, endMatch) {
  if (seat < 0 || openTable) return;
  const rank = authorityRank();
  // Only the elected lowest present seat may write a fold. Accepting staggered
  // writes from every peer makes `auto:true`/leave outcomes forgeable.
  if (rank !== 0) return;
  if (players[seat] && players[seat].out) return;   // already folded — someone beat us to it
  Usion.game.action("move", { kind: endMatch ? "forfeit_win" : "leave_fold", seat })
    .catch(() => {
      toast(t("leaveFail"));
      Usion.game.requestSync(lastSeq);
    });
}

function startForfeitGrace(seat, playerId, graceMs) {
  if (seat < 0 || playerId == null) return;
  const ms = graceMs == null ? FORFEIT_GRACE_MS : graceMs;
  pendingLeaves.set(playerId, { seat, deadline: Date.now() + ms });
  renderForfeitGrace();
  if (forfeitTimer) return;
  forfeitTimer = setInterval(() => {
    if (!gameStarted) {
      clearForfeitGrace();
      render();
      return;
    }

    const now = Date.now();
    const expired = [];
    pendingLeaves.forEach((pending, id) => {
      if (presentIds.has(id) || (players[pending.seat] && players[pending.seat].out)) {
        pendingLeaves.delete(id);
      } else if (now >= pending.deadline) {
        expired.push([id, pending.seat]);
      }
    });

    // Open room: a seat whose player really is gone goes back to a bot, keeping
    // its score, so the table stays full and the room keeps running.
    // Chat invite: the roster is fixed, so the seat folds out of the match and
    // the last player standing wins by forfeit.
    expired.forEach(([id, seat]) => {
      pendingLeaves.delete(id);
      if (openTable) { sendSeatRelease(seat); return; }
      sendHostLeaveOutcome(seat, activeSeats().filter(s => s !== seat).length <= 1);
    });

    if (!pendingLeaves.size) {
      clearForfeitGrace();
      render();
    } else {
      renderForfeitGrace();
    }
  }, 1000);
}

// A socket that DROPS (app swiped away, phone locked, network gone, the WebView
// killed for another game) never produces game:player_left. The relay says
// "reconnecting" at once and "gone" 15 s later (backend server.py
// _game_disconnect_grace); only an explicit game:leave or a heartbeat prune
// sends player_left. Listening to player_left alone left every dropped player
// seated forever: avatar on the table, the turn stopping on them each round.
// "gone" is a departure like any other — same grace, same fold/release.
function onPlayerConnection(data) {
  if (!data || data.state !== "gone" || data.player_id == null || data.player_id === myId) return;
  const current = window.Usion && Usion.game && Usion.game.roomId;
  if (data.room_id && current && data.room_id !== current) return;   // a room we already left
  onPlayerLeft({ room_id: data.room_id, player_id: data.player_id, reason: "gone" });
}

function onPlayerLeft(data) {
  // "gone" and a later player_left (heartbeat prune) can both name the same
  // departure: the grace already running for them is the answer to both.
  if (gameStarted && data && data.player_id != null && pendingLeaves.has(data.player_id)) return;
  connectedCount = Math.max(0, connectedCount - 1);
  lastPlayerLeftAt = Date.now();   // give them the grace window before calling the room dead
  if (!gameStarted) {
    if (data && data.player_ids) roomPlayerIds = data.player_ids;   // roster only changes pre-game; seats are fixed once started
    if (data && data.player_id != null) { presentIds.delete(data.player_id); delete lobbyReady[data.player_id]; }
    isHost = roomPlayerIds[0] === myId;
    renderLobby();
    return;
  }
  // mid-game: the player who left forfeits (their seat stays fixed).
  // Drop them from presence FIRST and on EVERY client: presence drives who deals
  // the next round and who covers a stalled turn, so if the leaver was the host we
  // must stop waiting on them everywhere, not just on the host's own client.
  if (data && data.player_id != null) presentIds.delete(data.player_id);
  const seat = (data && data.player_id != null) ? roomPlayerIds.indexOf(data.player_id) : -1;
  if (seat < 0 || !players[seat] || players[seat].out) {
    // Room rosters retain past visitors. A visitor who probed a full table and
    // left must not be revived and seated when somebody else later frees a seat.
    if (data && data.player_id != null) releasedIds.add(data.player_id);
    // Nothing to fold (spectator, or an already-eliminated player — including the
    // eliminated HOST walking away). But if the table is waiting on a deal, the
    // client that owed it may be the one that just left: re-rank and cover it.
    retryNextDeal();
    render();
    return;
  }

  // ALWAYS run a grace window before folding — a brief drop (backgrounded app,
  // network blip) surfaces as onPlayerLeft too, and folding immediately writes a
  // DURABLE leave_fold that permanently eliminates the player even after they
  // rejoin. Don't mutate yet; a rejoin by this player cancels the fold and
  // resumes the hand exactly where it was. Only if they're still gone when the
  // window expires is the outcome recorded:
  //   activeAfter ≤ 1 → match-ending forfeit;  else → plain fold, play continues.
  // EVERY client runs the countdown (it's also the on-screen "left — 15s" line);
  // exactly one elected live client writes each expired outcome.
  startForfeitGrace(seat, data.player_id, RELAY_WAITED[data.reason] ? 0 : FORFEIT_GRACE_MS);
}
// number of seats this online match has: an open room is always 4; a chat-invite
// match seats exactly the people who were invited (2–4).
function targetSeats() {
  return openTable ? OPEN_SEATS : Math.max(2, Math.min(4, roomPlayerIds.length || 2));
}
function updateOnlineStatus() {
  const s = document.getElementById("onlineStatus");
  if (!s || gameStarted || dealActive) return;
  if (tourCtx) return;                 // a tournament lobby writes its own line (renderTourLobby)
  if (openTable) { s.textContent = t("openStatus"); renderOpenWaitStatus(); return; }
  const n = targetSeats();
  s.textContent = connectedCount < n
    ? t("waitingPlayers", Math.min(connectedCount, n), n)
    : t("readyStarting", n);
}
// Forget everything we know about the room we were in. Used when hopping to
// another public table and when a Share promotion moves us into an invite room:
// the sequence numbers, roster, checkpoint and presence of the OLD room would all
// be judged against the new one's log otherwise.
function resetRoomState() {
  stopVoice(); voiceJoined = false; voiceRoomId = null; syncVoiceButton();
  stopSeatPoll();
  stopHop();
  if (openStartTimer) { clearTimeout(openStartTimer); openStartTimer = null; }
  if (openRestartTimer) { clearTimeout(openRestartTimer); openRestartTimer = null; }
  stopLocalRound();
  clearForfeitGrace();
  gameStarted = false; dealActive = false;
  players = []; hands = []; moveLog = []; optimisticMoves = []; optimisticStale = false;
  table = null; trickPlays = []; lastAction = {};
  roomPlayerIds = [];
  presentIds.clear(); presentIds.add(myId); releasedIds.clear();
  lastSeq = 0; appliedBaseSeq = 0; appliedSequences = new Set();
  checkpointVersion = 0;
  sawRoomCheckpoint = false; lastRoomActivityAt = 0;
  heardFrom.clear();            // proof of life belongs to the room we just left
  roomJoinedAt = 0;
  seatWaitSince.clear(); lastSeatClaimAt = 0; lastOpenResetAt = 0;
  abandonedSince = 0; lastPlayerLeftAt = 0; lastRegroupAt = 0;
  lastSeenOrder = null;
  pendingAction = false;
  mySeat = -1;
}

// Is somebody's table already running in this room? A late arrival must NOT deal
// a rival match over the top of one — it waits to be seated instead. Stored
// actions and checkpoints are the evidence: a genuinely fresh room has neither.
let sawRoomCheckpoint = false;
let lastRoomActivityAt = 0;
function noteRoomActivity() { sawRoomCheckpoint = true; lastRoomActivityAt = Date.now(); }
function roomAlreadyRunning() { return lastSeq > 0 || sawRoomCheckpoint; }

// No waiting room: an open table deals as soon as someone is in it, against bots
// for every empty seat. Everyone who arrives later is seated mid-match by
// reconcileOpenSeats() instead of gathering here.
let openStartTimer = null;
let seatPollTimer = null;
function maybeStart() {
  if (gameStarted || dealActive) { stopSeatPoll(); return; }
  // Chat invite: gather in the waiting room and wait for the host's Start.
  if (!online || !openTable) { enterLobby(); return; }
  // No invite: no waiting room. Deal against bots and seat arrivals as they come.
  loseAt = OPEN_LOSE_AT;               // an open room runs one fixed road-to-20
  noteOpenWait();                      // …and under everything, the bot-fill deadline
  enterLobby();
  scheduleOpenStart();
  startSeatPoll();
  scheduleHop();                       // …and move on if this table turns out to be full
}
// Open the table. Seat 0 stays the platform host, but if the host never deals
// (asleep, or gone before the first hand) the next present client covers,
// staggered by rank — the same election that keeps later rounds moving.
function scheduleOpenStart() {
  if (openStartTimer || !online || !openTable) return;
  const seats = roomPlayerIds.filter(id => id != null && presentIds.has(id));
  const rank = seats.indexOf(myId);
  if (rank < 0) return;
  openStartTimer = setTimeout(function () {
    openStartTimer = null;
    if (!online || gameStarted || dealActive) return;
    // A table is already live here and simply has no seat for us yet — wait for
    // reconcileOpenSeats to hand us one rather than dealing a second, rival
    // match into the same room. Only a room that has ALSO gone completely quiet
    // counts as dead and worth reopening.
    if (roomAlreadyRunning() && Date.now() - lastRoomActivityAt < OPEN_REVIVE_MS) {
      scheduleOpenStart();
      return;
    }
    const order = buildOpenOrder();
    if (order.indexOf(myId) < 0) return;      // four other humans got here first
    roomPlayerIds = order;
    numPlayers = OPEN_SEATS;
    isHost = roomPlayerIds[0] === myId;
    loseAt = OPEN_LOSE_AT;
    firstDeal = true; lastWinner = -1;
    hostDeal();
  }, OPEN_START_MS + rank * DEAL_STAGGER_MS);
}
// A client with no seat yet (it joined a table whose four seats are all human,
// or its seat claim hasn't landed) keeps asking for state until a checkpoint
// arrives with it seated.
function startSeatPoll() {
  if (seatPollTimer || !online || !openTable) return;
  seatPollTimer = setInterval(function () {
    if (!online || gameStarted) { stopSeatPoll(); return; }
    try { if (window.Usion && Usion.game && Usion.game.requestSync) Usion.game.requestSync(0); } catch (_) {}
  }, 1500);
}
function stopSeatPoll() { if (seatPollTimer) { clearInterval(seatPollTimer); seatPollTimer = null; } }
function enterLobby() {
  if (gameStarted || dealActive) return;
  presentIds.add(myId);
  if (!openTable) lobbyReady[myId] = myReady;
  const title = document.getElementById("lobbyTitle");
  if (title) title.textContent = openTable ? t("lobbyTitle") : t("lobbyTitleInvite");
  onlineOverlay.classList.add("show");
  renderLobby();
}
// present players in roster order (then any extras), so seats are stable for all
// Who to SHOW in the waiting room. An open table's roster is a public room's
// whole history — everybody who has ever sat down at it — and listing that as
// "here" is what put three names on a cover where one player was waiting alone.
// A chat invite's roster is the invited group, which is exactly who belongs in
// the list, so only the open table filters on proof of life.
function lobbyOrder() {
  const here = openTable ? id => presentIds.has(id) && isLivePeer(id) : id => presentIds.has(id);
  const ids = roomPlayerIds.filter(here);
  presentIds.forEach(id => { if (here(id) && !ids.includes(id)) ids.push(id); });
  return ids;
}
function renderLobby() {
  syncVoiceButton();
  const list = document.getElementById("lobbyList");
  if (!list || gameStarted || dealActive) return;
  if (tourCtx) { renderTourLobby(); return; }
  const ids = lobbyOrder();
  const hostId = roomPlayerIds[0];
  const spinner = document.getElementById("lobbySpinner");
  // An open room is always a moment away from dealing, so the spinner stays.
  if (spinner) spinner.style.display = (openTable || !ids.length) ? "block" : "none";
  list.innerHTML = "";
  ids.forEach((id, i) => {
    const meta = playerMeta[id] || {};
    const nm = meta.name || (id === myId ? (myName || t("you")) : t("playerN", i + 1));
    const avatar = meta.avatar || (id === myId ? myAvatar : null);
    const row = document.createElement("div");
    row.className = "lobby-row" + (id === myId ? " me" : "");
    const avatarEl = makeAvatarEl(nm, avatar, "lobby-avatar", false);
    markVoiceAvatar(avatarEl, id, false);
    row.appendChild(avatarEl);
    const nameEl = document.createElement("span");
    nameEl.className = "lobby-name";
    nameEl.textContent = shortName(nm);
    if (!openTable && id === hostId) {   // an open room has no host to speak of
      const tag = document.createElement("span");
      tag.className = "lobby-tag";
      tag.textContent = " " + t("hostTag");
      nameEl.appendChild(tag);
    }
    row.appendChild(nameEl);
    if (!openTable) {                       // READY badges belong to the waiting room
      const badge = document.createElement("span");
      const ready = !!lobbyReady[id];
      badge.className = "lobby-badge " + (ready ? "ready" : "wait");
      badge.textContent = ready ? t("ready") : t("notReady");
      row.appendChild(badge);
    }
    list.appendChild(row);
  });
  const statusEl = document.getElementById("onlineStatus");
  const readyBtn = document.getElementById("readyBtn");
  const startBtn = document.getElementById("startGameBtn");
  const hint = document.getElementById("lobbyHint");
  if (openTable) {
    // No invite: nothing to press, and nothing to configure. This cover is only up
    // for the moment it takes to find a table, so it must not look like a lobby
    // that is waiting on the player to do something.
    if (statusEl && statusEl.textContent !== t("openWaitSeat")) statusEl.textContent = t("openStatus");
    renderOpenWaitStatus();   // …and once the bot-fill clock is running, it says so instead
    if (readyBtn) readyBtn.style.display = "none";
    if (startBtn) { startBtn.style.display = "none"; startBtn.disabled = true; }
    const limit = document.getElementById("lobbyLimit");
    if (limit) limit.style.display = "none";     // the target is fixed; showing a picker is a lie
    if (hint) hint.textContent = t("openTableTag");
    return;
  }
  // Chat invite: the classic waiting room — everyone readies, the host starts.
  const present = ids.length;
  const readyCount = ids.filter(id => lobbyReady[id]).length;
  const allReady = present >= 2 && readyCount === present;
  if (statusEl) statusEl.textContent = present < 2 ? t("waitingJoin") : t("readyCount", readyCount, present);
  if (readyBtn) {
    readyBtn.style.display = "block";
    readyBtn.textContent = myReady ? t("readyOn") : t("ready");
    readyBtn.classList.toggle("btn-ready-on", myReady);
  }
  if (startBtn) {
    startBtn.style.display = isHost ? "block" : "none";
    startBtn.disabled = !allReady || pendingAction;
  }
  renderLobbyLimit();
  if (hint) {
    hint.textContent = isHost
      ? (allReady ? t("hintHostGo") : t("hintHostWait"))
      : (myReady ? t("hintWaitHost") : t("hintPressReady"));
  }
}
// Show the match length to everyone; only the host can change it. Hidden until
// we're actually in a room (the overlay also covers the "connecting…" state).
function renderLobbyLimit() {
  const wrap = document.getElementById("lobbyLimit");
  if (!wrap) return;
  // isHostPlayer() reads the roster directly — the `isHost` flag is only assigned
  // once onJoined lands, which would render the host's own picker read-only for
  // the first moment of the lobby.
  // Chat invite: the host picks the match length and everyone sees the same value.
  // Open room: there is no host to pick, so it is a read-only reminder of the
  // fixed target (OPEN_LOSE_AT).
  // isHostPlayer() reads the roster directly — the `isHost` flag is only assigned
  // once onJoined lands, which would render the host's own picker read-only for
  // the first moment of the lobby.
  const amHost = !openTable && isHostPlayer();
  wrap.style.display = (online && roomPlayerIds.length > 0) ? "block" : "none";
  wrap.classList.toggle("readonly", !amHost);
  document.querySelectorAll("#lobbyLoseRow .count-btn").forEach(btn => {
    btn.classList.toggle("selected", Number(btn.dataset.lose) === loseAt);
    btn.disabled = !amHost;
  });
}
// Host only: lock the seats to the present + ready players and deal.
// Chat invite only: lock the seats to the present + ready players and deal.
function hostStartGame() {
  if (gameStarted || openTable || !isHost) return;
  const order = lobbyOrder().filter(id => lobbyReady[id]);
  if (order.length < 2) return;
  roomPlayerIds = order;
  numPlayers = order.length;
  isHost = roomPlayerIds[0] === myId;
  if (!isHost) return;
  firstDeal = true; lastWinner = -1;   // fresh match → lowest-card holder leads
  hostDeal();   // broadcasts the deal (with this order) → every client begins
}
// Start a solo offline game vs 3 bots (you + Bot Anh/Bat/Cag = 4 seats).
function startBotsGame() {
  ++openSearchSeq;
  stopVoice(); voiceJoined = false; voiceRoomId = null;
  online = false; openTable = false; gameStarted = false; dealActive = false;
  openSeekSince = 0; openWaitSince = 0; openPendingSince = 0;
  myReady = false; presentIds.clear(); lobbyReady = {};
  hideMenu();
  onlineOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  setupOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  const nm = (myName || t("you")).slice(0, 10);
  numPlayers = 4;                       // "play with bots" is always you + 3 bots
  loseAt = 20;                          // GameTok: 4-player road to 20 points
  players = [];
  for (let i = 0; i < numPlayers; i++) {
    players.push({ name: i === 0 ? nm : t("botNames")[i], avatar: i === 0 ? myAvatar : null,
                   color: PLAYER_COLORS[i], isBot: i !== 0, total: 0, out: false });
  }
  mySeat = 0;
  firstDeal = true; lastWinner = -1;
  meNameEl.textContent = nm;
  startDeal(randomSeed());
}
// Bail out of the online room and play solo vs 3 bots — no ready needed.
function leaveForBots() {
  try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
  startBotsGame();
}
(function wireLobby() {
  const readyBtn = document.getElementById("readyBtn");
  const startBtn = document.getElementById("startGameBtn");
  const botsBtn = document.getElementById("lobbyBotsBtn");
  // READY / Start drive the chat-invite waiting room. renderLobby() hides both in
  // an open room, and a hidden (or disabled) button ignores clicks anyway.
  if (readyBtn) readyBtn.addEventListener("click", () => {
    if (openTable) return;
    myReady = !myReady;
    lobbyReady[myId] = myReady;
    if (online && window.Usion && Usion.game) sendPlayerInfo();
    renderLobby();
  });
  if (startBtn) startBtn.addEventListener("click", hostStartGame);
  if (botsBtn) botsBtn.addEventListener("click", leaveForBots);
  // Host picks how many penalty points knock a player out. Broadcast immediately
  // so everyone in the room sees the target before they ready up. Open rooms run
  // a fixed target, so the picker is inert there.
  document.querySelectorAll("#lobbyLoseRow .count-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (openTable || !isHostPlayer() || gameStarted) return;
      const v = Number(btn.dataset.lose);
      if (LOSE_OPTIONS.indexOf(v) < 0 || v === loseAt) return;
      loseAt = v;
      if (online && window.Usion && Usion.game) sendPlayerInfo();
      renderLobby();
    });
  });
})();
function startOnlineGame(data) {
  if (gameStarted) return true;
  if (!data || !validSeatOrder(data.order) || data.order.indexOf(myId) < 0) {
    showNotSeated();
    return false;
  }
  clearForfeitGrace();
  stopSeatPoll();
  stopHop();                           // we have a seat — this is our table now
  stopProbe();
  openSeekSince = 0; openWaitSince = 0; openPendingSince = 0;
  staleCandidate = -1; claimOnArrival = false;
  if (openStartTimer) { clearTimeout(openStartTimer); openStartTimer = null; }
  gameStarted = true; online = true;
  statsRecordedThisGame = false;   // new match → allow recording its outcome once
  resultReportedThisGame = false;
  roomPlayerIds = data.order;
  numPlayers = roomPlayerIds.length;
  mySeat = roomPlayerIds.indexOf(myId);
  isHost = roomPlayerIds[0] === myId;
  firstDeal = true; lastWinner = -1;
  // A `null` seat in the order is a bot the open table filled in. Bots are real
  // seats: they hold cards, take penalties, and can be eliminated — they are just
  // played by the engine instead of by a person.
  players = roomPlayerIds.map((id, i) => id == null ? makeBotSeat(i) : ({
    name: (playerMeta[id] && playerMeta[id].name) || (id === myId ? (myName || t("you")) : t("playerN", i + 1)),
    avatar: (playerMeta[id] && playerMeta[id].avatar) || (id === myId ? myAvatar : null),
    color: PLAYER_COLORS[i], isBot: false, total: 0, out: false
  }));
  meNameEl.textContent = players[mySeat].name;
  setupOverlay.classList.remove("show");
  const os = document.getElementById("onlineStatus");
  if (os) os.textContent = t("dealing");
  onlineOverlay.classList.add("show");   // keep covering the table until the first deal lands
  render();
  Usion.game.requestSync(0);   // catch any actions (e.g. the deal) we missed
  // non-host safety net: if the host's deal never reaches us, keep asking
  if (!isHost) {
    if (dealWaitTimer) clearInterval(dealWaitTimer);
    dealWaitTimer = setInterval(function () {
      if (dealActive) { clearInterval(dealWaitTimer); dealWaitTimer = null; return; }
      Usion.game.requestSync(0);
    }, 2000);
  }
  return true;
}
// names the host knows for the current roster — carried in stored deal/checkpoint
// so every client (and reconnects) gets real names, not "Player N", even if they
// missed the ephemeral player_info broadcast.
function nameMap() {
  const m = {};
  roomPlayerIds.forEach(id => {
    if (id == null) return;                       // bot seat — no identity to carry
    const nm = playerMeta[id] && playerMeta[id].name;
    if (nm) m[id] = nm;
  });
  return m;
}
function avatarMap() {
  const m = {};
  roomPlayerIds.forEach(id => {
    if (id == null) return;
    const avatar = normalizeAvatar(playerMeta[id] && playerMeta[id].avatar);
    if (avatar) m[id] = avatar;
  });
  return m;
}
function applyNames(map) {
  if (!map) return;
  for (const id in map) playerMeta[id] = Object.assign(playerMeta[id] || {}, { name: map[id] });
}
function applyAvatars(map) {
  if (!map) return;
  for (const id in map) {
    const avatar = normalizeAvatar(map[id]);
    if (avatar) playerMeta[id] = Object.assign(playerMeta[id] || {}, { avatar: avatar });
  }
}
// ── Open-table seating ───────────────────────────────────
// The room is a persistent 4-seat table. Bots hold every seat no human is in;
// a human who arrives takes over a bot seat WITH ITS SCORE, and a human who
// leaves hands their seat (and score) back to a bot. Seat changes travel as
// stored `move` actions so they sit in the same sequenced, replayable log as
// every play — a reconnecting client rebuilds the roster exactly as it evolved.
function botSeatName(seat) {
  const pool = t("openBotNames") || [];
  return pool[seat % pool.length] || ("Bot " + (seat + 1));
}
function makeBotSeat(i) {
  return { name: botSeatName(i), avatar: null, color: PLAYER_COLORS[i], isBot: true, total: 0, out: false };
}
// Seats a newcomer could drop into: still in the match, still held by a bot.
function openBotSeats() {
  return players.map((p, s) => s).filter(s => players[s] && players[s].isBot && !players[s].out);
}
// WHICH bot a joining human replaces: the one carrying the FEWEST penalty points
// (the best-placed bot), lowest seat index breaking a tie. Computed from
// replayable state alone, so every client — live or replaying — picks the same
// seat and the log stays deterministic.
//
// An ELIMINATED bot seat is not offered: it holds no cards, so a human dropped
// into it would sit out with nothing to play. When every bot has been knocked out
// — exactly where two friends end up after a few rounds on a road-to-20 table —
// the way back in is a fresh match, not a dead seat. See openResetForWaiting().
function takeoverSeat() {
  const seats = openBotSeats();
  if (!seats.length) return -1;
  let best = seats[0];
  seats.forEach(s => { if (players[s].total < players[best].total) best = s; });
  return best;
}
// Are there bot seats, but all of them eliminated? Then the table has no way to
// let anybody in, and two players could hold the room against everybody else
// just by knocking the bots out.
function openTableIsClosed() {
  return players.some(p => p && p.isBot) && !openBotSeats().length;
}
// Humans in the room with no seat yet, in a stable order.
// Who is standing at the table waiting for a seat. Proof of life matters as much
// here as anywhere: a public room's roster names everybody who ever played here,
// and without the filter the table spends its time dealing seats to people who
// left days ago — seating a ghost, sweeping it back out, seating the next one —
// while the person actually waiting stands there watching it happen.
function unseatedPresent() {
  const out = [];
  presentIds.forEach(id => {
    if (id != null && isLivePeer(id) && roomPlayerIds.indexOf(id) < 0) out.push(id);
  });
  return out.sort();
}
// Hand seat `seat` to a human. The seat's total/out/hand are untouched — that is
// the whole point: the newcomer inherits the bot's standing and its cards.
function seatHuman(seat, id) {
  if (!players[seat]) return;
  const meta = playerMeta[id] || {};
  roomPlayerIds[seat] = id;
  players[seat].isBot = false;
  players[seat].name = meta.name || (id === myId ? (myName || t("you")) : t("playerN", seat + 1));
  players[seat].avatar = normalizeAvatar(meta.avatar) || (id === myId ? myAvatar : null);
  presentIds.add(id);
  releasedIds.delete(id);
  clearForfeitGrace(id);
  if (botTimer && turn === seat) { clearTimeout(botTimer); botTimer = null; }
  if (id === myId) {
    mySeat = seat;
    meNameEl.textContent = players[seat].name;
    onlineOverlay.classList.remove("show");
  }
  // The new owner gets a full clock rather than whatever the bot had left.
  if (dealActive && turn === seat) startTurnTimer();
  render();
}
// Hand a seat back to a bot, score and cards intact, so the table stays full.
function seatBot(seat) {
  if (!players[seat]) return;
  const id = roomPlayerIds[seat];
  roomPlayerIds[seat] = null;
  players[seat].isBot = true;
  players[seat].name = botSeatName(seat);
  players[seat].avatar = null;
  if (id != null) { presentIds.delete(id); releasedIds.add(id); clearForfeitGrace(id); }
  render();
  if (dealActive && turn === seat) scheduleBotMove(seat);
}
// Apply a seat change out of the action log. Every rule here reads replayable
// state (who holds the seat, the seats' totals), so a live client and a client
// replaying the same log reach the same verdict — the property that keeps the
// table from splitting in two.
function applySeatMove(move, fromId) {
  if (!openTable) return false;        // a chat-invite match has a frozen roster
  if (!gameStarted || !Array.isArray(players) || !players.length) return false;
  const seat = Number(move.seat);
  if (!Number.isInteger(seat) || seat < 0 || seat >= numPlayers || !players[seat]) return false;
  if (move.kind === "seat_take") {
    const id = move.playerId;
    if (id == null || roomPlayerIds.indexOf(id) >= 0) return false;   // nobody sits twice
    // On a checkpoint replay the roster is already the post-change one, so the
    // "is this a bot seat" test would fail on a change we have in fact applied.
    if (!replayTrusted) {
      if (!players[seat].isBot || players[seat].out) return false;
      if (seat !== takeoverSeat()) return false;                       // must be THE lowest-scoring bot
      if (fromId != null && roomPlayerIds.indexOf(fromId) < 0 && fromId !== id) return false;
    } else if (!players[seat].isBot) return false;
    if (move.name) playerMeta[id] = Object.assign(playerMeta[id] || {}, { name: String(move.name).slice(0, 10) });
    if (move.avatar) {
      const av = normalizeAvatar(move.avatar);
      if (av) playerMeta[id] = Object.assign(playerMeta[id] || {}, { avatar: av });
    }
    seatHuman(seat, id);   // total / out / cards stay exactly as the bot left them
    // Our claim landed, so the rate limit has done its job — clear it and let the
    // next person in the queue be seated on the following tick instead of after
    // another full SEAT_RETRY_MS.
    if (fromId === myId) lastSeatClaimAt = 0;
    if (!replayingSync && id !== myId) toast(t("openJoined", shortName(players[seat].name)));
    moveLog.push(move);
    if (!replayingSync && fromId === myId) writeCheckpoint();
    return true;
  }
  if (move.kind === "seat_release") {
    const id = roomPlayerIds[seat];
    if (id == null || players[seat].isBot) return false;               // already a bot
    if (id === myId) return false;                                     // we are right here
    if (!replayTrusted && presentIds.has(id)) return false;            // a present player is not gone
    if (!replayTrusted && (fromId == null || roomPlayerIds.indexOf(fromId) < 0)) return false;
    const gone = players[seat].name;
    seatBot(seat);                      // score stays on the seat; the bot inherits it
    if (!replayingSync) toast(t("openLeftBot", shortName(gone)));
    moveLog.push(move);
    if (!replayingSync && fromId === myId) writeCheckpoint();
    return true;
  }
  return false;
}
// Claim a seat for the next unseated human. The lowest present seat writes it,
// but — exactly like scheduleNextDeal — every other seated client covers on a
// stagger, because a locked phone never leaves presentIds and a single elected
// writer asleep would lock newcomers out of the room forever. Duplicate claims
// are harmless: the second one finds the seat already human and is rejected by
// every client identically.
let lastSeatClaimAt = 0;
let abandonedSince = 0;            // when we first noticed we were alone with ghosts
let lastPlayerLeftAt = 0;          // last time anybody dropped out of the room
const seatWaitSince = new Map();   // unseated player id → when we first saw them waiting
function reconcileOpenSeats() {
  if (!online || !openTable || !gameStarted || pendingAction) return;
  const waiting = unseatedPresent();
  seatWaitSince.forEach((_, id) => { if (waiting.indexOf(id) < 0) seatWaitSince.delete(id); });
  if (!waiting.length) return;
  const id = waiting[0];
  if (!seatWaitSince.has(id)) seatWaitSince.set(id, Date.now());
  const rank = authorityRank();
  if (rank < 0) return;                                                   // we hold no seat ourselves
  const now = Date.now();
  if (now - seatWaitSince.get(id) < rank * SEAT_STAGGER_MS) return;       // higher ranks go first
  if (now - lastSeatClaimAt < SEAT_RETRY_MS) return;                      // never storm the relay
  const seat = takeoverSeat();
  if (seat < 0) {
    // Somebody is waiting and there is no seat to give them. If that is only
    // because every bot has been eliminated, the honest answer is a fresh match —
    // that match was nearly over anyway, and the alternative is a room two people
    // have locked against everybody else. Four humans is a genuinely full table,
    // and the newcomer's own client moves them on to another one (scheduleHop).
    if (openTableIsClosed()) openResetForWaiting();
    return;
  }
  const meta = playerMeta[id] || {};
  lastSeatClaimAt = now;
  try {
    Usion.game.action("move", { kind: "seat_take", seat: seat, playerId: id,
                                name: meta.name || null, avatar: meta.avatar || null })
      .catch(function () { lastSeatClaimAt = 0; });
  } catch (_) { lastSeatClaimAt = 0; }
}
// Deal a fresh match so somebody waiting outside can be seated. Between rounds
// only — a reset deal mid-hand would yank the cards out of everyone's hands — and
// rate-limited, because the newcomer stays unseated until the reset lands and we
// must not fire one on every tick of the watchdog until it does.
let lastOpenResetAt = 0;
const OPEN_RESET_COOLDOWN_MS = 15000;
function openResetForWaiting() {
  if (dealActive || pendingAction) return;
  if (authorityRank() !== 0) return;                     // one elected writer
  if (Date.now() - lastOpenResetAt < OPEN_RESET_COOLDOWN_MS) return;
  lastOpenResetAt = Date.now();
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (handCdInterval) { clearInterval(handCdInterval); handCdInterval = null; }
  if (handCdTimeout) { clearTimeout(handCdTimeout); handCdTimeout = null; }
  hostDeal(true);   // reset: every total back to zero, every seat back in play
}

// ── Walking back into a dead room ────────────────────────
// The relay keeps a public table's action log and checkpoint after everybody has
// left it, so tapping Play again drops you back into the leftovers of your own
// finished match: your old score, your old elimination, and seats still held by
// people who are not here. That is not a table, it is a ghost — and nothing in
// it will ever move, because the players it is waiting on are gone.
//
// If we are the only one connected and the roster names anybody else, that is
// exactly what we are looking at. Note the two things this deliberately does NOT
// fire on: a legitimate solo table (every other seat is a bot, so no id but ours
// is in the roster), and a player mid-disconnect (their forfeit grace is running,
// and when it expires their seat becomes a bot on its own).
function openRoomIsAbandoned() {
  if (!online || !openTable) return false;
  // We swept the whole ladder and came back to the emptiest rung on it. Whatever
  // is still stored here belongs to a table nobody is playing.
  if (claimOnArrival && !gameStarted) return true;
  // connectedCount, not presentIds: the relay's roster is frozen once a match
  // starts and still lists everybody who ever sat down, so presence alone cannot
  // tell a live opponent from a ghost. The server's connected count can. If the
  // host does not report one we simply never auto-clear — better a stale table
  // than one cleared out from under two people who are really playing.
  if (!Number.isFinite(connectedCount) || connectedCount < 1) return false;
  if (!aloneInRoom()) return false;
  if (pendingLeaves.size) return false;          // somebody's grace is still running
  // Somebody dropped out a moment ago. An ELIMINATED seat gets no forfeit grace
  // of its own (there is nothing left to fold), so without this a peer who is
  // merely reconnecting would have the whole room wiped out from under them.
  if (lastPlayerLeftAt && Date.now() - lastPlayerLeftAt < FORFEIT_GRACE_MS) return false;
  if (!gameStarted) return roomAlreadyRunning(); // a stale log with nobody left to play it
  return roomPlayerIds.some(id => id != null && id !== myId);
}
// Clear the room out and open a fresh table on it. We cannot delete the relay's
// log, but a reset deal makes the room's CURRENT state a brand-new match seated
// on whoever is actually here — which is all anybody can see.
function reopenOpenTable() {
  if (!online || !openTable || pendingAction) return;
  // Never clear out a table other people are sitting at. Every caller believes
  // the room is dead, but they reach that from presence and connection counts,
  // and being wrong here means wiping a live game somebody else is playing.
  if (roomPlayerIds.some(id => id != null && id !== myId)) {
    if (!aloneInRoom()) return;
  }
  if (Date.now() - lastOpenResetAt < OPEN_RESET_COOLDOWN_MS) return;
  lastOpenResetAt = Date.now();
  stopLocalRound();
  stopHop();
  clearForfeitGrace();
  dealActive = false;
  awaitingDeal = false;
  moveLog = []; optimisticMoves = []; optimisticStale = false;
  releasedIds.clear(); seatWaitSince.clear(); lastSeatClaimAt = 0;
  handOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  // Presence is built from the relay's frozen roster, so it still lists the
  // ghosts. We have already established from connectedCount that nobody else is
  // connected, so throw it away — anyone who really is here re-announces
  // themselves through onPlayerJoined / player_info within a second.
  claimOnArrival = false;
  joiningRoom = false;
  presentIds.clear(); presentIds.add(myId);
  roomPlayerIds = buildOpenOrder();     // just the people actually here, bots for the rest
  numPlayers = OPEN_SEATS;
  isHost = roomPlayerIds[0] === myId;
  loseAt = OPEN_LOSE_AT;
  firstDeal = true; lastWinner = -1;
  // Take the pre-game path on the way back so startOnlineGame() rebuilds `players`
  // from the new roster — otherwise the ghost's name would still be sitting on a
  // seat a bot now holds.
  gameStarted = false;
  hostDeal(true);
}

// A departed seat goes back to a bot instead of folding out of the match: an
// open table must survive its players leaving.
function sendSeatRelease(seat) {
  if (!online || !openTable || seat < 0 || !Array.isArray(roomPlayerIds)) return;
  const id = roomPlayerIds[seat];
  if (id == null || presentIds.has(id)) return;
  if (authorityRank() !== 0) return;          // exactly one elected writer
  try {
    Usion.game.action("move", { kind: "seat_release", seat: seat })
      .catch(function () { toast(t("leaveFail")); Usion.game.requestSync(lastSeq); });
  } catch (_) {}
}
// The 4-seat order this client would open the table with: present humans in
// roster order (so playerIds[0] keeps seat 0), bots — `null` — for the rest.
function buildOpenOrder() {
  const order = new Array(OPEN_SEATS).fill(null);
  let n = 0;
  roomPlayerIds.forEach(id => {
    if (id != null && presentIds.has(id) && n < OPEN_SEATS && order.indexOf(id) < 0) order[n++] = id;
  });
  presentIds.forEach(id => { if (n < OPEN_SEATS && order.indexOf(id) < 0) order[n++] = id; });
  return order;
}

// Deal a round. Callers decide WHO may call it: the opening deal comes from the
// staggered open-table election, later rounds go through scheduleNextDeal.
// The seed of every round after the first is a hash of the round before it, so
// whoever deals cannot choose it. A free dealer-picked seed let a modified client
// search thousands of seeds for one that deals itself a dragon and win the match
// in a single deal. onDeal() rejects a mid-match deal whose seed is not this.
function nextRoundSeed(prevSeed, log) {
  let s = String(prevSeed) + ";";
  (log || []).forEach(m => { if (m && (m.kind === "play" || m.kind === "pass")) s += moveKey(m) + ";"; });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) & 0x7fffffff;
}
function chainedDeal(reset) { return gameStarted && !reset; }
function hostDeal(reset) {
  if (pendingAction) return;
  // Do not overwrite curSeed here: our own echo verifies the seed against it.
  const seed = chainedDeal(reset) ? nextRoundSeed(curSeed, moveLog) : randomSeed();
  // carry the starter context so every client picks the SAME leader: firstDeal →
  // lowest-card holder leads; otherwise the previous round's winner leads. Without
  // this, a client with stale firstDeal/lastWinner computes a different starter.
  // reset:true = a REMATCH deal — every client zeroes its match state (totals,
  // eliminations) in onDeal before dealing, so the whole table restarts as one.
  const d = { seed: seed, order: roomPlayerIds, names: nameMap(), avatars: avatarMap(),
              firstDeal: reset ? true : firstDeal, lastWinner: reset ? -1 : lastWinner,
              loseAt: loseAt,     // host owns the elimination threshold → every client adopts it
              open: openTable };  // and the room's mode travels with it
  if (tourCtx) d.tour = tourTag();
  if (reset) d.reset = true;
  // A chat-invite rematch keeps the frozen roster, so somebody who walked out of
  // the last match would be dealt straight back in — 13 cards nobody plays, and a
  // 100 s proxy cover on every one of their turns. Name the seats that stay
  // folded: folded now and gone from the room.
  if (reset && gameStarted && !openTable) {
    const keep = roomPlayerIds.map((id, s) => s).filter(s =>
      players[s] && players[s].out && roomPlayerIds[s] !== myId && !presentIds.has(roomPlayerIds[s]));
    if (keep.length && roomPlayerIds.length - keep.length >= 2) d.keepOut = keep;
  }
  pendingAction = true;
  renderLobby();
  Usion.game.action("deal", d)
    .then(res => {
      if (res && res.success === false) {
        pendingAction = false;
        toast(t("dealFail"));
        renderLobby();
      }
    })
    .catch(() => {
      pendingAction = false;
      toast(t("dealFail"));
      renderLobby();
    });
}
// A move's identity for matching an echo against what we already played: the
// kind plus the exact cards, order-independent.
function moveKey(m) {
  return m.kind + "|" + (Array.isArray(m.cards) ? m.cards.map(Number).sort((a, b) => a - b).join(",") : "");
}
// Play a move we are SENDING straight onto our own board, without waiting for the
// relay to hand it back. This is not a guess: the move was built and validated
// with the exact rules every other client will apply to it, and the same
// deterministic engine produces the same result everywhere. The echo is matched
// on (ti, cards) and skipped, and a watchdog resyncs us if it never turns up.
function applyOptimisticMove(move) {
  const seat = Number(move.seat);
  if (!dealActive || !Number.isInteger(seat) || turn !== seat) return false;
  if (Number(move.ti) !== roundMoveNo) return false;
  if (!players[seat] || players[seat].out) return false;
  let combo = null;
  if (move.kind === "pass") {
    if (!table) return false;
  } else if (move.kind === "play") {
    const cards = decodeMoveCards(move.cards);
    if (!cards || !handOwnsCards(seat, cards)) return false;
    combo = classify(cards);
    if (!isLegalPlay(combo)) return false;
  } else return false;
  optimisticMoves.push({ ti: Number(move.ti), key: moveKey(move), at: Date.now() });
  // The board already shows the move, so leaving the controls latched would just
  // reintroduce the delay we are removing.
  pendingAction = false;
  roundMoveNo += 1;
  const record = JSON.parse(JSON.stringify(move));
  if (move.kind === "pass") doPass(seat); else doPlay(seat, combo);
  moveLog.push(record);
  return true;
}
// `seat` defaults to our own. `proxy` means we're covering a stalled player: the
// move belongs to THEIR seat, so it must not latch our own "sending…" state, and
// receivers must credit it to `move.seat` rather than to us, the sender.
function sendMove(move, seat, proxy) {
  if (pendingAction) return;
  move.seat = (seat === undefined) ? mySeat : seat;
  move.ti = roundMoveNo;          // the move index this was built for → duplicate covers collapse
  // A bot seat's move is already marked `bot` and validated against the engine's
  // own choice; only a cover for a HUMAN seat is an `auto` forced move.
  if (proxy && move.bot !== true) move.auto = true;
  if (!proxy) { pendingAction = true; renderControls(); }
  // Only our OWN play/pass goes onto our board immediately. A bot move or a cover
  // for somebody else waits for its echo and is validated in sequence order like
  // anyone's: a bot move applied early could land on a seat that a seat_take,
  // sequenced just ahead of it, had already handed to a human — the relay's board
  // then ran ahead of everyone else's and its checkpoints spread the split.
  const ours = !proxy && move.seat === mySeat;
  const failed = () => {
    pendingAction = false;
    if (!proxy) toast(t("moveFail"));
    if (ours) { optimisticStale = true; requestCatchUp(); }   // our board may now be ahead of the room
    render();
  };
  Usion.game.action("move", move)
    .then(res => { if (res && res.success === false) failed(); })
    .catch(failed);
  if (ours) applyOptimisticMove(move);
}
function proxyAuthorityId(targetSeat) {
  for (let s = 0; s < roomPlayerIds.length; s++) {
    if (s !== targetSeat && mayActForTable(roomPlayerIds[s])) return roomPlayerIds[s];
  }
  return null;
}

function decodeMoveCards(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 5) return null;
  const decoded = [];
  for (const raw of values) {
    const value = Number(raw);
    if (!Number.isInteger(value)) return null;
    const card = wireCard(value);
    if (card.r < 3 || card.r > 15 || card.s < 0 || card.s > 3 || cardWire(card) !== value) return null;
    decoded.push(card);
  }
  return decoded;
}

function handOwnsCards(seat, cards) {
  const remaining = (hands[seat] || []).slice();
  for (const card of cards) {
    const index = remaining.findIndex(c => sameCard(c, card));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

// Validate an incoming action against the same deterministic state on every
// client. The relay sequences and stores actions; it does not know this game's
// hand/turn rules, so accepting first and "snapping" the turn to the sender lets
// a client play out of turn, fabricate cards, or force another seat to pass.
function applyRemoteMove(move, fromId) {
  // Our own move just landed — via the live echo (onNetAction) OR recovered through
  // a resync/checkpoint replay after a dropped echo. Clear the "sending…" latch on
  // EVERY path, not just the live one, or a resync-recovered own move leaves us
  // stuck on "Sending…" (dead buttons) — and if we're the host, a stuck pendingAction
  // silently blocks hostDeal(), freezing the WHOLE table on the next round transition.
  if (fromId != null && fromId === myId) { pendingAction = false; renderControls(); }
  if (!move || typeof move !== "object") return false;
  // Our own move coming back. We played it the moment we sent it, so the echo is
  // a no-op — but it MUST still count as applied, or the sequence bookkeeping
  // gets a hole in it and every client starts asking for pointless catch-ups.
  if (fromId != null && fromId === myId && optimisticMoves.length) {
    const i = optimisticMoves.findIndex(o => o.ti === Number(move.ti) && o.key === moveKey(move));
    if (i >= 0) {
      optimisticMoves.splice(i, 1);
      if (!optimisticMoves.length) optimisticStale = false;
      // Only NOW is the move really in the room's log, so only now may we
      // snapshot a state that includes it.
      if (!replayingSync && dealActive) writeCheckpoint();
      renderControls();
      return true;
    }
  }
  if (move.kind === "leave_fold" || move.kind === "forfeit_win") {
    const leaveSeat = Number(move.seat);
    if (!Number.isInteger(leaveSeat) || leaveSeat < 0 || leaveSeat >= numPlayers ||
        !players[leaveSeat] || players[leaveSeat].out) return false;
    if (!replayTrusted) {
      const targetId = roomPlayerIds[leaveSeat];
      // A connected player cannot be folded, and only the elected authority may
      // durably settle a departed seat. Enforced when replaying the raw action
      // log too, so a forged fold sitting in the log cannot eliminate a player on
      // whoever resyncs next.
      if (presentIds.has(targetId) || fromId !== proxyAuthorityId(leaveSeat)) return false;
    }
    const endMatch = activeSeats().filter(s => s !== leaveSeat).length <= 1;
    applyLeaveOutcome(leaveSeat, endMatch);
    moveLog.push(move);
    if (!replayingSync && fromId === myId) writeCheckpoint();   // the sender persists the outcome
    return true;
  }
  // Seat changes are legal BETWEEN rounds as well as during one — an open table
  // reseats the moment somebody arrives or leaves, mid-hand included.
  if (move.kind === "seat_take" || move.kind === "seat_release") return applySeatMove(move, fromId);
  if (!dealActive) return false;
  // Duplicate/stale guard. Two clients can legitimately cover the SAME stalled
  // seat (staggered proxies) and both actions reach the server; `ti` is the move
  // index each was built for, so the loser is dropped instead of being applied on
  // top and desynchronising the round.
  if (move.ti !== undefined &&
      (!Number.isInteger(Number(move.ti)) || Number(move.ti) !== roundMoveNo)) return false;

  const senderSeat = (fromId != null) ? roomPlayerIds.indexOf(fromId) : -1;
  const claimed = Number(move.seat);
  let seat = Number.isInteger(claimed) && claimed >= 0 && claimed < numPlayers ? claimed : -1;
  if (seat < 0) seat = senderSeat >= 0 ? senderSeat : turn;

  if (!replayTrusted) {
    if (senderSeat < 0) return false;
    if (move.bot === true) {
      // Any SEATED client may drive a bot seat. Deliberately not gated on
      // presence: presence cannot be reconstructed on replay, and a rule judged
      // differently live and on replay is precisely what splits a table in two.
      // The content check further down is the real guard — the sender does not
      // get to choose the cards, the engine does.
      if (seat === senderSeat) return false;
    } else if (move.auto === true) {
      // Any seated client but the target may cover — the same rule as a bot
      // move, and for the same reasons: the covers are staggered by seat, and
      // presence is not replayable. What a cover may contain is fixed below.
      if (seat === senderSeat) return false;
    } else if (seat !== senderSeat) {
      return false;
    }
  } else if (move.auto !== true && move.bot !== true && senderSeat >= 0 && seat !== senderSeat) {
    return false;
  }

  if (!players[seat] || players[seat].out) return false;   // unknown/folded/eliminated seat can't act
  if (seat !== turn) return false;

  // A cover is a FORCED move, never a free one. Every client can derive it from
  // state alone (same deal seed → same hands), so it must be exactly what the
  // engine would have played for that seat: a pass when following, the engine's
  // own minimal lead when leading. Without this an `auto` move was just a normal
  // move wearing somebody else's seat, and the sender got to choose which cards
  // came out of the victim's hand.
  //
  // Checked HERE, outside the !replayingSync block, on purpose: the sender-side
  // checks above cannot run during replay (presence is not reconstructable), so
  // a forged cover that every live client rejected was still applied by anyone
  // who later resynced — a split table. This rule reads only replayable state,
  // so live and replay always reach the same verdict. `fromId` is absent for
  // moves replayed out of a checkpoint, so only validate the sender when we have
  // one.
  // A bot seat's move must be EXACTLY what the engine would play for that hand,
  // recomputed here from state every client already shares. Same principle as a
  // proxy cover, except the engine gets its full choice instead of a forced
  // minimal one — so relaying a bot can never smuggle in a chosen discard.
  if (move.bot === true) {
    if (!replayTrusted && (!players[seat] || !players[seat].isBot)) return false;
    if (fromId != null && (roomPlayerIds.indexOf(fromId) < 0 || fromId === roomPlayerIds[seat])) return false;
    const want = botDecision(seat);
    if (!want || want.kind !== move.kind) return false;
    if (want.kind === "play") {
      const wantCards = want.combo.cards.map(cardWire).sort((a, b) => a - b).join(",");
      const gotCards = Array.isArray(move.cards) ? move.cards.map(Number).sort((a, b) => a - b).join(",") : "";
      if (!wantCards || wantCards !== gotCards) return false;
    }
  }
  if (move.auto === true) {
    if (fromId != null && (roomPlayerIds.indexOf(fromId) < 0 || fromId === roomPlayerIds[seat])) return false;
    if (table) {
      if (move.kind !== "pass") return false;
    } else {
      const forced = botLead(hands[seat], firstPlay);
      const want = forced ? forced.cards.map(cardWire).sort((a, b) => a - b).join(",") : "";
      const got = Array.isArray(move.cards) ? move.cards.map(Number).sort((a, b) => a - b).join(",") : "";
      if (move.kind !== "play" || !want || want !== got) return false;
    }
  }

  let combo = null;
  if (move.kind === "pass") {
    if (!table) return false;                 // a lead can never pass
  } else if (move.kind === "play") {
    const cards = decodeMoveCards(move.cards);
    if (!cards || !handOwnsCards(seat, cards)) return false;
    combo = classify(cards);
    if (!isLegalPlay(combo)) return false;
  } else {
    return false;
  }

  roundMoveNo += 1;
  if (move.kind === "pass") doPass(seat);
  else doPlay(seat, combo);
  // Record it BEFORE checkpointing — the checkpoint carries moveLog, so appending
  // after the write would persist a snapshot that is missing the very move that
  // triggered it, and a client rebuilding from it would replay one move short.
  moveLog.push(move);
  // The ACTOR (the player who just moved) persists the fresh state — not the
  // host — so a move made while the host is backgrounded is never lost.
  if (!replayingSync && fromId === myId) writeCheckpoint();
  return true;
}
function onNetAction(data) {
  if (joiningRoom) return;    // still in flight from the table we just left
  const sequence = Number(data.sequence);
  lastNetAt = Date.now();       // the table is still audible — see netWatchdog
  noteRoomActivity();           // and it proves a match is already running here
  if (!replayingSync) noteHeardFrom(data.player_id);   // …and that its sender is here NOW
  if (Number.isFinite(sequence)) lastSeq = Math.max(lastSeq, sequence);
  // Clear our "sending…" state the moment we SEE our own action echoed — BEFORE
  // the dedup return. If a resync already applied this seq, the echo is a dup and
  // we'd skip out below; without clearing here first, pendingAction sticks true
  // forever and we can never move again ("Sending…" with the Play button dead).
  if (data.player_id === myId) pendingAction = false;
  if (Number.isFinite(sequence) && alreadyApplied(sequence)) { renderControls(); return; }
  const d = data.action_data || {};
  let applied = true;
  if (data.action_type === "deal") applied = onDeal(d, data.player_id) === true;
  // applyRemoteMove owns moveLog: it appends ONLY moves it actually applied, so a
  // move's index always equals its `ti` and checkpoint replay is bit-identical to
  // the live round.
  else if (data.action_type === "move") applied = applyRemoteMove(d, data.player_id) === true;
  // Record ONLY what actually landed. Marking a rejected action as applied
  // punches a permanent hole in the record: syncResumePoint() would step over it
  // and a later replay would skip the very action we still need.
  if (Number.isFinite(sequence) && applied) appliedSequences.add(sequence);
  // An action we could not apply usually means WE are the stale one — we missed
  // the move it builds on, so it lands out of turn / on the wrong `ti`. (The
  // benign causes — a losing deal race, a duplicate proxy cover, a forgery — are
  // rare, and requestCatchUp is debounced and idempotent.) This is the only thing
  // that notices a foreground client drifting behind on a healthy socket.
  if (!applied) requestCatchUp();
}
function onNetRealtime(data) {
  if (joiningRoom) return;    // still in flight from the table we just left
  if (data.player_id === myId) return;
  const d = data.action_data || {};
  if (data.action_type === "player_info") {
    const previous = playerMeta[data.player_id] || {};
    playerMeta[data.player_id] = {
      name: (typeof d.name === "string" && d.name) ? d.name : previous.name,
      avatar: normalizeAvatar(d.avatar)
    };
    if (typeof d.ready === "boolean") lobbyReady[data.player_id] = d.ready;   // waiting-room only
    // A player_info broadcast is live proof the sender is in the room right now —
    // unlike the frozen roster — so it also un-releases somebody who came back.
    // Answer the first announce from a peer we had not heard from. player_info is
    // fire-and-forget: whoever's broadcast goes missing would otherwise be a ghost
    // to the other for the rest of the room's life. One reply each way, and only
    // on the first sighting, so this cannot ping-pong.
    const firstSighting = !isLivePeer(data.player_id);
    noteHeardFrom(data.player_id);
    presentIds.add(data.player_id);
    releasedIds.delete(data.player_id);
    if (firstSighting) { try { sendPlayerInfo(); } catch (_) {} }

    // Adopt the match length only from the host, and only from the offered set —
    // it's the host's setting, and the deal will carry it authoritatively anyway.
    if (!gameStarted && data.player_id === roomPlayerIds[0] &&
        LOSE_OPTIONS.indexOf(Number(d.loseAt)) >= 0) loseAt = Number(d.loseAt);
    if (gameStarted) { refreshNames(); render(); } else renderLobby();
  } else if (data.action_type === "state_push") {
    // Only the elected current authority may push a recovery snapshot. Without
    // this check any peer can roll the table back with a forged/stale state.
    if (data.player_id !== proxyAuthorityId(-1)) return;
    applyStateSnapshot(d);
  } else if (data.action_type === "reaction") {
    // Cosmetic quick-chat: pop the sender's bubble over their seat.
    const seat = roomPlayerIds.indexOf(data.player_id);
    const value = normalizeReaction(d.kind, d.value);
    // Throttled on receipt too: the sender's 700 ms limit is only a courtesy, and
    // a modified client could otherwise bury the table in hundreds of bubbles.
    const now = Date.now();
    if (seat >= 0 && value && now - (reactionHeardAt[data.player_id] || 0) >= REACTION_RX_MS) {
      reactionHeardAt[data.player_id] = now;
      showReaction(seat, d.kind, value);
    }
  }
}
const REACTION_RX_MS = 600;
const reactionHeardAt = {};
// Catch-up replay (from requestSync). Each "deal" resets state, so replaying
// the whole log from sequence 0 deterministically rebuilds the current round.
function onNetSync(data) {
  if (joiningRoom) return;    // still in flight from the table we just left
  lastNetAt = Date.now();
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const checkpoint = data.game_state;
  const hasCheckpoint = !!(checkpoint && checkpoint.seed !== undefined);
  // A checkpoint is also worth taking when it holds more UNBROKEN history than we
  // do, even if we have seen higher sequence numbers we could not use — that is
  // precisely the client with a hole in the middle, which no action tail can heal
  // once the log has been compacted past the gap.
  const cpSeq = Number(checkpoint && checkpoint.seq);
  const shouldApplyCheckpoint = hasCheckpoint &&
    (!gameStarted || snapshotIsNewer(checkpoint) || (Number.isFinite(cpSeq) && cpSeq > syncResumePoint()) ||
     // An overdue own-move echo means our board may be a move AHEAD of the room's,
     // and a snapshot at our own sequence is then exactly the correction we need.
     (optimisticStale && Number.isFinite(cpSeq) && cpSeq >= syncResumePoint()));
  const hasUnappliedActions = actions.some(a => a.sequence === undefined || !alreadyApplied(a.sequence));
  if (hasCheckpoint || actions.length) noteRoomActivity();   // somebody's table is live in this room

  // A join acknowledgement reports the server's top sequence before this client
  // has applied it. Therefore data.sequence/lastSeq equality cannot prove that the
  // checkpoint tail is already local; inspect the actual checkpoint and actions.
  if (!shouldApplyCheckpoint && !hasUnappliedActions) return;
  if (shouldApplyCheckpoint) applyCheckpoint(checkpoint);

  replayingSync = true;
  try {
    actions.forEach(a => {
      const sequence = Number(a.sequence);
      if (Number.isFinite(sequence) && alreadyApplied(sequence)) return;
      const d = a.action_data || {};
      let ok = true;
      if (a.action_type === "deal") ok = onDeal(d, a.player_id) === true;
      else if (a.action_type === "move") ok = applyRemoteMove(d, a.player_id) === true;
      // Advance only after this action has actually been considered locally, and
      // remember it as applied only if it really was — see onNetAction. Invalid
      // game actions still consume a server sequence and are safely ignored by
      // applyRemoteMove's deterministic validation.
      if (Number.isFinite(sequence)) {
        if (ok) appliedSequences.add(sequence);
        lastSeq = Math.max(lastSeq, sequence);
      }
    });
  } finally {
    replayingSync = false;
  }
  kickBotTurn();   // the tail may have left a bot seat on turn with nobody driving it
}
function onDeal(d, fromId) {
  // The deal we sent has landed (live echo, or recovered via resync/replay after a
  // dropped echo). Release the "sending…" latch on EVERY path: hostDeal() and
  // sendMove() both bail while it's set, so a latch stuck by a dropped deal echo
  // locked us out of playing for the whole round AND blocked the next deal.
  if (fromId != null && fromId === myId) pendingAction = false;
  if (!d || typeof d !== "object" || !validSeatOrder(d.order)) return false;
  // An open table that wandered into a tournament room walks back out of it.
  if (strayInTournamentRoom(d)) return false;
  // A tournament table never runs open-table rules, live or replayed: no bot
  // seats, nobody off the drawn list, no open flag.
  if (tourCtx && !tourSeatsOk(d.order, d.open)) return false;
  // A deal is legal only between rounds. This also collapses two authorities that
  // raced before seeing each other's echo: the first stored deal wins and the
  // second cannot redeal everybody in the middle of the fresh hand.
  if (dealActive) return false;
  const wasStarted = gameStarted;
  if (gameStarted) {
    // ANY SEATED PLAYER may deal the next round — that is exactly the staggered
    // election scheduleNextDeal() runs, so the acceptance here has to match it.
    // This used to demand proxyAuthorityId(-1) (the lowest seat still in
    // presentIds), which froze the whole table whenever that player's phone was
    // asleep: a locked phone never leaves presentIds, so every fallback deal was
    // rejected and no round was ever dealt. Worse, the rejected deals stayed in
    // the stored log and replay skipped this check, so the sleeper later woke
    // into a round of its own while everybody else was still on the old results
    // screen — a split table that never recovered.
    //
    // Deliberately NOT gated on presentIds or on replayingSync: seat order is
    // frozen for the match, so every client and every replay reaches the same
    // verdict, and a stored deal can never be applied by some clients and
    // dropped by others. Receiving the action is itself proof the sender is in
    // the room, and `if (dealActive) return false` above still collapses a deal
    // race to the first stored deal.
    if (fromId == null || !Array.isArray(roomPlayerIds) || roomPlayerIds.indexOf(fromId) < 0) return false;
    // …but not on its own terms. A reset zeroes every score, so mid-match it is
    // only legal on an open table (which resets to seat a newcomer); a chat-invite
    // reset is the rematch, after the match is over.
    if (d.reset && !openTable && activeSeats().length > 1) return false;
    if (d.reset && tourCtx) return false;   // a tournament table plays exactly one match
    // The dealer does not get to pick the cards: a later round's seed is chained
    // from the previous one (see nextRoundSeed). Every client holds the same
    // previous round, so every client reaches the same verdict; a stale one
    // rejects, asks for a catch-up and is healed by the checkpoint.
    if (!d.reset && Number(d.seed) !== nextRoundSeed(curSeed, moveLog)) return false;
  } else if (!replayingSync && tourCtx) {
    // Tournament table: the opening deal is judged against the drawn table list.
    if (!tourOpeningDealOk(d, fromId)) return false;
  } else if (!replayingSync && !(d.open === true || (d.open === undefined && openTable))) {
    const expected = roomPlayerIds[0];   // chat invite: the host owns the opening deal
    if (fromId == null || fromId !== expected || d.order[0] !== expected) return false;
  } else if (!replayingSync) {
    // Opening an OPEN room: the platform host normally deals it, but if they
    // never do (asleep, or already gone) the next present client covers — the
    // same staggered election that keeps later rounds moving. Accept a pre-game
    // deal from anyone the order seats, as long as it still puts the host at
    // seat 0 while the host is actually here.
    if (fromId == null || !Array.isArray(d.order) || d.order.indexOf(fromId) < 0) return false;
    // "while the host is actually here" — and a ghost on the roster is not here.
    // Without isLivePeer() a table abandoned by its host can never be reopened by
    // anybody: every deal that does not seat the departed host at seat 0 is
    // rejected, by every client, forever.
    const head = roomPlayerIds[0];
    if (head != null && presentIds.has(head) && isLivePeer(head) && d.order[0] !== head) return false;
  }
  // Not seated in this match (e.g. wasn't ready when the host started) → stay in
  // the room instead of crashing on a -1 seat.
  if (!gameStarted && Array.isArray(d.order) && d.order.indexOf(myId) < 0) { showNotSeated(); return; }
  applyNames(d.names);                 // adopt host-supplied identities before seating
  applyAvatars(d.avatars);
  if (!gameStarted && !startOnlineGame({ order: d.order })) return;
  if (gameStarted && !sameSeatOrder(d.order, roomPlayerIds)) return;
  else refreshNames();                 // later rounds: update any "Player N" already shown
  // Rematch: the host's reset deal zeroes the whole match before dealing, so
  // every client restarts on the same baseline (replay-safe: a reset deal in
  // the action log re-zeroes deterministically).
  if (d.reset) {
    // keepOut may only keep a seat that every client already has folded, so it
    // reads replayable state alone and cannot fold somebody still in the match.
    const keepOut = (wasStarted && !openTable && Array.isArray(d.keepOut)) ? d.keepOut.filter(s =>
      Number.isInteger(s) && players[s] && players[s].out && s !== d.order.indexOf(fromId)) : [];
    const stillIn = players.length - keepOut.length;
    players.forEach((p, s) => { p.total = 0; p.out = stillIn >= 2 && keepOut.indexOf(s) >= 0; });
    statsRecordedThisGame = false;
    resultReportedThisGame = false;
  }
  document.getElementById("winnerOverlay").classList.remove("show");
  const rs = document.getElementById("rematchStatus");
  if (rs) rs.textContent = "";
  // authoritative starter context from the host → identical leader on every client
  // Range-checked: an out-of-range lastWinner used to throw inside startDeal on
  // every client, leaving the whole table stuck with dealActive set. The
  // threshold is fixed once the match is under way; only a fresh match (or the
  // opening deal) may set it, and only to a value the game offers.
  if (typeof d.firstDeal === "boolean") firstDeal = d.firstDeal;
  if (Number.isInteger(d.lastWinner) && d.lastWinner >= -1 && d.lastWinner < d.order.length) lastWinner = d.lastWinner;
  else if (lastWinner >= d.order.length) lastWinner = -1;
  const loseOk = LOSE_OPTIONS.indexOf(d.loseAt) >= 0 || d.loseAt === OPEN_LOSE_AT;
  if (loseOk && (!wasStarted || d.reset)) loseAt = d.loseAt;
  if (typeof d.open === "boolean") openTable = d.open;   // …and which mode the room runs
  if (tourCtx) openTable = false;                        // never at a tournament table
  curSeed = d.seed; moveLog = [];
  handOverlay.classList.remove("show");
  numPlayers = d.order.length;
  startDeal(d.seed);
  // Whoever DEALT snapshots the fresh round — not "the host", since any client can
  // now deal when the higher-ranked ones are asleep.
  if (!replayingSync && fromId != null && fromId === myId) writeCheckpoint();
  return true;
}
function refreshNames() {
  roomPlayerIds.forEach((id, i) => {
    if (id == null || !players[i] || players[i].isBot || !playerMeta[id]) return;   // bots keep their own name
    if (playerMeta[id].name) players[i].name = playerMeta[id].name;
    players[i].avatar = normalizeAvatar(playerMeta[id].avatar);
  });
  renderMyPlayer();
}

// ════════════════════════════════════════════════════════════════════════
// ── Tournament ──────────────────────────────────────────────────────────
// Same shape as Muushig's daily tournament, without a server of our own:
//
//   registration ─(20:50)→ tables drawn ─(21:00)→ stage 1 ─→ … ─→ final ─→ champion
//
// * Every day at 21:00 Asia/Ulaanbaatar. Registration closes and tables are
//   drawn TOUR_OPEN_MS (10 min) before; players can sit down and wait, but
//   nothing is dealt before the start time.
// * Tables of 2–4, as even as possible (tourTableSizes). One winner per table
//   moves on. A stage never starts before every table of the previous one is
//   finished; TOUR_BREAK_MS between stages; one table left is the final.
// * Not at your table within TOUR_GRACE_MS of the start = out. No bots fill in.
//   Alone at the table when the grace runs out = walkover. Somebody who walks
//   out mid-match folds (the chat-invite rules every table runs on).
// * Fewer than two registrations cancels it.
//
// Where the state lives: Usion.cloud.shared, two kinds of record per event —
//   t13.v1.<startsAt>.reg   {v, list:[{id, n, a}]}       who registered
//   t13.v1.<startsAt>.s<N>  {v, t:{<table>: {w, at}}}    who won each table
// Everything else — the seating of every stage, who plays whom, when the next
// stage starts — is DERIVED (tourDerive) from those two records plus a seed made
// from the event id, so every client computes the same bracket with nobody
// handing it out. The tables themselves are private relay rooms named after
// (event, stage, table) running the normal frozen-roster match.
//
// shared.* is writable by every user of the app, so like the rest of 13 this is
// a trust-the-clients design (see the README's Tournament section).
const TOUR_PREFIX = "t13.v1.";
const TOUR_UTC_HOUR = 13;                 // 21:00 Asia/Ulaanbaatar (UTC+8, no DST) — until the schedule below says otherwise
// From this UTC day on, the event starts at this UTC hour. 2026-11-24 → 19:00 UB.
// Never rewrite a past entry: every phone derives an event's key (t13.v1.<startsAt>)
// from it, so a change to a day that already happened orphans that event's records.
const TOUR_SCHEDULE = [{ from: Date.UTC(2026, 10, 24), hour: 11 }];
const TOUR_OPEN_MS = 10 * 60 * 1000;      // registration closes / tables drawn 10 min before the start
const TOUR_BREAK_MS = 20 * 1000;          // between stages (30 s until 2026-11-23)
const TOUR_GRACE_MS = 30 * 1000;          // no-show cut-off after a table's start, every stage (was 60 s until 2026-11-20)
const TOUR_EMPTY_SETTLE_MS = 30 * 1000;   // after the grace: a table that never got a room had nobody — close it
const TOUR_STALL_MS = 50 * 60 * 1000;     // a table nobody ever reports is closed without a winner
const TOUR_TABLE_MAX = 4;
const TOUR_LOSE_AT = 20;
const TOUR_POLL_MS = 10000;               // Usion allows 60 shared-storage ops/min per user
const TOUR_REG_SETTLE_MS = 20 * 1000;     // after the draw + this, the roster can no longer change
const TOUR_LIVE_MS = 4000;                // a table publishes its scores at most this often
const TOUR_KEEP_MS = 3 * 24 * 3600 * 1000;
const TOUR_REG_GUARD_MS = 10 * 1000;      // no (de)registration in the last seconds before the draw
const TOUR_REG_UNSYNCED_GUARD_MS = 5 * 60 * 1000;   // …or minutes, when the server clock could not be read
// Unsynced, a phone's stamp is only as good as its clock: close earlier rather
// than let a phone that is behind write itself in after the others froze the list.
function tourRegGuardMs() {
  return clockSync.synced || typeof window.fetch !== "function" ? TOUR_REG_GUARD_MS : TOUR_REG_UNSYNCED_GUARD_MS;
}

// ── The tournament's clock ──
// The event runs on absolute times (20:50 draw, 21:00 deal, the grace, the next
// stage's start = last result's `at` + break), compared on every phone. A phone
// whose clock was set by hand can be minutes off: behind, it registered after the
// draw (so phones that froze the roster and phones that read it later derived two
// different brackets, and a table's result was invalid on half of them); ahead,
// it dealt and called walkovers before the others arrived and stamped results in
// the future, holding the next stage back. So all tournament timing reads
// tourNow(): Date.now() corrected by the offset measured against 13's own server
// (GET /api/time, same origin). No server (file:, QA) → offset 0, as before.
const CLOCK_RESYNC_MS = 10 * 60 * 1000;
const clockSync = { offset: 0, synced: false, tried: false, at: 0, busy: null };
function tourNow() { return Date.now() + clockSync.offset; }
function syncClock(force) {
  const f = window.fetch;
  if (typeof f !== "function") { clockSync.tried = true; return Promise.resolve(false); }
  if (clockSync.busy) return clockSync.busy;
  if (!force && clockSync.tried && Date.now() - clockSync.at < CLOCK_RESYNC_MS) return Promise.resolve(clockSync.synced);
  const run = (async () => {
    let best = null;
    for (let i = 0; i < 3; i++) {
      try {
        const t0 = Date.now();
        const res = await f("/api/time", { method: "GET", cache: "no-store" });
        const t1 = Date.now();
        if (!res || !res.ok) break;
        const srv = Number((await res.json() || {}).now);
        if (!Number.isFinite(srv)) break;
        const rtt = t1 - t0;
        // The server read its clock somewhere in the round trip: assume the middle.
        if (rtt <= 5000 && (!best || rtt < best.rtt)) best = { rtt, off: Math.round(srv + rtt / 2 - t1) };
        if (rtt < 300) break;   // good enough
      } catch (_) { break; }
    }
    clockSync.tried = true; clockSync.at = Date.now();
    if (best) {
      // A jump spoils the "unchanged for 3 minutes" bookkeeping kept on the old clock.
      if (Math.abs(best.off - clockSync.offset) > 2000) Object.keys(tourDeadSeen).forEach(k => { delete tourDeadSeen[k]; });
      if (Math.abs(best.off) > 2000) console.warn("tournament clock: this phone is " + Math.round(best.off / 1000) + " s off the server");
      clockSync.offset = best.off; clockSync.synced = true;
    }
    return clockSync.synced;
  })();
  clockSync.busy = run.then(v => { clockSync.busy = null; return v; }, () => { clockSync.busy = null; return false; });
  return clockSync.busy;
}
// Waits for the first measurement, but never longer than `ms`.
function syncClockSoon(ms, force) {
  return Promise.race([syncClock(force), new Promise(r => setTimeout(() => r(clockSync.synced), ms || 3000))]);
}

// QA: ?tourStart=<ISO or epoch ms> (or window.T13_TOUR_START_AT) moves today's event.
function tourOverrideStart() {
  let v = null;
  try { if (window.T13_TOUR_START_AT) v = window.T13_TOUR_START_AT; } catch (_) {}
  try {
    if (v == null && typeof location !== "undefined" && typeof URLSearchParams !== "undefined")
      v = new URLSearchParams(location.search).get("tourStart");
  } catch (_) {}
  if (v == null || v === "") return null;
  const n = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}
const TOUR_DAY_MS = 24 * 3600 * 1000;
// The start of the event held on the UTC day containing `ms`.
function tourStartOn(ms) {
  const day = Math.floor(ms / TOUR_DAY_MS) * TOUR_DAY_MS;
  let hour = TOUR_UTC_HOUR;
  TOUR_SCHEDULE.forEach(e => { if (day >= e.from) hour = e.hour; });
  return day + hour * 3600 * 1000;
}
// The event that is "today's": the next one, or tonight's for a few hours
// after it started, while it may still be running (tourDerive tells which).
function tourCurrentStart(now) {
  const o = tourOverrideStart();
  if (o != null) return o;
  const start = tourStartOn(now);
  return start <= now - 6 * 3600 * 1000 ? tourStartOn(start + TOUR_DAY_MS) : start;   // long finished → tomorrow's
}
// The event after `startsAt` (a schedule change can move its hour).
function tourNextStart(startsAt) {
  return tourOverrideStart() != null ? startsAt + TOUR_DAY_MS : tourStartOn(startsAt + TOUR_DAY_MS);
}
// The time is moving: say so — before the first event at the new time, and on its day.
function tourScheduleNotice(now) {
  if (tourOverrideStart() != null) return "";
  const cur = tour.startsAt || tourCurrentStart(now);
  const next = tourStartOn(cur + TOUR_DAY_MS), prev = tourStartOn(cur - TOUR_DAY_MS);
  const hm = tourFmtClock;
  if (hm(next) !== hm(cur)) return t("tourMoveNext", tourSameDay(next, now) ? 0 : tourSameDay(next, now + TOUR_DAY_MS) ? 1 : 2, hm(next), hm(cur));
  if (hm(prev) !== hm(cur) && now < cur + 3 * 3600 * 1000) return t("tourMoveNow", hm(cur), hm(prev));
  return "";
}
function tourSameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
function tourTableSizes(count) {
  if (count < 2) return count ? [count] : [];
  const tables = Math.ceil(count / TOUR_TABLE_MAX), base = Math.floor(count / tables), extra = count % tables;
  return Array.from({ length: tables }, (_, i) => base + (i < extra ? 1 : 0));
}
function tourHash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function tourShuffle(ids, seed) {
  const list = ids.slice().sort(), rnd = mulberry32(seed);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const x = list[i]; list[i] = list[j]; list[j] = x;
  }
  return list;
}
// roster: [{id, n, a}] · results: {stageNo: {tableNo: {w, at}}} → the whole event.
function tourDerive(startsAt, roster, results, now) {
  const seen = new Set();
  // A row stamped at or after the draw came from a phone whose clock let it in
  // late; phones that froze the roster at the draw never saw it, so nobody counts
  // it (rows from older builds carry no stamp and count, as before).
  const people = (roster || []).filter(p => p && typeof p.id === "string" &&
      !(Number.isFinite(p.t) && p.t >= startsAt - TOUR_OPEN_MS) && !seen.has(p.id) && seen.add(p.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tt = { startsAt, closesAt: startsAt - TOUR_OPEN_MS, phase: "registration", people,
               stages: [], championId: null, reason: null, nextStageAt: null };
  if (now < tt.closesAt) return tt;
  let ids = people.map(p => p.id);
  if (ids.length < 2) { tt.phase = "cancelled"; tt.reason = "few"; return tt; }
  let stageStart = startsAt;
  for (let n = 1; n <= 12; n++) {
    const order = tourShuffle(ids, tourHash(startsAt + ":" + n));
    const res = (results && results[n]) || {};
    let off = 0;
    const matches = tourTableSizes(ids.length).map((size, i) => {
      const playerIds = order.slice(off, off += size);
      const r = res[i + 1];
      const valid = !!r && (r.w === null || playerIds.indexOf(r.w) >= 0);
      const m = { number: i + 1, playerIds, done: valid, winnerId: valid ? r.w : null,
                  at: valid ? Number(r.at) || stageStart : 0 };
      if (!m.done && now >= stageStart + TOUR_STALL_MS) { m.done = true; m.at = stageStart + TOUR_STALL_MS; }
      return m;
    });
    const stage = { number: n, startAt: stageStart, isFinal: matches.length === 1, matches };
    tt.stages.push(stage);
    if (!matches.every(m => m.done)) {
      tt.phase = now < stageStart ? (n === 1 ? "waiting" : "between") : "playing";
      if (tt.phase === "between") tt.nextStageAt = stageStart;
      return tt;
    }
    const winners = matches.map(m => m.winnerId).filter(Boolean);
    if (!winners.length) { tt.phase = "cancelled"; tt.reason = "empty"; return tt; }
    if (winners.length === 1) { tt.phase = "complete"; tt.championId = winners[0]; return tt; }
    ids = winners;
    stageStart = Math.max.apply(null, matches.map(m => m.at)) + TOUR_BREAK_MS;
  }
  return tt;
}
// Where do I stand? guest | registered | waiting | playing | qualified | eliminated | champion
function tourMyStatus(tt, id) {
  if (!tt.people.some(p => p.id === id)) return "guest";
  if (tt.championId === id) return "champion";
  if (tt.phase === "registration") return "registered";
  if (tt.phase === "cancelled") return "eliminated";
  const stage = tt.stages[tt.stages.length - 1];
  const m = stage && stage.matches.find(x => x.playerIds.indexOf(id) >= 0);
  if (!m) return "eliminated";
  if (!m.done) return tt.phase === "waiting" || tt.phase === "between" ? "waiting" : "playing";
  return m.winnerId === id ? "qualified" : "eliminated";
}

// ── Shared storage ──
const tour = { startsAt: 0, roster: [], results: {}, live: {}, loaded: false, busy: false, pollTimer: null, tickTimer: null,
               rosterFinal: false, stageFinal: {}, pollN: 0,
               reported: {} };   // results we still owe the board: key#table → {stage, table, w}
function tourShared() {
  const s = window.Usion && Usion.cloud && Usion.cloud.shared;
  return s && typeof s.get === "function" && typeof s.set === "function" ? s : null;
}
// One record: ~200 rows of {id, n, a} (avatar url capped) fit its 64 KB.
function tourRegKey(startsAt) { return TOUR_PREFIX + startsAt + ".reg"; }
function tourStageKey(startsAt, n) { return TOUR_PREFIX + startsAt + ".s" + n; }
function tourLiveKey(startsAt, n) { return TOUR_PREFIX + startsAt + ".l" + n; }
function tourListOf(rec) { return rec && Array.isArray(rec.list) ? rec.list.filter(x => x && typeof x.id === "string") : []; }
// Reads only what can still change: the registrations until shortly after the
// draw, the stages not yet finished, and the live scores of the stage in play.
async function tourLoad() {
  const shared = tourShared();
  if (!clockSync.tried) await syncClockSoon(3000);
  else syncClock();          // every 10 minutes, in the background
  const now = tourNow();
  const startsAt = tourCurrentStart(now);
  if (startsAt !== tour.startsAt) {
    tour.startsAt = startsAt; tour.roster = []; tour.results = {}; tour.live = {};
    tour.rosterFinal = false; tour.stageFinal = {}; tour.loaded = false;
  }
  // Outside the Usion app there is no signed-in player and no server to read:
  // say so on the card instead of waiting on a load that can never finish.
  if (!shared || !myId) { tour.loaded = true; return; }
  try {
    if (!tour.rosterFinal) {
      tour.roster = tourListOf(await shared.get(tourRegKey(startsAt)));
      if (now >= startsAt - TOUR_OPEN_MS + TOUR_REG_SETTLE_MS) tour.rosterFinal = true;
    }
    for (let n = 1; n <= 12; n++) {
      const d = tourDerive(startsAt, tour.roster, tour.results, tourNow());
      if (d.stages.length < n) break;
      if (tour.stageFinal[n]) continue;
      const rec = await shared.get(tourStageKey(startsAt, n));
      tour.results[n] = rec && rec.t && typeof rec.t === "object" ? rec.t : {};
      const after = tourDerive(startsAt, tour.roster, tour.results, tourNow()).stages[n - 1];
      if (after && after.matches.every(m => m.done)) tour.stageFinal[n] = true;
    }
    const d = tourDerive(startsAt, tour.roster, tour.results, tourNow());
    const stage = d.stages[d.stages.length - 1];
    if (d.phase === "playing" && stage) {
      const live = await shared.get(tourLiveKey(startsAt, stage.number)).catch(() => null);
      tour.live[stage.number] = live && live.t && typeof live.t === "object" ? live.t : {};
    }
    tour.loaded = true;
    tourForceClose(startsAt);
    tourReassert();
    tourCloseEmptyTables();
    tourCloseDeadTables();
    if (d.phase === "complete") tourRecordChampion(d);
  } catch (e) {
    console.warn("tournament load failed", e);
    tour.loaded = true;   // a dead, silent button is worse: a tap now retries and explains a failure
  }
}
// Tables closed by hand, without a winner — exactly what the 50-minute stall
// would do, only sooner. Whoever loads the event first files the close in the
// stage record, so every client (old builds too) sees the table done.
//   2026-11-20 21:00 stage 1 table 3: the last table, holding up stage 2.
const TOUR_FORCE_CLOSE = [{ startsAt: 1795179600000, stage: 1, table: 3 }];
function tourForceClose(startsAt) {
  TOUR_FORCE_CLOSE.forEach(f => {
    if (f.startsAt !== startsAt) return;
    const res = tour.results[f.stage];
    if (!res || res[f.table] !== undefined) return;
    tourReport(startsAt, f.stage, f.table, null);
  });
}
// Read-modify-write with a check afterwards. Two writers landing together can
// drop one entry; whoever was dropped notices on the re-read and writes again.
async function tourUpdate(key, mutate, isDone) {
  const shared = tourShared();
  if (!shared) throw new Error("no shared storage");
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await shared.get(key);
    const next = mutate(cur);
    if (next) await shared.set(key, next);
    await new Promise(r => setTimeout(r, 900 + attempt * 500));
    const check = await shared.get(key);
    if (isDone(check)) return check;
  }
  throw new Error("could not update " + key);
}
function tourMe() {
  const a = myAvatar && String(myAvatar).length <= 200 ? myAvatar : null;
  return { id: myId, n: String(myName || t("you")).slice(0, 24), a };
}
async function tourRegister() {
  if (!tourShared() || !myId) { toast(t("tourNoCloud")); return; }
  if (tour.busy) return;
  tour.busy = true; tourRender();
  await syncClockSoon(4000, true);   // a fresh reading: this is the write the draw depends on
  if (tourNow() >= tour.startsAt - TOUR_OPEN_MS - tourRegGuardMs()) { tour.busy = false; tourRender(); return; }
  try {
    const has = rec => !!rec && Array.isArray(rec.list) && rec.list.some(p => p && p.id === myId);
    await tourUpdate(tourRegKey(tour.startsAt), cur => {
      if (has(cur)) return null;
      const list = tourListOf(cur);
      list.push(Object.assign(tourMe(), { t: tourNow() }));
      return { v: 1, list };
    }, has);
    tour.roster = tour.roster.filter(x => x.id !== myId).concat([tourMe()]);
    await tourLoad();   // and everybody else who registered meanwhile
    tourRemindLoad(true);   // → the reminder offer, unless they already decided
    tourCleanup();
  } catch (e) { console.warn(e); toast(t("tourRegFail")); }
  tour.busy = false; tourRender();
}
async function tourWithdraw() {
  if (tour.busy) return;
  tour.busy = true; tourRender();
  await syncClockSoon(4000, true);
  if (tourNow() >= tour.startsAt - TOUR_OPEN_MS - tourRegGuardMs()) { tour.busy = false; tourRender(); return; }
  try {
    const gone = rec => !rec || !Array.isArray(rec.list) || !rec.list.some(p => p && p.id === myId);
    await tourUpdate(tourRegKey(tour.startsAt), cur => {
      if (gone(cur)) return null;
      return { v: 1, list: tourListOf(cur).filter(x => x.id !== myId) };
    }, gone);
    tour.roster = tour.roster.filter(x => x.id !== myId);
    tourRemindWithdrawn(tour.startsAt);
    await tourLoad();
  } catch (e) { console.warn(e); toast(t("tourRegFail")); }
  tour.busy = false; tourRender();
}
// File a table's winner (null = nobody). The first result filed stands; we keep
// owing ours until the board shows one, so a write lost in a race comes back.
function tourReport(startsAt, stage, table, winnerId, fixedAt) {
  const key = tourStageKey(startsAt, stage);
  const id = key + "#" + table;
  if (tour.reported[id] && tour.reported[id].inFlight) return;
  const entry = { stage, table, w: winnerId, at: fixedAt, inFlight: true };
  tour.reported[id] = entry;
  const at = Number.isFinite(fixedAt) ? fixedAt : tourNow();
  const filed = rec => !!rec && !!rec.t && rec.t[table] !== undefined;
  tourUpdate(key, cur => {
    if (filed(cur)) return null;
    const tt = Object.assign({}, cur && cur.t);
    tt[table] = { w: winnerId, at };
    return { v: 1, t: tt };
  }, filed).then(rec => {
    delete tour.reported[id];
    if (startsAt === tour.startsAt) tour.results[stage] = rec.t;
    tourRender();
    tourRenderShareButtons();
  }).catch(e => { entry.inFlight = false; console.warn("tournament report failed", e); });
}
function tourReassert() {
  Object.keys(tour.reported).forEach(k => {
    const e = tour.reported[k];
    if (e.inFlight) return;
    const res = tour.results[e.stage];
    if (res && res[e.table] !== undefined) { delete tour.reported[k]; return; }
    tourReport(tour.startsAt, e.stage, e.table, e.w, e.at);
  });
}
// The shared bucket holds 200 keys: drop events older than a few days.
function tourCleanup() {
  const shared = tourShared();
  if (!shared || typeof shared.keys !== "function" || typeof shared.remove !== "function") return;
  Promise.resolve().then(() => shared.keys()).then(keys => {
    (keys || []).forEach(k => {
      const m = /^t13\.v1\.(\d+)\./.exec(k);
      if (m && Number(m[1]) < tourNow() - TOUR_KEEP_MS) Promise.resolve(shared.remove(k)).catch(() => {});
    });
  }).catch(() => {});
}

// ── Tables nobody came to ──
// 2026-11-17: 13 of 26 first-stage tables had nobody at all. Nobody filed their
// result, so they closed only by the 50-minute stall and the second stage waited
// until 21:50. The first person to sit down at a table publishes its room
// (tourTableRoom), before the start. So once the 30 s grace is over (plus a
// settle), a table with no room in the record had nobody: any client looking at
// the event files it closed without a winner, at the moment the grace ended, so
// every client derives the same next-stage time. It only adds entries, never
// replaces one, and a table at play keeps its room in the record (tourCheckRoom).
let tourEmptyDone = {};
function tourCloseEmptyTables() {
  const shared = tourShared();
  if (!shared || !tourRestBase()) return;           // local preview: tables have no published rooms
  const now = tourNow();
  const tt = tourDerive(tour.startsAt, tour.roster, tour.results, now);
  const stage = tt.stages[tt.stages.length - 1];
  if (!stage || tt.phase !== "playing" || now < stage.startAt + TOUR_GRACE_MS + TOUR_EMPTY_SETTLE_MS) return;
  const doneKey = tour.startsAt + ":" + stage.number;
  if (tourEmptyDone[doneKey]) return;
  const open = stage.matches.filter(m => !m.done);
  if (!open.length) return;
  tourEmptyDone[doneKey] = true;                    // once per stage per client; others cover a failure
  const closeAt = stage.startAt + TOUR_GRACE_MS;
  Promise.resolve().then(() => shared.get(tourRoomKey(tour.startsAt, stage.number))).then(rooms => {
    const has = n => !!rooms && !!rooms.t && typeof rooms.t[n] === "string";
    const empty = open.filter(m => !has(m.number)).map(m => m.number);
    if (!empty.length) return;
    const key = tourStageKey(tour.startsAt, stage.number);
    return tourUpdate(key, cur => {
      const t0 = Object.assign({}, cur && cur.t);
      let changed = false;
      empty.forEach(n => { if (t0[n] === undefined) { t0[n] = { w: null, at: closeAt }; changed = true; } });
      return changed ? { v: 1, t: t0 } : null;
    }, cur => !!cur && !!cur.t && empty.every(n => cur.t[n] !== undefined)).then(rec => {
      if (tour.startsAt === Number(doneKey.split(":")[0])) tour.results[stage.number] = rec.t;
      tourRender();
    });
  }).catch(e => { delete tourEmptyDone[doneKey]; console.warn("closing empty tables failed", e); });
}
// ── Tables nobody is running ──
// The table that held up the event every evening (2026-11-20, -21, -22): its
// players sat down early (auto-entry after the draw), so it HAS a room and the
// empty-table close above skips it, and then they were gone by the start: app
// closed, phone locked, back to the menu. Nobody at the table runs anything, so
// nobody files a result, and the next stage waited for the 50-minute stall.
// Every client at a table re-posts its picture every TOUR_BEAT_MS (lobby
// included), so a picture that stays unchanged, or missing, for TOUR_DEAD_MS
// on OUR clock (phone clocks disagree; what we saw change does not) means
// nobody is there. Two open tables are looked at per load, round-robin, and the
// table is filed closed now, without a winner, unless its last picture already
// shows one. The first result filed stands, so a race with a real result is
// harmless.
const tourDeadSeen = {};   // "startsAt:stage:table" → {sig, since}
let tourDeadCursor = 0;
function tourCloseDeadTables() {
  const shared = tourShared();
  if (!shared || !tourRestBase()) return;            // local preview: no heartbeats to read
  const now = tourNow();
  const startsAt = tour.startsAt;
  const tt = tourDerive(startsAt, tour.roster, tour.results, now);
  const stage = tt.stages[tt.stages.length - 1];
  if (!stage || tt.phase !== "playing" || now < stage.startAt + TOUR_GRACE_MS + TOUR_EMPTY_SETTLE_MS) return;
  const open = stage.matches.filter(m => !m.done && !(tourCtx && tourCtx.stage === stage.number && tourCtx.table === m.number));
  if (!open.length) return;
  const pick = [];
  for (let i = 0; i < Math.min(2, open.length); i++) pick.push(open[(tourDeadCursor + i) % open.length]);
  tourDeadCursor = (tourDeadCursor + pick.length) % open.length;
  pick.forEach(m => {
    Promise.resolve().then(() => shared.get(tourWatchKey(startsAt, stage.number, m.number))).then(rec => {
      if (tour.startsAt !== startsAt) return;
      const k = startsAt + ":" + stage.number + ":" + m.number;
      const sig = rec && rec.at != null ? String(rec.at) : "none";
      const seen = tourDeadSeen[k], t0 = tourNow();
      if (!seen || seen.sig !== sig) { tourDeadSeen[k] = { sig, since: t0 }; return; }
      if (t0 - seen.since < TOUR_DEAD_MS) return;
      const res = tour.results[stage.number];
      if (res && res[m.number] !== undefined) return;
      const w = rec && rec.w != null && m.playerIds.indexOf(rec.w) >= 0 ? rec.w : null;
      console.warn("tournament: closing table " + stage.number + "/" + m.number + ", no sign of life for " + Math.round((t0 - seen.since) / 1000) + " s");
      tourReport(startsAt, stage.number, m.number, w);
    }).catch(() => {});
  });
}
// ── Screen ──
var tourCtx = null;   // while at a tournament table: {startsAt, stage, table, roster, startAt, isFinal, walkover}
function tourFmtClock(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function tourFmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0")
           : m + ":" + String(sec).padStart(2, "0");
}
function tourWhen(ms, now) {
  const a = new Date(ms), b = new Date(now);
  const same = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return same ? t("tourToday", tourFmtClock(ms)) : t("tourTomorrow", tourFmtClock(ms));
}
function tourPerson(id) {
  const p = tour.roster.find(x => x && x.id === id);
  return p ? { id, name: p.n || "?", avatar: p.a || null } : { id, name: "?", avatar: null };
}
function openTournament() {
  hideTourInvite();
  hideMenu();
  const ov = document.getElementById("tourOverlay");
  if (ov) ov.classList.add("show");
  document.body.classList.add("tour-open");
  if (!tour.startsAt) tour.startsAt = tourCurrentStart(tourNow());
  tourFillRules();
  tourRender();
  tourLoad().then(tourRender);
  tourRemindLoad();
  tourCleanup();
  if (!tour.pollTimer) tour.pollTimer = setInterval(() => {
    const visible = ov && ov.classList.contains("show");
    tour.pollN++;
    // On the screen: every 10 s. At a table: every 30 s, only to re-file a lost result.
    if (visible || ((tourCtx || tourWatching) && tour.pollN % 3 === 0)) tourLoad().then(tourRender);
  }, TOUR_POLL_MS);
  if (!tour.tickTimer) tour.tickTimer = setInterval(() => {
    if (ov && ov.classList.contains("show")) tourRender();
    if (tourCtx) tourTableTick();
    if (tourWatching) { tourWatchCheckMine(); tourWatchClock(); }
  }, 1000);
}
function closeTournament() {
  const ov = document.getElementById("tourOverlay");
  if (ov) ov.classList.remove("show");
  document.body.classList.remove("tour-open");
  showMenu();
}
// Replace a container's children only when the new content differs, so the
// per-second redraw never recreates avatars (flicker) or resets what was touched.
function tourSwap(el, fresh) {
  if (fresh.innerHTML === el.innerHTML) return;
  el.innerHTML = "";
  Array.prototype.slice.call(fresh.childNodes).forEach(n => el.appendChild(n));
}
function tourEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function tourRender() {
  const ov = document.getElementById("tourOverlay");
  if (!ov || !ov.classList.contains("show")) return;
  const now = tourNow();
  const tt = tourDerive(tour.startsAt || tourCurrentStart(now), tour.roster, tour.results, now);
  const st = tourMyStatus(tt, myId);
  const stLabel = { guest: "tourStGuest", registered: "tourStRegistered", waiting: "tourStWaiting", playing: "tourStPlaying",
                    qualified: "tourStQualified", eliminated: "tourStEliminated", champion: "tourStChampion" };
  const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
  set("tourWhen", tourWhen(tt.startsAt, now));
  const notice = document.getElementById("tourNotice");
  if (notice) { const txt = tourScheduleNotice(now); notice.textContent = txt; notice.hidden = !txt; }
  set("tourCountdown", now < tt.startsAt ? t("tourStartsIn", tourFmtLeft(tt.startsAt - now)) : "");
  set("tourCount", t("tourRegistered", tt.people.length));
  const pill = document.getElementById("tourStatus");
  const cancelled = tt.phase === "cancelled" && st !== "champion";
  if (pill) {
    pill.textContent = t(cancelled ? "tourStCancelled" : stLabel[st]);
    pill.className = "tour-pill st-" + (cancelled ? "cancelled" : st);
  }

  // The one next thing to do.
  const primary = document.getElementById("tourPrimary");
  const secondary = document.getElementById("tourSecondary");
  let note = "", act = null, sec = null;
  const regOpen = now < tt.closesAt - tourRegGuardMs();
  const stage = tt.stages[tt.stages.length - 1];
  if (tt.phase === "registration") {
    if (st === "guest") { act = regOpen ? "register" : null; note = regOpen ? t("tourNoteReg", tourFmtClock(tt.closesAt)) : t("tourNoteClosed", tourWhen(tourNextStart(tt.startsAt), now)); }
    else { note = t("tourNoteRegDone", tourFmtClock(tt.closesAt)); sec = regOpen ? "withdraw" : null; }
  } else if (tt.phase === "cancelled") {
    note = tt.reason === "few" ? t("tourNoteFew") : t("tourNoteEmpty"); act = "menu";
  } else if (st === "guest") { note = tt.phase === "complete" ? "" : t("tourNoteLive", tourWhen(tourNextStart(tt.startsAt), now)); act = "menu"; }
  else if (st === "waiting") {
    note = tt.phase === "between" ? t("tourNoteNextIn", tourFmtLeft(tt.nextStageAt - now)) : t("tourNoteWaiting");
    act = "enter";
  } else if (st === "playing") { note = t("tourNotePlaying"); act = "enter"; }
  else if (st === "qualified") {
    const rest = stage.matches.filter(m => !m.done);
    note = t("tourNoteQualified", stage.matches.length - rest.length, stage.matches.length,
             rest.length && rest.length <= 3 ? rest.map(m => t("tourTable", m.number)).join(", ") : "");
  } else if (st === "eliminated") { note = t("tourNoteEliminated"); act = "menu"; }
  else if (st === "champion") { note = t("tourNoteChampion"); act = null; }   // the share button is their next step
  if (!tourShared() || !myId) note = t("tourNoCloud");
  set("tourNote", note);
  if (primary) {
    primary.style.display = act ? "block" : "none";
    primary.dataset.act = act || "";
    primary.disabled = tour.busy || !tour.loaded;
    primary.textContent = act === "register" ? t("tourRegister") : act === "enter" ? t("tourEnter") : t("tourToMenu");
  }
  if (secondary) {
    secondary.style.display = sec ? "block" : "none";
    secondary.disabled = tour.busy;
    secondary.textContent = t("tourWithdraw");
  }

  // Champion banner
  const champ = document.getElementById("tourChampion");
  if (champ) {
    champ.style.display = tt.championId ? "flex" : "none";
    const fresh = document.createElement("div");
    if (tt.championId) {
      const p = tourPerson(tt.championId);
      fresh.appendChild(tourEl("span", "tour-champ-cup", "🏆"));
      fresh.appendChild(makeAvatarEl(p.name, p.avatar, "tour-avatar", false));
      const txt = tourEl("div", "tour-champ-text");
      txt.appendChild(tourEl("div", "tour-champ-label", t("tourChampion")));
      txt.appendChild(tourEl("div", "tour-champ-name", p.id === myId ? t("you") : p.name));
      fresh.appendChild(txt);
    }
    tourSwap(champ, fresh);
  }

  tourRenderPrize(tt);
  tourRenderRemind();
  tourMaybeAutoEnter(tt, st);

  // Entrants while registration is open, the bracket after the draw.
  const bodyEl = document.getElementById("tourBody");
  if (!bodyEl) return;
  const body = document.createElement("div");
  if (tt.phase === "registration" || (tt.phase === "cancelled" && tt.reason === "few")) {
    body.appendChild(tourEl("div", "tour-section", t("tourEntrants")));
    if (!tt.people.length) body.appendChild(tourEl("p", "tour-empty", t("tourNoEntrants")));
    tt.people.forEach(p => {
      const row = tourEl("div", "tour-row" + (p.id === myId ? " me" : ""));
      row.appendChild(makeAvatarEl(p.n, p.a, "tour-avatar", false));
      row.appendChild(tourEl("span", "tour-name", shortName(p.n)));
      const wins = tourWinsOf(p.id);
      if (wins) row.appendChild(tourEl("span", "tour-trophies", "🏆 " + wins));
      if (p.id === myId) row.appendChild(tourEl("span", "tour-tag", t("you")));
      body.appendChild(row);
    });
  }
  tt.stages.slice().reverse().forEach(s => {
    const done = s.matches.filter(m => m.done).length;
    const head = tourEl("div", "tour-section tour-stage-head");
    head.appendChild(tourEl("span", null, s.isFinal ? t("tourFinal") : t("tourStage", s.number)));
    head.appendChild(tourEl("span", "tour-stage-count", t("tourStageDone", done, s.matches.length)));
    body.appendChild(head);
    s.matches.forEach(m => {
      const mine = m.playerIds.indexOf(myId) >= 0;
      const card = tourEl("div", "tour-table" + (mine ? " mine" : "") + (m.done ? " done" : ""));
      const live = !m.done && s === tt.stages[tt.stages.length - 1] && tt.phase === "playing"
        ? (tour.live[s.number] || {})[m.number] : null;
      const top = tourEl("div", "tour-table-head");
      top.appendChild(tourEl("span", "tour-table-no", t("tourTable", m.number)));
      if (live) top.appendChild(tourEl("span", "tour-live", t("tourLive", live.r || 1)));
      if (mine) top.appendChild(tourEl("span", "tour-tag", t("tourYours")));
      // Every unfinished table of the stage in play. Not only those with live
      // scores: 2026-11-20 the last table of stage 1 was playing with its live
      // entry lost, and everyone waiting on it had no way to look. A table with
      // no picture (nobody came, still in its lobby) sends the watcher back
      // after TOUR_WATCH_GIVEUP_MS instead of "waiting" forever (2026-11-19).
      else if (!m.done && s === tt.stages[tt.stages.length - 1] && tt.phase === "playing" && now >= s.startAt) {
        const wb = tourEl("button", "tour-watch-btn");
        wb.type = "button";
        wb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
        wb.appendChild(tourEl("span", null, t("tourWatch")));
        wb.dataset.watchStage = s.number; wb.dataset.watchTable = m.number;
        top.appendChild(wb);
      }
      card.appendChild(top);
      const outs = live && Array.isArray(live.o) ? live.o : [];
      m.playerIds.forEach(id => {
        const p = tourPerson(id);
        const won = m.done && m.winnerId === id, lost = (m.done && m.winnerId !== id) || outs.indexOf(id) >= 0;
        const row = tourEl("div", "tour-seat" + (won ? " won" : "") + (lost ? " lost" : ""));
        row.appendChild(makeAvatarEl(p.name, p.avatar, "tour-avatar sm", false));
        row.appendChild(tourEl("span", "tour-name", id === myId ? t("you") : shortName(p.name)));
        if (won) row.appendChild(tourEl("span", "tour-win", "✓"));
        else if (live && live.s && Number.isFinite(Number(live.s[id]))) {
          row.appendChild(tourEl("span", "tour-score" + (outs.indexOf(id) >= 0 ? " out" : ""),
            outs.indexOf(id) >= 0 ? t("tourOut") : t("tourPts", Number(live.s[id]), TOUR_LOSE_AT)));
        }
        card.appendChild(row);
      });
      body.appendChild(card);
    });
  });
  tourRenderFame(body);
  tourSwap(bodyEl, body);
}
// The rules never change: written once, and left alone by the per-second redraw.
function tourFillRules() {
  const title = document.getElementById("tourRulesTitle");
  const list = document.getElementById("tourRulesList");
  const at = tour.startsAt || tourCurrentStart(tourNow()), sig = LANG + ":" + at;
  if (!title || !list || list.dataset.lang === sig) return;
  list.dataset.lang = sig;
  title.textContent = t("tourRules");
  list.innerHTML = "";
  t("tourRulesList").forEach(line => list.appendChild(tourEl("li", null,
    typeof line === "function" ? line(tourFmtClock(at), tourFmtClock(at - TOUR_OPEN_MS)) : line)));
}

// ── At the table ──
function tourEnterTable() {
  const now = tourNow();
  const tt = tourDerive(tour.startsAt, tour.roster, tour.results, now);
  const stage = tt.stages[tt.stages.length - 1];
  const m = stage && stage.matches.find(x => x.playerIds.indexOf(myId) >= 0 && !x.done);
  if (!m) { tourRender(); return; }
  if (tourCtx && tourCtx.startsAt === tt.startsAt && tourCtx.stage === stage.number && tourCtx.table === m.number) return;
  if (!(window.Usion && Usion.game)) { toast(t("tourNoCloud")); return; }
  const tkey = tourTableKey(stage.number, m.number);
  if (!tourArrivedAt[tkey]) tourArrivedAt[tkey] = now;
  tourCtx = { startsAt: tt.startsAt, stage: stage.number, table: m.number, roster: m.playerIds.slice(),
              startAt: stage.startAt, isFinal: stage.isFinal, walkover: false, arrivedAt: tourArrivedAt[tkey] };
  document.getElementById("tourOverlay").classList.remove("show");
  document.body.classList.remove("tour-open");
  hideMenu();
  resetRoomState();
  openTable = false; online = true;
  myReady = true; lobbyReady = {};
  loseAt = TOUR_LOSE_AT;
  document.getElementById("winnerOverlay").classList.remove("show");
  onlineOverlay.classList.add("show");
  renderLobby();
  const ctx = tourCtx;
  const failed = (why) => {
    console.warn("tournament table join failed:", why);
    if (tourCtx !== ctx) return;
    tourSkip[tourTableKey(ctx.stage, ctx.table)] = true;
    tourBackToScreen();
    toast(t("tourJoinFail"));          // never fail silently: the player taps «Ширээндээ орох» again
  };
  tourTableRoom(ctx).then(roomId => {
    if (tourCtx !== ctx) return;
    ctx.roomId = roomId;
    return setupMultiplayer(roomId).then(() => { if (tourCtx === ctx && !online) failed("relay join"); });
  }).catch(e => failed(e && e.message));
}
// ── Real rooms for tournament tables ──
// The relay admits only rooms that EXIST and only their PLAYERS (backend
// realtime/game_handlers.py → handle_game_join: ROOM_NOT_FOUND / NOT_PARTICIPANT).
// A room id cannot be chosen, so the first player at a table creates one over
// REST (POST {apiUrl}/games/rooms), publishes its id in the shared record
//   t13.v1.<startsAt>.r<stage>  {v, t:{<table>: roomId}}
// and everybody else joins it (POST /games/rooms/{id}/join) before game:join.
function tourRoomKey(startsAt, stage) { return TOUR_PREFIX + startsAt + ".r" + stage; }
function tourRestBase() {
  const cfg = (window.Usion && Usion.config) || {};
  return cfg.apiUrl ? String(cfg.apiUrl).replace(/\/+$/, "") : null;
}
async function tourRest(path, body) {
  const base = tourRestBase(), f = window.fetch;
  if (!base || typeof f !== "function") return { status: 0 };
  // The host can mint the token a few seconds after launch: wait for it.
  for (let waited = 0; !tourAuthToken() && waited < 8000; waited += 500) await new Promise(r => setTimeout(r, 500));
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = tourAuthToken();
    if (!token) return { status: 401 };
    try {
      const res = await f(base + path, { method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(body || {}) });
      if (res.status === 401 && attempt === 0) { await new Promise(r => setTimeout(r, 1500)); continue; }
      let data = null;
      try { data = await res.json(); } catch (_) {}
      return { status: res.status, data };
    } catch (e) { return { status: 0, error: e && e.message }; }
  }
  return { status: 0 };
}
const tourOk = r => r && r.status >= 200 && r.status < 300;
async function tourCreateRoom() {
  const cfg = (window.Usion && Usion.config) || {};
  const r = await tourRest("/games/rooms", { service_id: cfg.serviceId });
  if (!tourOk(r) || !r.data || !r.data.id) throw new Error("create room failed (" + r.status + ")");
  return String(r.data.id);
}
async function tourTableRoom(ctx) {
  const cfg = (window.Usion && Usion.config) || {};
  // Outside the Usion host (local preview) there is no REST: a named room is all there is.
  if (!tourRestBase() || !cfg.serviceId) return "t13-" + ctx.startsAt + "-s" + ctx.stage + "-t" + ctx.table;
  const shared = tourShared();
  if (!shared) throw new Error("no shared storage");
  const key = tourRoomKey(ctx.startsAt, ctx.stage), table = ctx.table;
  const roomOf = rec => rec && rec.t && typeof rec.t[table] === "string" ? rec.t[table] : null;
  const claim = (fresh, replacing) => tourUpdate(key, cur => {
    const now = roomOf(cur);
    if (now && now !== replacing) return null;           // somebody else's room stands
    const tt = Object.assign({}, cur && cur.t); tt[table] = fresh;
    return { v: 1, t: tt };
  }, cur => !!roomOf(cur) && roomOf(cur) !== replacing);
  for (let attempt = 0; attempt < 3; attempt++) {
    let id = roomOf(await Promise.resolve().then(() => shared.get(key)).catch(() => null));
    if (id) {
      const j = await tourRest("/games/rooms/" + encodeURIComponent(id) + "/join");
      if (tourOk(j)) return id;
      if (j.status !== 404 && !(j.status === 400 && /finished/i.test((j.data && j.data.detail) || ""))) {
        throw new Error("join room failed (" + j.status + ")");
      }
      // The published room is gone: replace it, unless somebody already did.
      const fresh = await tourCreateRoom();
      const now = roomOf(await claim(fresh, id));
      if (now === fresh) return fresh;
      continue;
    }
    const fresh = await tourCreateRoom();
    const now = roomOf(await claim(fresh, null));
    if (now === fresh) return fresh;
    // Lost the race to publish: join the room that won (ours stays empty).
    const j = await tourRest("/games/rooms/" + encodeURIComponent(now) + "/join");
    if (tourOk(j)) return now;
  }
  throw new Error("no room for this table");
}
// Two players can each publish a room in the same instant. Until the deal, keep
// checking the shared record and move to the room it names.
function tourCheckRoom(ctx) {
  const shared = tourShared();
  if (!shared || !ctx.roomId || !tourRestBase() || ctx.moving) return;
  const now = tourNow();
  if (now - (ctx.roomCheckAt || 0) < 5000) return;
  ctx.roomCheckAt = now;
  const key = tourRoomKey(ctx.startsAt, ctx.stage), table = ctx.table;
  Promise.resolve().then(() => shared.get(key)).then(rec => {
    const id = rec && rec.t && typeof rec.t[table] === "string" ? rec.t[table] : null;
    if (!id && tourCtx === ctx) {
      // Our room fell out of the record (two read-modify-writes crossed). Put it
      // back: a table with no room is a table nobody came to, and gets closed.
      return tourUpdate(key, cur => {
        if (cur && cur.t && typeof cur.t[table] === "string") return null;
        const tt = Object.assign({}, cur && cur.t); tt[table] = ctx.roomId;
        return { v: 1, t: tt };
      }, cur => !!cur && !!cur.t && typeof cur.t[table] === "string").catch(() => {});
    }
    if (!id || id === ctx.roomId || tourCtx !== ctx || gameStarted || dealActive || roomAlreadyRunning()) return;
    ctx.moving = true;
    return tourRest("/games/rooms/" + encodeURIComponent(id) + "/join").then(j => {
      if (!tourOk(j) || tourCtx !== ctx || gameStarted) return;
      try { if (Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
      resetRoomState();
      openTable = false; online = true;
      ctx.roomId = id;
      renderLobby();
      return setupMultiplayer(id);
    });
  }).catch(() => {}).finally(() => { ctx.moving = false; });
}
// Opening deal of a tournament table: anybody on this table's list may deal,
// seat 0 being the dealer, and only to people on the list. Judged on the deal
// alone (no presence), so every client and every replay agrees.
function tourOpeningDealOk(d, fromId) {
  if (!tourCtx || !d || !Array.isArray(d.order)) return false;
  const r = tourCtx.roster;
  if (fromId == null || d.order[0] !== fromId || r.indexOf(fromId) < 0) return false;
  if (d.order.length < 2 || new Set(d.order).size !== d.order.length) return false;
  if (!d.order.every(id => r.indexOf(id) >= 0)) return false;
  return d.open === false && d.loseAt === TOUR_LOSE_AT && !d.reset;
}
var tourDealAt = 0;
// Our table was filed while we were still at it, and not by us: closed as dead
// while this phone slept, or finished while we were away. Back to the bracket.
function tourClosedUnderUs() {
  const ctx = tourCtx;
  if (ctx.over || ctx.startsAt !== tour.startsAt) return false;
  const res = (tour.results[ctx.stage] || {})[ctx.table];
  if (res === undefined || (ctx.walkover && res && res.w === ctx.filedW)) return false;
  tourSkip[tourTableKey(ctx.stage, ctx.table)] = true;
  tourBackToScreen();
  if (!res || res.w == null) toast(t("tourTableClosed"));
  return true;
}
function tourTableTick() {
  if (!tourCtx || !online) return;
  if (tourClosedUnderUs()) return;
  if (!gameStarted) tourPublishWatch(false);          // the lobby's heartbeat
  if (gameStarted) {
    tourPublishLive(); tourPublishWatch(false); tourReadViewers();
    if (tourNow() < tourCtx.startAt + TOUR_GRACE_MS + 2 * TOUR_EMPTY_SETTLE_MS) tourCheckRoom(tourCtx);
    return;
  }
  if (dealActive) return;
  tourCheckRoom(tourCtx);
  renderLobby();
  const now = tourNow();
  const present = tourCtx.roster.filter(id => presentIds.has(id));
  if (present.indexOf(myId) < 0 || pendingAction) return;
  const all = present.length === tourCtx.roster.length;
  const trigger = all ? tourCtx.startAt : tourCtx.startAt + TOUR_GRACE_MS;
  if (now < trigger) return;
  if (present.length < 2) {
    if (!tourCtx.walkover && !roomAlreadyRunning()) {
      tourCtx.walkover = true;
      tourSkip[tourTableKey(tourCtx.stage, tourCtx.table)] = true;
      // A walkover is for whoever was here on time. Alone and late (2026-11-17:
      // somebody sat down 18 minutes in and went through) = the table closes
      // without a winner, exactly as if nobody had come.
      const late = tourCtx.arrivedAt > tourCtx.startAt + TOUR_GRACE_MS;
      tourCtx.filedW = late ? null : myId;
      tourReport(tourCtx.startsAt, tourCtx.stage, tourCtx.table, late ? null : myId, late ? tourCtx.startAt + TOUR_GRACE_MS : undefined);
      const s = document.getElementById("onlineStatus");
      if (s) s.textContent = t(late ? "tourLateOut" : "tourWalkover");
      const h = document.getElementById("lobbyHint");
      if (h) h.textContent = "";
    }
    return;
  }
  // Staggered by position on the list, so a sleeping first player can't hold the table.
  const rank = present.indexOf(myId);
  if (now < trigger + rank * DEAL_STAGGER_MS || now - tourDealAt < SEAT_RETRY_MS) return;
  if (roomAlreadyRunning() && Date.now() - lastRoomActivityAt < OPEN_REVIVE_MS) return;
  tourDealAt = now;
  roomPlayerIds = present;
  numPlayers = present.length;
  isHost = present[0] === myId;
  loseAt = TOUR_LOSE_AT;
  firstDeal = true; lastWinner = -1;
  hostDeal();
}
function tourShowLobbyBack(on) {
  const b = document.getElementById("lobbyTourBtn");
  if (b) b.style.display = on ? "block" : "none";
}
function renderTourLobby() {
  const list = document.getElementById("lobbyList");
  const now = tourNow();
  const title = document.getElementById("lobbyTitle");
  if (title) title.textContent = t("tourLobbyTitle", tourCtx.isFinal ? t("tourFinal") : t("tourStage", tourCtx.stage), tourCtx.table);
  const spinner = document.getElementById("lobbySpinner");
  if (spinner) spinner.style.display = "none";
  ["readyBtn", "startGameBtn", "lobbyBotsBtn"].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = "none"; });
  const limit = document.getElementById("lobbyLimit");
  if (limit) limit.style.display = "none";
  tourShowLobbyBack(true);
  if (list) {
    const fresh = document.createElement("div");
    tourCtx.roster.forEach(id => {
      const here = presentIds.has(id);
      const meta = playerMeta[id] || {};
      const p = tourPerson(id);
      const nm = id === myId ? (myName || t("you")) : (meta.name || p.name);
      const row = document.createElement("div");
      row.className = "lobby-row" + (id === myId ? " me" : "");
      row.appendChild(makeAvatarEl(nm, meta.avatar || p.avatar, "lobby-avatar", false));
      row.appendChild(tourEl("span", "lobby-name", shortName(nm)));
      row.appendChild(tourEl("span", "lobby-badge " + (here ? "ready" : "wait"), here ? t("tourHere") : t("tourAway")));
      fresh.appendChild(row);
    });
    tourSwap(list, fresh);
  }
  if (tourCtx.walkover) return;
  const present = tourCtx.roster.filter(id => presentIds.has(id)).length;
  const total = tourCtx.roster.length;
  const statusEl = document.getElementById("onlineStatus");
  const hint = document.getElementById("lobbyHint");
  if (statusEl) statusEl.textContent = now < tourCtx.startAt ? t("tourLobbyStartsIn", tourFmtLeft(tourCtx.startAt - now))
    : present === total ? t("tourLobbyAll") : t("tourLobbyWaiting", present, total);
  if (hint) hint.textContent = now >= tourCtx.startAt && present < total
    ? t("tourLobbyGrace", tourFmtLeft(tourCtx.startAt + TOUR_GRACE_MS - now))
    : now < tourCtx.startAt ? t("tourLobbyWaiting", present, total) + " · " + t("tourLobbyRule") : "";
}
// Match over: every client at the table computes the same champion and files
// it (the first write stands, the rest are no-ops).
function tourMatchOver(champSeat) {
  if (!tourCtx) return;
  const champId = roomPlayerIds[champSeat];
  if (champId == null) return;
  tourCtx.over = true;
  // This table is finished for us, even before its result reaches the board.
  tourSkip[tourTableKey(tourCtx.stage, tourCtx.table)] = true;
  tourReport(tourCtx.startsAt, tourCtx.stage, tourCtx.table, champId);
  tourPublishWatch(true, champId);
  const iWon = champId === myId;
  const rs = document.getElementById("rematchStatus");
  if (rs) rs.textContent = iWon ? (tourCtx.isFinal ? t("tourChampionMsg") : t("tourQualifiedMsg")) : t("tourEliminatedMsg");
  const btn = document.getElementById("playAgainBtn");
  if (btn) btn.textContent = t("tourBackToTour");
  tourRenderShareButtons();
}
function tourBackToScreen() {
  try { if (window.Usion && Usion.game && Usion.game.leave) Usion.game.leave(); } catch (_) {}
  resetRoomState();
  online = false; openTable = false;
  tourCtx = null; tourDealAt = 0; tourViewReadAt = 0;
  tourShowViewers(0);
  onlineOverlay.classList.remove("show");
  handOverlay.classList.remove("show");
  setupOverlay.classList.remove("show");
  document.getElementById("winnerOverlay").classList.remove("show");
  const btn = document.getElementById("playAgainBtn");
  if (btn) btn.textContent = t("playAgain");
  tourShowLobbyBack(false);
  const wsb = document.getElementById("winnerShareBtn");
  if (wsb) wsb.style.display = "none";
  const lb = document.getElementById("lobbyBotsBtn");
  if (lb) lb.style.display = "";
  openTournament();
}
(function wireTournament() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("menuTourBtn", openTournament);
  on("tourBackBtn", closeTournament);
  on("tourSecondary", tourWithdraw);
  on("specExit", function () { tourStopWatch(); });
  const tb = document.getElementById("tourBody");
  if (tb) tb.addEventListener("click", function (e) {
    let b = e.target;
    while (b && b !== tb && !(b.dataset && b.dataset.watchTable)) b = b.parentNode;
    if (b && b !== tb) tourStartWatch(Number(b.dataset.watchStage), Number(b.dataset.watchTable));
  });
  on("lobbyTourBtn", function () {
    // Leaving the lobby on purpose: don't pull them straight back in.
    if (tourCtx) tourSkip[tourTableKey(tourCtx.stage, tourCtx.table)] = true;
    tourBackToScreen();
  });
  on("tourPrimary", function () {
    const act = document.getElementById("tourPrimary").dataset.act;
    if (act === "register") tourRegister();
    else if (act === "enter") tourEnterTable();
    else closeTournament();
  });
})();

// ── Champion: banner, News Feed post, "latest champion" strip ──
// The prize is recognition, no server needed:
//  * the champion gets a banner drawn on a canvas and a "Share to feed" button
//    (Usion.shareToFeed posts to THEIR OWN feed; the host asks them to confirm
//    every time, so nothing is ever posted without them);
//  * everybody sees the latest champion on the menu and the tournament screen,
//    from one shared record (t13.v1.champ) that any client seeing a finished
//    event writes.
const TOUR_FAME_KEY = TOUR_PREFIX + "fame";
const TOUR_CHAMP_SHOW_MS = 3 * 24 * 3600 * 1000;
// {v, events:[startsAt…], list:[{id, n, a, w, last}], latest:{startsAt, id, n, a, players, stages}}
let tourFame = null, tourFameAt = 0;
const tourFameDone = {};
const tourBannerCache = {};        // startsAt → data URL
function tourFameValid(f) { return !!f && Array.isArray(f.events) && Array.isArray(f.list); }
function tourWinsOf(id) {
  const e = tourFame && tourFame.list.find(x => x && x.id === id);
  return e ? e.w | 0 : 0;
}
function tourMyAvatar() { return myAvatar && String(myAvatar).length <= 400 ? myAvatar : null; }
function tourChampRecord(tt) {
  if (!tt || tt.phase !== "complete" || !tt.championId) return null;
  const p = tt.people.find(x => x.id === tt.championId) || {};
  const fameA = tourFame && (tourFame.list.find(x => x && x.id === tt.championId) || {}).a;
  return { v: 1, startsAt: tt.startsAt, id: tt.championId, n: p.n || "?",
           a: (tt.championId === myId ? tourMyAvatar() : null) || p.a || fameA || null,
           players: tt.people.length, stages: tt.stages.length };
}
async function tourLoadFame(force) {
  const shared = tourShared();
  if (!shared || (!force && tourNow() - tourFameAt < 60000)) { tourRenderChampStrip(); return; }
  tourFameAt = tourNow();
  try { const f = await shared.get(TOUR_FAME_KEY); if (tourFameValid(f)) tourFame = f; } catch (_) {}
  tourRenderChampStrip();
  tourRender();
}
// Count a finished event once. Any client that sees it finish may file it; the
// champion's own client also adds their avatar, which nobody else has.
async function tourRecordChampion(tt) {
  const rec = tourChampRecord(tt);
  if (!rec || tourFameDone[rec.startsAt]) return;
  tourFameDone[rec.startsAt] = true;
  const mineA = rec.id === myId ? tourMyAvatar() : null;
  const counted = f => tourFameValid(f) && f.events.indexOf(rec.startsAt) >= 0 &&
    (!mineA || ((f.list.find(x => x && x.id === rec.id) || {}).a === mineA));
  try {
    tourFame = await tourUpdate(TOUR_FAME_KEY, cur => {
      if (counted(cur)) return null;
      const f = tourFameValid(cur) ? JSON.parse(JSON.stringify(cur)) : { v: 1, events: [], list: [], latest: null };
      let e = f.list.find(x => x && x.id === rec.id);
      if (!e) { e = { id: rec.id, n: rec.n, a: null, w: 0, last: 0 }; f.list.push(e); }
      if (f.events.indexOf(rec.startsAt) < 0) {
        f.events.push(rec.startsAt); f.events = f.events.slice(-60);
        e.w = (e.w | 0) + 1; e.n = rec.n; e.last = Math.max(e.last || 0, rec.startsAt);
        if (!f.latest || !(Number(f.latest.startsAt) >= rec.startsAt)) f.latest = Object.assign({}, rec, { a: null });
      }
      if (mineA) { e.a = mineA; if (f.latest && f.latest.id === rec.id) f.latest.a = mineA; }
      f.list.sort((x, y) => (y.w | 0) - (x.w | 0) || (y.last || 0) - (x.last || 0));
      f.list = f.list.slice(0, 100);
      return f;
    }, counted);
    tourFameAt = tourNow();
  } catch (_) { tourFameDone[rec.startsAt] = false; }
  tourRenderChampStrip();
  tourRender();
}
function tourRenderFame(body) {
  const list = tourFame ? tourFame.list.filter(e => e && e.w > 0).slice(0, 10) : [];
  if (!list.length) return;
  body.appendChild(tourEl("div", "tour-section", t("tourFameTitle")));
  list.forEach((e, i) => {
    const row = tourEl("div", "tour-row tour-fame-row" + (e.id === myId ? " me" : ""));
    row.appendChild(tourEl("span", "tour-rank" + (i < 3 ? " top" + (i + 1) : ""), String(i + 1)));
    row.appendChild(makeAvatarEl(e.n, e.a, "tour-avatar", false));
    row.appendChild(tourEl("span", "tour-name", e.id === myId ? t("you") : shortName(e.n)));
    row.appendChild(tourEl("span", "tour-trophies", "🏆 " + e.w));
    body.appendChild(row);
  });
}
// ── Live scores: the table's lead client publishes totals after each round ──
let tourLiveSig = "", tourLiveAt = 0, tourLiveRound = 0, tourLivePrevSig = "";
let tourLiveSeenSig = "", tourLiveChangedAt = 0;
// Not the lead: post the scores only when the lead's post has not shown up this
// long after they changed. A locked phone stays "present" and stays the lead, so
// tables played on with their scores frozen on the bracket (2026-11).
const TOUR_LIVE_COVER_MS = 10000;
function tourSameScores(a, b) {
  const norm = e => JSON.stringify([Object.keys(e.s || {}).sort().map(k => [k, e.s[k]]), (e.o || []).slice().sort()]);
  return !!a && !!b && norm(a) === norm(b);
}
function tourPublishLive() {
  const shared = tourShared();
  if (!shared || !tourCtx || !gameStarted || replayingSync) return;
  const sig = JSON.stringify(players.map(p => [p.total, !!p.out]));
  const now = tourNow();
  if (sig !== tourLiveSeenSig) { tourLiveSeenSig = sig; tourLiveChangedAt = now; }
  if (sig === tourLiveSig || now - tourLiveAt < TOUR_LIVE_MS) return;
  const primary = isPrimaryAuthority();
  if (!primary && now - tourLiveChangedAt < TOUR_LIVE_COVER_MS) return;
  // A rewrite of the same scores (a lost write) is not a new round.
  if (sig !== tourLivePrevSig) tourLiveRound++;
  tourLiveSig = sig; tourLivePrevSig = sig; tourLiveAt = now;
  const entry = { s: {}, o: [], r: tourLiveRound, at: now };
  roomPlayerIds.forEach((id, i) => {
    if (id == null || !players[i]) return;
    entry.s[id] = players[i].total;
    if (players[i].out) entry.o.push(id);
  });
  const key = tourLiveKey(tourCtx.startsAt, tourCtx.stage), table = tourCtx.table;
  let covered = false;
  // Cosmetic: a write lost in a race is simply replaced by the next round's.
  Promise.resolve().then(() => shared.get(key)).then(cur => {
    const prev = cur && cur.t && cur.t[table];
    if (!primary && tourSameScores(prev, entry)) { covered = true; return; }   // the lead posted it
    if (prev && !tourSameScores(prev, entry)) entry.r = Math.max(entry.r, (prev.r | 0) + 1);
    const tt = Object.assign({}, cur && cur.t);
    tt[table] = entry;
    return shared.set(key, { v: 1, t: tt });
  }).then(() => covered ? null : new Promise(r => setTimeout(r, 1500 + Math.random() * 1500))
      .then(() => shared.get(key))
      .then(cur => {
        // Every table of the stage writes this one record, and they all start at
        // once: an entry dropped by a concurrent write is written again (and
        // without it the table would offer nobody «Ширээ үзэх»).
        const got = cur && cur.t && cur.t[table];
        if ((!got || got.at !== entry.at) && tourLiveAt === entry.at) tourLiveSig = "";
      }))
    .catch(() => { tourLiveSig = ""; });
}
// ── Watching another table, card by card ──
// The relay admits only a room's players, and a table of four has no seat left
// for a watcher (backend join_game_room: "Game room is full"). So watching goes
// through shared storage instead: the table's lead client posts a small picture
// of the table — scores, card counts, the current trick, whose turn — at most
// every TOUR_WATCH_MS, and only when it changed (tl = seconds left on the turn clock):
//   t13.v1.<startsAt>.w<stage>.<table>  {v, at, tl, r, deal, turn, w, ps:[{id,n,a,t,o,c}], tp:[{s,c:[wire…]}]}
// Before the deal it is the lobby instead: {v, at, lobby:1, ps:[{id,n,a,h}]} (h = here).
// A watcher polls that one key. Set only, no read, so no races; the record is
// removed a minute after the match ends to spare the bucket's 200 keys.
//
// The picture is also the table's HEARTBEAT (2026-11-23). Every client at the
// table re-posts it at least every TOUR_BEAT_MS, lead or not, in the lobby too.
// A locked phone stays "present" and stays the lead, and with only the lead
// posting, a table played on with no picture and no scores. A table whose
// picture has not changed for TOUR_DEAD_MS has nobody running it, and anybody
// looking at the event closes it (tourCloseDeadTables).
const TOUR_WATCH_MS = 2000;
const TOUR_WATCH_GIVEUP_MS = 15000;
const TOUR_BEAT_MS = 15000;
const TOUR_DEAD_MS = 3 * 60 * 1000;
function tourWatchKey(startsAt, stage, table) { return TOUR_PREFIX + startsAt + ".w" + stage + "." + table; }
let tourWatchSig = "", tourWatchPubAt = 0;
function tourLobbyPicture() {
  return { lobby: 1, ps: tourCtx.roster.map(id => {
    const meta = playerMeta[id] || {}, p = tourPerson(id);
    const nm = id === myId ? (myName || p.name) : (meta.name || p.name);
    const av = id === myId ? myAvatar : (meta.avatar || p.avatar);
    return { id, n: String(nm || "").slice(0, 24), a: av && String(av).length <= 400 ? av : null,
             h: id === myId || presentIds.has(id) ? 1 : 0 };
  }) };
}
function tourPublishWatch(final, champId) {
  const shared = tourShared();
  if (!shared || !tourCtx || replayingSync) return;
  if (!final && tourCtx.over) return;                 // the winner's picture stands until it is removed
  const now = tourNow();
  let body;
  if (!gameStarted) {
    if (final || tourCtx.walkover || now - tourWatchPubAt < TOUR_BEAT_MS) return;
    body = tourLobbyPicture();
  } else {
    const primary = isPrimaryAuthority();
    if (!final && now - tourWatchPubAt < (primary ? TOUR_WATCH_MS : TOUR_BEAT_MS)) return;
    const ps = roomPlayerIds.map((id, i) => {
      const p = players[i] || {};
      const a = p.avatar && String(p.avatar).length <= 400 ? p.avatar : null;
      return { id: id == null ? null : id, n: String(p.name || "").slice(0, 24), a, t: p.total | 0, o: !!p.out, c: (hands[i] || []).length };
    });
    const tp = trickPlays.slice(-4).map(x => ({ s: x.seat, c: x.combo.cards.map(cardWire) }));
    body = { r: tourLiveRound, deal: !!dealActive, turn: dealActive ? turn : -1, w: champId == null ? null : champId, ps, tp };
  }
  const sig = JSON.stringify(body);
  if (sig === tourWatchSig && !final && now - tourWatchPubAt < TOUR_BEAT_MS) return;
  tourWatchSig = sig; tourWatchPubAt = now;
  const key = tourWatchKey(tourCtx.startsAt, tourCtx.stage, tourCtx.table);
  Promise.resolve().then(() => shared.set(key, Object.assign({ v: 1, at: now, tl: turnLeft }, body))).catch(() => { tourWatchSig = ""; });
  if (final && typeof shared.remove === "function") {
    const vkey = tourViewKey(tourCtx.startsAt, tourCtx.stage, tourCtx.table);
    setTimeout(() => {
      Promise.resolve().then(() => shared.remove(key)).catch(() => {});
      Promise.resolve().then(() => shared.remove(vkey)).catch(() => {});
    }, 60000);
  }
}
// Watching happens ON the game table, like Muushig: the same opponents, the
// same trick in the middle, the bottom seat's hand face down, the turn ring
// running — and a spectator bar with the way out. Nothing of the real match
// state is touched: the renderers are pointed at the snapshot for the length of
// one synchronous draw, then everything is put back.
// ── Who is watching ──
// Each watcher stamps its id into the table's viewers record every
// TOUR_VIEW_BEAT_MS (read-modify-write; a stamp lost to a race comes back on the
// next beat) and takes its id out on leaving. A stamp older than TOUR_VIEW_TTL_MS
// no longer counts, so a closed app drops off by itself.
//   t13.v1.<startsAt>.v<stage>.<table>  {v, ids:{<userId>: at}}
// The players at the table read the same record every TOUR_VIEW_READ_MS.
const TOUR_VIEW_BEAT_MS = 20000, TOUR_VIEW_TTL_MS = 45000, TOUR_VIEW_READ_MS = 15000;
function tourViewKey(startsAt, stage, table) { return TOUR_PREFIX + startsAt + ".v" + stage + "." + table; }
function tourViewCount(rec, now) {
  const ids = rec && rec.ids && typeof rec.ids === "object" ? rec.ids : {};
  return Object.keys(ids).filter(id => now - Number(ids[id]) < TOUR_VIEW_TTL_MS).length;
}
function tourViewStamp(startsAt, stage, table, present) {
  const shared = tourShared();
  if (!shared || !myId) return Promise.resolve(null);
  const key = tourViewKey(startsAt, stage, table);
  return Promise.resolve().then(() => shared.get(key)).then(cur => {
    const now = tourNow();
    const ids = {};
    const old = cur && cur.ids && typeof cur.ids === "object" ? cur.ids : {};
    Object.keys(old).forEach(id => { if (now - Number(old[id]) < TOUR_VIEW_TTL_MS) ids[id] = Number(old[id]); });
    if (present) ids[myId] = now; else delete ids[myId];
    const next = { v: 1, ids };
    return Promise.resolve(shared.set(key, next)).then(() => next);
  }).catch(() => null);
}
function tourShowViewers(n) {
  const spec = document.getElementById("specViewers"), box = document.getElementById("specViewersBox");
  if (spec) spec.textContent = String(n);
  if (box) { box.hidden = !(n > 0); box.setAttribute("aria-label", t("tourViewers", n)); }
  const badge = document.getElementById("tableViewers");
  if (badge) {
    const on = !!tourCtx && gameStarted && n > 0;
    badge.hidden = !on;
    const num = document.getElementById("tableViewersN");
    if (num) num.textContent = String(n);
    badge.title = n > 0 ? t("tourViewers", n) : "";
  }
}
// At the table: how many are watching us (shown as a small eye badge).
let tourViewReadAt = 0;
function tourReadViewers() {
  const shared = tourShared();
  if (!shared || !tourCtx || !gameStarted) return;
  const now = tourNow();
  if (now - tourViewReadAt < TOUR_VIEW_READ_MS) return;
  tourViewReadAt = now;
  const ctx = tourCtx;
  Promise.resolve().then(() => shared.get(tourViewKey(ctx.startsAt, ctx.stage, ctx.table))).then(rec => {
    if (tourCtx === ctx) tourShowViewers(tourViewCount(rec, tourNow()));
  }).catch(() => {});
}

// A new play slides in from the seat that made it, like a card thrown on the table.
function tourAnimatePlay(seat) {
  const row = tableComboEl.querySelector(".tp-play.latest");
  if (!row || typeof row.animate !== "function") return;
  const from = seat === 0 ? document.querySelector(".me-bar .player-avatar")
    : document.querySelector('.opp[data-seat="' + seat + '"] .player-avatar');
  if (!from) return;
  const a = from.getBoundingClientRect(), b = row.getBoundingClientRect();
  if (!b.width) return;
  const dx = (a.left + a.width / 2) - (b.left + b.width / 2);
  const dy = (a.top + a.height / 2) - (b.top + b.height / 2);
  try {
    row.animate([
      { transform: "translate(" + dx + "px," + dy + "px) scale(.35) rotate(-8deg)", opacity: 0.2 },
      { transform: "translate(0,0) scale(1.06) rotate(0deg)", opacity: 1, offset: 0.8 },
      { transform: "none", opacity: 1 },
    ], { duration: 420, easing: "cubic-bezier(.2,.8,.25,1)" });
  } catch (_) {}
}

let tourWatching = null;   // {startsAt, stage, table, timer, beat, snap, gotAt, playKey}
function tourStartWatch(stage, table) {
  if (!tourShared() || !stage || !table || tourCtx || gameStarted) return;
  tourStopWatch(true);
  tourWatching = { startsAt: tour.startsAt, stage, table, snap: null, gotAt: 0, timer: null };
  document.getElementById("tourOverlay").classList.remove("show");
  document.body.classList.remove("tour-open");
  document.body.classList.add("spectating");
  hideMenu();
  const w = tourWatching;
  const poll = () => {
    if (tourWatching !== w) return;
    Promise.resolve().then(() => tourShared().get(tourWatchKey(w.startsAt, w.stage, w.table))).then(rec => {
      if (tourWatching !== w) return;
      if (rec && Array.isArray(rec.ps) && rec.ps.length >= 2 && rec.ps.length <= 4 && (!w.snap || rec.at !== w.snap.at)) {
        w.snap = rec; w.gotAt = tourNow();
      }
      // A picture that stopped changing: nobody is at that table any more.
      if (w.snap && w.snap.w == null && tourNow() - w.gotAt > TOUR_DEAD_MS) {
        toast(t("tourWatchNone"));
        tourStopWatch();
        return;
      }
      tourRenderWatch();
      // Finished: nothing more will change, stop polling.
      if (w.snap && w.snap.w != null && w.timer) { clearInterval(w.timer); w.timer = null; }
    }).catch(() => {});
  };
  w.timer = setInterval(poll, TOUR_WATCH_MS);
  const beat = () => tourViewStamp(w.startsAt, w.stage, w.table, true).then(rec => {
    if (tourWatching === w && rec) tourShowViewers(tourViewCount(rec, tourNow()));
  });
  w.beat = setInterval(beat, TOUR_VIEW_BEAT_MS);
  // Nobody is posting this table (it never started, or its players are gone):
  // say so and go back, instead of a spinner that never ends.
  w.giveUp = setTimeout(() => {
    if (tourWatching !== w || w.snap) return;
    toast(t("tourWatchNone"));
    tourStopWatch();
  }, TOUR_WATCH_GIVEUP_MS);
  tourRenderWatch();
  poll();
  beat();
}
function tourStopWatch(quiet) {
  const w0 = tourWatching;
  if (w0 && w0.timer) clearInterval(w0.timer);
  if (w0 && w0.beat) clearInterval(w0.beat);
  if (w0 && w0.giveUp) clearTimeout(w0.giveUp);
  if (w0) tourViewStamp(w0.startsAt, w0.stage, w0.table, false);
  tourShowViewers(0);
  const was = !!w0;
  tourWatching = null;
  document.body.classList.remove("spectating");
  if (!was) return;
  // Clear the table we drew, so the next screen starts clean.
  oppEl.innerHTML = ""; tableComboEl.innerHTML = ""; handEl.innerHTML = "";
  turnLine.textContent = "—"; turnLine.className = "turn-line";
  if (quiet !== true) openTournament();
}
// Watching while still in the event: the moment your own next table is drawn,
// go back to the tournament screen, which sits you down (tourMaybeAutoEnter).
function tourWatchCheckMine() {
  const tt = tourDerive(tour.startsAt, tour.roster, tour.results, tourNow());
  const st = tourMyStatus(tt, myId);
  if (st !== "waiting" && st !== "playing") return;
  const stage = tt.stages[tt.stages.length - 1];
  if (stage && tourSkip[tourTableKey(stage.number, (stage.matches.find(m => m.playerIds.indexOf(myId) >= 0) || {}).number)]) return;
  tourStopWatch();
}
// The turn ring keeps running between snapshots.
function tourWatchClock() {
  const w = tourWatching, snap = w && w.snap;
  if (!snap || !snap.deal || snap.w != null || !Number.isFinite(Number(snap.tl))) return;
  const left = Math.max(0, Math.round(Number(snap.tl) - (tourNow() - w.gotAt) / 1000));
  const el = snap.turn === 0 ? document.getElementById("meTimer")
    : document.querySelector('.opp[data-seat="' + (snap.turn | 0) + '"] .opp-timer');
  setTimerEl(el, true, left);
}
function tourRenderWatch() {
  const w = tourWatching;
  if (!w) return;
  const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
  const d = tourDerive(w.startsAt, tour.roster, tour.results, tourNow());
  const st = d.stages[w.stage - 1];
  set("specExitLabel", t("tourSpecExit"));
  document.getElementById("specViewersBox").title = t("tourLobbyTitle", st && st.isFinal ? t("tourFinal") : t("tourStage", w.stage), w.table);
  const snap = w.snap;
  if (!snap) {
    oppEl.innerHTML = ""; tableComboEl.innerHTML = ""; handEl.innerHTML = "";
    meNameEl.textContent = ""; if (meScoreEl) meScoreEl.textContent = "";
    turnLine.textContent = t("tourWatchWaiting"); turnLine.className = "turn-line";
    return;
  }
  const nameOf = p => !p ? "?" : p.id === myId ? t("you") : (p.n || (p.id ? tourPerson(p.id).name : "?"));
  const champ = snap.w != null ? snap.ps.find(p => p.id === snap.w) : null;
  // Point the renderers at the snapshot…
  const saved = { players, hands, numPlayers, mySeat, turn, dealActive, trickPlays, roomPlayerIds, online, turnLeft };
  try {
    players = snap.ps.map((p, i) => ({ name: nameOf(p), avatar: p.a || null, isBot: p.id == null, total: p.t | 0, out: !!p.o, color: PLAYER_COLORS[i] }));
    hands = snap.ps.map(p => new Array(Math.max(0, Math.min(13, p.c | 0))).fill(null));
    numPlayers = players.length; mySeat = 0;
    dealActive = !!snap.deal && !champ;
    turn = dealActive ? snap.turn | 0 : -1;
    trickPlays = (Array.isArray(snap.tp) ? snap.tp : []).filter(x => x && players[x.s]).map(x => ({
      seat: x.s,
      combo: { cards: (Array.isArray(x.c) ? x.c : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 64).map(wireCard) },
    }));
    roomPlayerIds = snap.ps.map(p => p.id); online = false;
    const tl = Number(snap.tl);
    turnLeft = Number.isFinite(tl) ? Math.max(0, Math.round(tl - (tourNow() - w.gotAt) / 1000)) : TOUR_TURN_SECONDS;
    renderMyPlayer(); renderOpponents(); renderTable(); renderMyScore(); updateTimers();
  } finally {
    // …and put the real state back.
    players = saved.players; hands = saved.hands; numPlayers = saved.numPlayers; mySeat = saved.mySeat;
    turn = saved.turn; dealActive = saved.dealActive; trickPlays = saved.trickPlays;
    roomPlayerIds = saved.roomPlayerIds; online = saved.online; turnLeft = saved.turnLeft;
  }
  // A play we have not shown yet flies in from its seat (not on the first draw).
  const tps = Array.isArray(snap.tp) ? snap.tp : [];
  const last = tps[tps.length - 1];
  const playKey = last ? snap.r + ":" + tps.length + ":" + last.s + ":" + (last.c || []).join(",") : "";
  if (w.playKey !== undefined && playKey && playKey !== w.playKey && !champ) tourAnimatePlay(last.s | 0);
  w.playKey = playKey;
  // The bottom seat is somebody else's hand: backs only, never faces.
  const bottom = snap.ps[0];
  handEl.innerHTML = '<div class="card spec-back"></div>'.repeat(Math.max(0, Math.min(13, bottom.c | 0)));
  layoutHand();
  if (champ) { turnLine.textContent = t("tourWatchWinner", shortName(nameOf(champ))); turnLine.className = "turn-line mine"; }
  else if (snap.lobby) { turnLine.textContent = t("tourWatchLobby", snap.ps.filter(p => p.h).length, snap.ps.length); turnLine.className = "turn-line"; }
  else if (!snap.deal) { turnLine.textContent = t("tourWatchDealing"); turnLine.className = "turn-line"; }
  else if (snap.turn === 0) { turnLine.textContent = t("turnOf", shortName(nameOf(bottom))); turnLine.className = "turn-line"; }
}

// ── Coming back: straight to your table ──
const tourSkip = {};   // tables the player deliberately left: no auto-entry
const tourArrivedAt = {};   // table → when we first sat down (a late arrival gets no walkover)
function tourTableKey(stage, table) { return tour.startsAt + ":" + stage + ":" + table; }
let tourAutoAt = 0;
function tourMaybeAutoEnter(tt, st) {
  if (tourCtx || tour.busy || !tour.loaded || (st !== "playing" && st !== "waiting")) return;
  const stage = tt.stages[tt.stages.length - 1];
  const m = stage && stage.matches.find(x => x.playerIds.indexOf(myId) >= 0 && !x.done);
  if (!m || tourSkip[tourTableKey(stage.number, m.number)] || tourNow() - tourAutoAt < 3000) return;
  tourAutoAt = tourNow();
  setTimeout(() => { if (!tourCtx) tourEnterTable(); }, 0);
}
// On launch: someone with a live table (app closed mid-match, a phone that
// restarted) lands back on it without tapping through the menu.
async function tourResumeOnLaunch(forceScreen) {
  await tourLoad();
  const tt = tourDerive(tour.startsAt, tour.roster, tour.results, tourNow());
  const st = tourMyStatus(tt, myId);
  const menuUp = menuOverlay && menuOverlay.classList.contains("show");
  if (!menuUp || online) return;
  if (forceScreen || st === "playing" || st === "waiting") { openTournament(); return; }
  // Registration is open and they are not in yet: invite them, once a day.
  if (tt.phase === "registration" && st === "guest" && tourShared() && myId &&
      tourNow() < tt.closesAt - tourRegGuardMs() && !tourInviteDismissed(tt.startsAt)) showTourInvite(tt);
}
// ── The invitation on opening the app ──
// «Оролцоё» registers and opens the tournament; «Үгүй» leaves them on the home
// page and the question is not asked again for this event.
function tourInviteKey(startsAt) { return "t13:tourInvite:" + startsAt; }
function tourInviteDismissed(startsAt) { try { return localStorage.getItem(tourInviteKey(startsAt)) === "no"; } catch (_) { return false; } }
let tourInviteTimer = null;
function showTourInvite(tt) {
  const ov = document.getElementById("tourInviteOverlay");
  if (!ov) return;
  const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
  set("tourInviteTitle", t("tourInviteTitle"));
  set("tourInviteWhen", t("tourInviteWhen", tourFmtClock(tt.startsAt)));
  const inv = document.getElementById("tourInviteNotice");
  if (inv) { const txt = tourScheduleNotice(tourNow()); inv.textContent = txt; inv.hidden = !txt; }
  set("tourInviteCount", tt.people.length ? t("tourRegistered", tt.people.length) : t("tourInviteFirst"));
  set("tourInviteClose", t("tourInviteClose", tourFmtClock(tt.closesAt)));
  set("tourInviteYes", t("tourInviteYes"));
  set("tourInviteNo", t("tourInviteNo"));
  const tick = () => set("tourInviteLeft", t("tourStartsIn", tourFmtLeft(tt.startsAt - tourNow())));
  tick();
  if (tourInviteTimer) clearInterval(tourInviteTimer);
  tourInviteTimer = setInterval(() => {
    // Registration closed while it sat there, or they went elsewhere: drop it.
    if (tourNow() >= tt.closesAt - tourRegGuardMs() || online) { hideTourInvite(); return; }
    tick();
  }, 1000);
  ov.classList.add("show");
}
function hideTourInvite() {
  if (tourInviteTimer) { clearInterval(tourInviteTimer); tourInviteTimer = null; }
  const ov = document.getElementById("tourInviteOverlay");
  if (ov) ov.classList.remove("show");
}
(function wireTourInvite() {
  const yes = document.getElementById("tourInviteYes"), no = document.getElementById("tourInviteNo");
  if (yes) yes.addEventListener("click", () => {
    hideTourInvite();
    openTournament();
    tourRegister();
  });
  if (no) no.addEventListener("click", () => {
    hideTourInvite();
    try { localStorage.setItem(tourInviteKey(tour.startsAt || tourCurrentStart(tourNow())), "no"); } catch (_) {}
  });
})();
function tourDateLabel(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0");
}
function tourRenderMenuNotice(retried) {
  const n = document.getElementById("menuTourNotice");
  if (!n) return;
  let txt = "";
  // applyLang runs before the tournament code below has loaded: once more right after.
  try { txt = tourScheduleNotice(tourNow()); } catch (_) { if (!retried) setTimeout(() => tourRenderMenuNotice(true), 0); return; }
  n.textContent = txt; n.hidden = !txt;
}
function tourRenderChampStrip() {
  tourRenderMenuNotice();
  const el = document.getElementById("menuChampStrip");
  if (!el) return;
  const c = tourFame && tourFame.latest;
  const show = !!c && tourNow() - Number(c.startsAt) < TOUR_CHAMP_SHOW_MS;
  el.hidden = !show;
  if (!show) return;
  el.innerHTML = "";
  el.appendChild(tourEl("span", "champ-strip-cup", "🏆"));
  el.appendChild(makeAvatarEl(c.n, c.a, "champ-strip-avatar", false));
  const txt = tourEl("span", "champ-strip-text");
  txt.appendChild(tourEl("span", "champ-strip-label", t("tourLastChamp")));
  txt.appendChild(tourEl("span", "champ-strip-name", c.id === myId ? t("you") : shortName(c.n)));
  el.appendChild(txt);
  el.appendChild(tourEl("span", "champ-strip-date", tourDateLabel(Number(c.startsAt))));
}

function tourLoadImage(src) {
  return new Promise(resolve => {
    if (!src || typeof Image === "undefined") return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), 3000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = src;
  });
}
// 1200×630: the News Feed card size. Emerald table, double gold frame, a royal
// fan of ♠ and ♥ either side, the "13" medallion (or the champion's photo) in a
// laurel under a crown, the title ribbon, and the champion's name in gold.
async function tourChampionBanner(rec) {
  if (tourBannerCache[rec.startsAt]) return tourBannerCache[rec.startsAt];
  if (typeof document === "undefined" || !document.createElement) return null;
  try {
    if (document.fonts && document.fonts.load) await Promise.all([
      document.fonts.load('900 80px "Noto Serif"'), document.fonts.load('800 26px "Noto Sans"')]);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch (_) {}
  const avatar = await tourLoadImage(rec.a);
  const W = 1200, H = 630, cx = W / 2;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext && cv.getContext("2d");
  if (!g) return null;
  const rnd = mulberry32(tourHash("banner:" + rec.startsAt + ":" + rec.id));
  const rr = (x, y, w, h, r) => {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  };
  const gold = (y0, y1) => {
    const gr = g.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, "#fff3b0"); gr.addColorStop(.35, "#ffd24d"); gr.addColorStop(.65, "#e9a91c"); gr.addColorStop(1, "#a86f08");
    return gr;
  };
  const AX = cx, AY = 222, AR = 78;

  // ── table: outer margin, green felt, rays from the medallion
  g.fillStyle = "#0a3a23"; g.fillRect(0, 0, W, H);
  g.save(); rr(26, 24, W - 52, H - 48, 22); g.clip();
  const bg = g.createRadialGradient(AX, AY, 20, AX, 300, 760);
  bg.addColorStop(0, "#2a9a5c"); bg.addColorStop(.45, "#16743f"); bg.addColorStop(1, "#0b4a28");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.save(); g.translate(AX, AY);
  for (let i = 0; i < 32; i++) {
    g.rotate(Math.PI / 16);
    if (i % 2) continue;
    const ray = g.createLinearGradient(0, 0, 0, -900);
    ray.addColorStop(0, "rgba(140,230,150,.22)"); ray.addColorStop(1, "rgba(140,230,150,.02)");
    g.fillStyle = ray; g.beginPath(); g.moveTo(0, 0); g.lineTo(-55, -900); g.lineTo(55, -900); g.closePath(); g.fill();
  }
  g.restore();
  const glow = g.createRadialGradient(AX, AY, 30, AX, AY, 230);
  glow.addColorStop(0, "rgba(190,255,150,.35)"); glow.addColorStop(1, "rgba(190,255,150,0)");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  g.restore();

  // ── double gold frame
  g.save();
  g.lineWidth = 9; g.strokeStyle = gold(20, H - 20); rr(30, 28, W - 60, H - 56, 20); g.stroke();
  g.lineWidth = 2; g.strokeStyle = "rgba(60,35,0,.6)"; rr(36, 34, W - 72, H - 68, 16); g.stroke();
  g.lineWidth = 2.5; g.strokeStyle = gold(40, H - 40); rr(46, 44, W - 92, H - 88, 12); g.stroke();
  g.restore();

  // ── royal fans: 10 J Q K A of ♠ (left) and ♥ (right)
  const card = (x, y, rot, rank, sym, red, front) => {
    g.save(); g.translate(x, y); g.rotate(rot);
    g.shadowColor = "rgba(0,0,0,.45)"; g.shadowBlur = 16; g.shadowOffsetX = -3; g.shadowOffsetY = 6;
    rr(-74, -104, 148, 208, 12); g.fillStyle = "#fbf6e6"; g.fill();
    g.shadowColor = "transparent";
    g.lineWidth = 3; g.strokeStyle = "#d9b240"; g.stroke();
    g.fillStyle = red ? "#c4161c" : "#111";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = '900 ' + (rank === "10" ? 34 : 40) + 'px "Noto Serif", serif'; g.fillText(rank, -48, -72);
    g.font = '30px serif'; g.fillText(sym, -48, -36);
    if (front) { g.font = '92px serif'; g.fillText(sym, 6, 22); }
    g.restore();
  };
  const ranks = ["10", "J", "Q", "K", "A"];
  ranks.forEach((r, i) => card(158 + i * 50, 316 - i * 8, -0.36 + i * 0.05, r, "♠", false, i === 4));
  ranks.forEach((r, i) => card(840 + i * 50, 284 + i * 8, 0.1 + i * 0.05, r, "♥", true, i === 4));

  // ── laurel wreath
  const leaf = (x, y, ang, len) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(len * .5, -len * .34, len, 0); g.quadraticCurveTo(len * .5, len * .34, 0, 0);
    g.fill(); g.restore();
  };
  g.save();
  const leafGold = g.createLinearGradient(0, AY - 130, 0, AY + 130);
  leafGold.addColorStop(0, "#ffd75a"); leafGold.addColorStop(.5, "#eaa621"); leafGold.addColorStop(1, "#b9780c");
  g.fillStyle = leafGold; g.strokeStyle = "#c98d12"; g.lineWidth = 3;
  g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 4;
  const R = AR + 34;
  for (const side of [-1, 1]) {
    // stem
    g.beginPath();
    const a0 = side < 0 ? Math.PI * 0.6 : Math.PI * 0.4, a1 = side < 0 ? Math.PI * 1.36 : -Math.PI * 0.36;
    g.arc(AX, AY, R, a0, a1, side > 0); g.stroke();
    for (let i = 0; i < 12; i++) {
      const a = a0 + (a1 - a0) * (i / 11);
      const x = AX + Math.cos(a) * R, y = AY + Math.sin(a) * R;
      const travel = a - side * Math.PI / 2;       // along the stem, towards the top
      const len = 30 - i * 0.9;
      leaf(x, y, travel - side * 0.75, len);       // outer leaf
      leaf(x, y, travel + side * 0.55, len * .85); // inner leaf
    }
  }
  g.restore();

  // ── medallion
  g.save(); g.shadowColor = "rgba(255,220,90,.7)"; g.shadowBlur = 30;
  g.beginPath(); g.arc(AX, AY, AR + 9, 0, Math.PI * 2); g.fillStyle = gold(AY - AR, AY + AR); g.fill(); g.restore();
  g.beginPath(); g.arc(AX, AY, AR + 2, 0, Math.PI * 2); g.fillStyle = "#6b4a07"; g.fill();
  g.save(); g.beginPath(); g.arc(AX, AY, AR, 0, Math.PI * 2); g.clip();
  const md = g.createRadialGradient(AX - 20, AY - 30, 10, AX, AY, AR);
  md.addColorStop(0, "#1f8a50"); md.addColorStop(1, "#063a20");
  g.fillStyle = md; g.fillRect(AX - AR, AY - AR, AR * 2, AR * 2);
  if (avatar) {
    const s = Math.min(avatar.width, avatar.height);
    g.drawImage(avatar, (avatar.width - s) / 2, (avatar.height - s) / 2, s, s, AX - AR, AY - AR, AR * 2, AR * 2);
  } else {
    g.textAlign = "center"; g.textBaseline = "middle"; g.font = '900 84px "Noto Serif", serif';
    g.lineWidth = 5; g.strokeStyle = "#3d2700"; g.strokeText("13", AX, AY + 6);
    g.fillStyle = gold(AY - 40, AY + 44); g.fillText("13", AX, AY + 6);
  }
  g.restore();

  // ── crown
  g.save(); g.translate(AX, AY - AR - 34);
  g.shadowColor = "rgba(0,0,0,.4)"; g.shadowBlur = 10; g.shadowOffsetY = 4;
  g.fillStyle = gold(-40, 30);
  g.beginPath();
  g.moveTo(-56, 22); g.lineTo(-66, -24); g.lineTo(-32, 2); g.lineTo(0, -40); g.lineTo(32, 2); g.lineTo(66, -24); g.lineTo(56, 22);
  g.closePath(); g.fill();
  rr(-60, 16, 120, 20, 5); g.fill();
  g.shadowColor = "transparent";
  [[-66, -24], [0, -40], [66, -24]].forEach(([x, y]) => { g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fillStyle = "#fff0a8"; g.fill(); });
  [[-28, 26, "#22b14c"], [0, 26, "#e0202a"], [28, 26, "#2f6fe0"]].forEach(([x, y, c]) => {
    g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fillStyle = c; g.fill();
    g.beginPath(); g.arc(x - 2, y - 2, 2, 0, Math.PI * 2); g.fillStyle = "rgba(255,255,255,.8)"; g.fill();
  });
  g.restore();

  // ── title ribbon
  const RY = 330, RW = 580, RH = 58;
  g.save();
  for (const side of [-1, 1]) {      // folded tails, angled down
    const x0 = AX + side * (RW / 2 - 30);
    g.fillStyle = "#b27d10";
    g.beginPath();
    g.moveTo(x0, RY + 18); g.lineTo(x0 + side * 92, RY + 22); g.lineTo(x0 + side * 70, RY + 22 + RH / 2);
    g.lineTo(x0 + side * 98, RY + 26 + RH); g.lineTo(x0, RY + 18 + RH); g.closePath(); g.fill();
    g.fillStyle = "#6e4a05";
    g.beginPath(); g.moveTo(AX + side * (RW / 2), RY + RH); g.lineTo(x0, RY + 18 + RH); g.lineTo(AX + side * (RW / 2), RY + RH - 12); g.closePath(); g.fill();
  }
  g.shadowColor = "rgba(0,0,0,.4)"; g.shadowBlur = 12; g.shadowOffsetY = 5;
  g.fillStyle = gold(RY - 8, RY + RH);
  g.beginPath();
  g.moveTo(AX - RW / 2, RY); g.quadraticCurveTo(AX, RY - 16, AX + RW / 2, RY);
  g.lineTo(AX + RW / 2, RY + RH); g.quadraticCurveTo(AX, RY + RH - 16, AX - RW / 2, RY + RH); g.closePath(); g.fill();
  g.restore();
  g.fillStyle = "#3b2500"; g.textAlign = "center"; g.textBaseline = "middle";
  let ts = 28;
  do { g.font = '800 ' + ts + 'px "Noto Sans", sans-serif'; ts--; } while (g.measureText(t("tourBannerTitle")).width > RW - 70 && ts > 16);
  g.fillText(t("tourBannerTitle"), AX, RY + RH / 2 - 5);

  // ── the champion's name, big and gold
  const NY = 470;
  let size = 78;
  do { g.font = '900 ' + size + 'px "Noto Serif", serif'; size -= 2; } while (g.measureText(rec.n).width > 720 && size > 36);
  g.textBaseline = "alphabetic";
  g.save(); g.shadowColor = "rgba(0,0,0,.55)"; g.shadowBlur = 14; g.shadowOffsetY = 5;
  g.lineWidth = 7; g.strokeStyle = "#4a2f00"; g.lineJoin = "round"; g.strokeText(rec.n, AX, NY);
  g.restore();
  g.fillStyle = gold(NY - size, NY + 6); g.fillText(rec.n, AX, NY);
  g.save(); g.globalAlpha = .35; g.lineWidth = 1.5; g.strokeStyle = "#fff6c8"; g.strokeText(rec.n, AX, NY - 1); g.restore();

  // ── the game: stat chips, then the game's name along the bottom
  const chips = [t("tourBannerPlayers", rec.players), t("tourBannerStages", rec.stages), tourDateLabel(rec.startsAt)];
  g.font = '700 21px "Noto Sans", sans-serif'; g.textBaseline = "middle";
  const cw = chips.map(c => g.measureText(c).width + 40), gap = 14;
  let chx = AX - (cw.reduce((a, b) => a + b, 0) + gap * (chips.length - 1)) / 2;
  const CY = NY + 44;
  chips.forEach((c, i) => {
    rr(chx, CY - 18, cw[i], 36, 18); g.fillStyle = "rgba(0,40,20,.55)"; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = "rgba(255,210,90,.8)"; g.stroke();
    g.fillStyle = "#ffe08a"; g.fillText(c, chx + cw[i] / 2, CY + 1);
    chx += cw[i] + gap;
  });
  const foot = t("tourBannerGame");
  g.font = '800 19px "Noto Sans", sans-serif';
  const fw = g.measureText(foot).width;
  g.fillStyle = "rgba(255,236,170,.85)"; g.fillText(foot, AX, H - 66);
  g.strokeStyle = "rgba(255,210,90,.55)"; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(AX - fw / 2 - 70, H - 66); g.lineTo(AX - fw / 2 - 18, H - 66);
  g.moveTo(AX + fw / 2 + 18, H - 66); g.lineTo(AX + fw / 2 + 70, H - 66); g.stroke();

  // ── a few gold flecks
  g.save(); g.fillStyle = "#ffd75a";
  for (let i = 0; i < 9; i++) {
    const sx = 90 + rnd() * (W - 180), sy = 70 + rnd() * 130;
    if (Math.abs(sx - AX) < 200) continue;
    g.save(); g.translate(sx, sy); g.rotate(rnd() * Math.PI); g.fillRect(-6, -1.5, 12, 3); g.restore();
  }
  g.restore();

  let url = null;
  try { url = cv.toDataURL("image/jpeg", .92); } catch (_) { url = null; }   // tainted by a no-CORS avatar
  if (!url && avatar) return tourChampionBanner(Object.assign({}, rec, { a: null }));
  if (url) tourBannerCache[rec.startsAt] = url;
  return url;
}
function tourCanShare() {
  try { return !!(window.Usion && typeof Usion.canShareToFeed === "function" && Usion.canShareToFeed() && typeof Usion.shareToFeed === "function"); }
  catch (_) { return false; }
}
function tourSharedKey(startsAt) { return "t13:tourShared:" + startsAt; }
function tourWasShared(startsAt) { try { return localStorage.getItem(tourSharedKey(startsAt)) === "1"; } catch (_) { return false; } }
let tourSharing = false;
async function tourShareChampion() {
  const tt = tourDerive(tour.startsAt, tour.roster, tour.results, tourNow());
  const rec = tourChampRecord(tt);
  if (!rec || rec.id !== myId || tourSharing || !tourCanShare()) return;
  tourSharing = true; tourRender(); tourRenderShareButtons();
  try {
    const payload = {
      text: t("tourShareText"),
      path: "/tournament/" + rec.startsAt,
      card: { title: t("tourShareCardTitle", rec.n), subtitle: t("tourBannerStats", rec.players, rec.stages) + " · " + tourDateLabel(rec.startsAt) },
    };
    let canImage = false;
    try { canImage = Usion.canShareToFeed("image"); } catch (_) {}
    if (canImage) { const img = await tourChampionBanner(rec); if (img) payload.image = img; }
    await Usion.shareToFeed("text", payload);
    try { localStorage.setItem(tourSharedKey(rec.startsAt), "1"); } catch (_) {}
    toast(t("tourShared"));
  } catch (err) {
    const code = err && err.code;
    if (code !== "CANCELLED") toast(code === "RATE_LIMITED" ? t("tourShareLater") : t("tourShareFail"));
  }
  tourSharing = false; tourRender(); tourRenderShareButtons();
}
// The champion's prize block on the tournament screen, and the button on the final's winner card.
function tourRenderPrize(tt) {
  const box = document.getElementById("tourPrize");
  if (!box) return;
  const rec = tourChampRecord(tt);
  const mine = !!rec && rec.id === myId;
  box.style.display = mine ? "block" : "none";
  if (!mine) return;
  const img = document.getElementById("tourBannerImg");
  if (img && img.dataset.for !== String(rec.startsAt)) {
    img.dataset.for = String(rec.startsAt);
    tourChampionBanner(rec).then(url => { if (url) img.src = url; });
  }
  tourRenderShareButtons();
}
function tourRenderShareButtons() {
  const can = tourCanShare();
  const startsAt = tour.startsAt;
  const done = tourWasShared(startsAt);
  ["tourShareBtn", "winnerShareBtn"].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    if (id === "winnerShareBtn") {
      const tt = tourDerive(tour.startsAt, tour.roster, tour.results, tourNow());
      const rec = tourChampRecord(tt);
      if (!(tourCtx && tourCtx.isFinal && rec && rec.id === myId)) { b.style.display = "none"; return; }
    }
    b.style.display = can ? "block" : "none";
    b.disabled = tourSharing || done;
    b.textContent = done ? t("tourSharedBtn") : t("tourShareBtn");
  });
  const hint = document.getElementById("tourShareHint");
  if (hint) hint.textContent = can ? "" : t("tourShareNoHost");
}
(function wireChampion() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("tourShareBtn", tourShareChampion);
  on("winnerShareBtn", tourShareChampion);
  on("menuChampStrip", openTournament);
})();

// ── Tournament reminder (3 minutes before the start) ────────────────────
// Usion.notify only reaches the current user while the app is running, so the
// push comes from 13's own server (13/server, on the Usion game host): a player who allowed
// notifications and registered for an event gets it lead_ms (3 min) before the
// start, app closed or not. Same origin as the game, Usion iframe token as auth:
//   GET|PUT /api/reminder            on/off, decided, upcoming registered events
//   POST|DELETE /api/reminder/event  {startsAt}  registered / withdrew
// Served from anywhere else (file:, an old static host) the calls fail and the
// card simply never appears.
const tourRemind = { state: null, loadedAt: 0, busy: false, blocked: false };
const TOUR_REMIND_API = "/api/reminder";
function tourAuthToken() {
  try {
    return (Usion.user && typeof Usion.user.getToken === "function" && Usion.user.getToken()) ||
           (Usion.config && Usion.config.authToken) || null;
  } catch (_) { return null; }
}
// Token read per request (it is re-minted hourly); one retry after a 401.
async function tourRemindCall(method, body, path) {
  const url = TOUR_REMIND_API + (path || ""), f = window.fetch, who = myId;
  if (typeof f !== "function" || !window.Usion) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = tourAuthToken();
    if (!token) { await new Promise(r => setTimeout(r, 1500)); continue; }
    let res;
    try {
      res = await f(url, { method, headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
                           body: body ? JSON.stringify(body) : undefined });
    } catch (_) { return null; }
    if (res.status === 401 && attempt === 0) { await new Promise(r => setTimeout(r, 1500)); continue; }
    if (!res.ok) return null;
    let data = null;
    try { data = await res.json(); } catch (_) { return null; }
    return myId === who ? data : null;   // the user changed while it was pending
  }
  return null;
}
function tourRemindRegistered() {
  const tt = tourDerive(tour.startsAt || tourCurrentStart(tourNow()), tour.roster, tour.results, tourNow());
  return tt.people.some(p => p.id === myId);
}
// Chose "on", but Usion's permission was revoked or the app muted since.
async function tourRemindCheckBlocked() {
  let blocked = false;
  try {
    const P = Usion.permissions, N = Usion.notify;
    if (P && typeof P.has === "function" && !(await P.has("notifications"))) blocked = true;
    else if (N && typeof N.isMuted === "function" && await N.isMuted()) blocked = true;
  } catch (_) {}
  tourRemind.blocked = blocked;
}
// The server reminds about the events it was told of: registered here, on
// another phone, or before the server existed — tell it whenever it's missing.
function tourRemindNeedsEvent(d) {
  const at = tour.startsAt;
  return !!(d && d.configured && at > tourNow() && tourRemindRegistered() && !(d.events || []).includes(at));
}
async function tourRemindLoad(force) {
  if (!force && tourNow() - tourRemind.loadedAt < 60000) return;
  tourRemind.loadedAt = tourNow();
  let d = await tourRemindCall("GET");
  if (tourRemindNeedsEvent(d)) d = (await tourRemindCall("POST", { startsAt: tour.startsAt }, "/event")) || d;
  if (d) { tourRemind.state = d; if (d.enabled) await tourRemindCheckBlocked(); }
  tourRenderRemind();
}
// Withdrawing takes the event back, so a player who left gets no push.
function tourRemindWithdrawn(startsAt) {
  if (!tourRemind.state || !tourRemind.state.configured) return;
  tourRemindCall("DELETE", { startsAt }, "/event").then(d => { if (d) { tourRemind.state = d; tourRenderRemind(); } });
}
async function tourRemindSet(on) {
  if (tourRemind.busy) return;
  tourRemind.busy = true; tourRenderRemind();
  try {
    if (on) {
      // Ask first, on this tap; subscribe only if they really said yes.
      let granted = false;
      try {
        const r = await Usion.permissions.request(["notifications"], { reason: t("tourRemindReason") });
        granted = !!(r && (r.granted || (r.permissions && r.permissions.notifications)));
      } catch (_) {}
      if (!granted) { toast(t("tourRemindDenied")); return; }
      // A muted app gets nothing even with the permission (Muushig does the same).
      try { if (Usion.notify && typeof Usion.notify.setMuted === "function") await Usion.notify.setMuted(false); } catch (_) {}
    }
    let d = await tourRemindCall("PUT", { enabled: !!on, locale: LANG });
    if (d && tourRemindNeedsEvent(d)) d = (await tourRemindCall("POST", { startsAt: tour.startsAt }, "/event")) || d;
    if (d) { tourRemind.state = d; tourRemind.blocked = false; if (on) toast(t("tourRemindOnToast")); }
    else toast(t("tourRemindFail"));
  } finally {
    tourRemind.busy = false; tourRenderRemind();
  }
}
function tourRemindMinutes() {
  const ms = tourRemind.state && tourRemind.state.lead_ms;
  return Math.max(1, Math.round((Number.isFinite(ms) ? ms : 180000) / 60000));
}
function tourRemindClock() {
  return tourFmtClock((tour.startsAt || tourCurrentStart(tourNow())) - tourRemindMinutes() * 60000);
}
// The card under the main button: offered once a player has registered, then a
// one-line on/off switch for as long as they have decided.
function tourRenderRemind() {
  const box = document.getElementById("tourRemind");
  if (!box) return;
  const s = tourRemind.state;
  const registered = tourRemindRegistered();
  let mode = "";
  if (s && s.configured) {
    if (!s.decided) mode = registered ? "offer" : "";
    else if (s.enabled) mode = tourRemind.blocked ? "blocked" : "on";   // blocked: permission revoked or muted
    else mode = registered ? "off" : "";
  }
  box.style.display = mode ? "flex" : "none";
  box.className = "tour-remind " + mode;
  if (!mode || box.dataset.mode === mode + tourRemind.busy) return;
  box.dataset.mode = mode + tourRemind.busy;
  box.innerHTML = "";
  box.appendChild(tourEl("span", "tour-remind-ico", mode === "on" ? "🔔" : mode === "offer" ? "🔔" : "🔕"));
  const txt = tourEl("span", "tour-remind-text",
    mode === "offer" ? t("tourRemindOffer", tourRemindClock(), tourRemindMinutes()) :
    mode === "on" ? t("tourRemindOn", tourRemindClock(), tourRemindMinutes()) :
    mode === "blocked" ? t("tourRemindBlocked") : t("tourRemindOff"));
  box.appendChild(txt);
  const btn = (label, cls, fn) => {
    const b = tourEl("button", "tour-remind-btn " + cls, label);
    b.type = "button"; b.disabled = tourRemind.busy;
    b.addEventListener("click", fn);
    box.appendChild(b);
    return b;
  };
  if (mode === "offer") {
    const row = tourEl("div", "tour-remind-actions");
    box.appendChild(row);
    const yes = btn(t("tourRemindYes"), "primary", () => tourRemindSet(true));
    const later = btn(t("tourRemindLater"), "", () => tourRemindSet(false));
    row.appendChild(yes); row.appendChild(later);
  } else if (mode === "on") btn(t("tourRemindTurnOff"), "", () => tourRemindSet(false));
  else btn(t("tourRemindTurnOn"), "primary", () => tourRemindSet(true));
}
