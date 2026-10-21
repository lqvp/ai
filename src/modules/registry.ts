import type Module from '@/module.js';
import AiChatModule from './aichat/index.js';
import BirthdayModule from './birthday/index.js';
import ChartModule from './chart/index.js';
import CheckCustomEmojisModule from './check-custom-emojis/index.js';
import CoreModule from './core/index.js';
import DiceModule from './dice/index.js';
import EarthQuakeWarningModule from './earthquake_warning/index.js';
import EmojiModule from './emoji/index.js';
import EmojiReactModule from './emoji-react/index.js';
import FollowModule from './follow/index.js';
import FortuneModule from './fortune/index.js';
import GuessingGameModule from './guessing-game/index.js';
import ImagenModule from './imagen/index.js';
import InfoModule from './info/index.js';
import KazutoriModule from './kazutori/index.js';
import KeywordModule from './keyword/index.js';
import KiatsuModule from './kiatsu/index.js';
import MazeModule from './maze/index.js';
import NotingModule from './noting/index.js';
import PingModule from './ping/index.js';
import PollModule from './poll/index.js';
import ReactionConfigModule from './reaction-config/index.js';
import ReminderModule from './reminder/index.js';
import ReversiModule from './reversi/index.js';
import ServerModule from './server/index.js';
import SleepReportModule from './sleep-report/index.js';
import TalkModule from './talk/index.js';
import TimeSignalModule from './time-signal/index.js';
import TimerModule from './timer/index.js';
import UpdateCheckerModule from './update-checker/index.js';
import ValentineModule from './valentine/index.js';
import VeoModule from './veo/index.js';
import WeatherModule from './weather/index.js';
import WelcomeModule from './welcome/index.js';

/**
 * 搭載するモジュールの一覧。
 * モジュールを追加・削除するときはこの配列だけを触る。
 *
 * 順序は「反応の優先順位」でもある（先頭ほど先にフックが呼ばれる）。
 */
export function createModules(): Module[] {
  return [
    new CoreModule(),
    new AiChatModule(),
    new ReminderModule(),
    new ReactionConfigModule(),
    new TalkModule(),
    new CheckCustomEmojisModule(),
    new EmojiModule(),
    new EmojiReactModule(),
    new FortuneModule(),
    new GuessingGameModule(),
    new KazutoriModule(),
    new ReversiModule(),
    new TimerModule(),
    new DiceModule(),
    new PingModule(),
    new WelcomeModule(),
    new ServerModule(),
    new FollowModule(),
    new BirthdayModule(),
    new ValentineModule(),
    new KeywordModule(),
    new MazeModule(),
    new ChartModule(),
    new SleepReportModule(),
    new NotingModule(),
    new PollModule(),
    new EarthQuakeWarningModule(),
    new KiatsuModule(),
    new WeatherModule(),
    new TimeSignalModule(),
    new ImagenModule(),
    new VeoModule(),
    new InfoModule(),
    new UpdateCheckerModule(),
  ];
}
