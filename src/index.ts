import { ExpertAdvisor } from './lib/expert-advisor';
import { Log, Util, Scheduler } from 'ns-common';

const config = require('config');
Log.init(Log.category.system, Log.level.ALL, 'ns-expert-advisor');

const expertAdvisor = new ExpertAdvisor(config);

// 如果为交易时间，直接启动EA服务
if (Util.isTradeTime()) {
  Log.system.info('当前为交易时间，直接启动EA程序');
  expertAdvisor.start();
}
Log.system.info('注册定时EA服务程序[开始]');
const eaTask = new Scheduler('0 9 * * *'); // */3 * * * * * // 0 9 * * *
eaTask.invok((ea: ExpertAdvisor) => {
  // eaTask.reminder.cancel()
  if (!Util.isTradeDate(new Date())) {
    Log.system.info('当前非交易日，不启动EA程序');
    return;
  }

  Log.system.info('定时启动EA服务');
  expertAdvisor.start().catch((err) => {
    Log.system.error(`EA服务异常：${err.stack}`);
  });
}, expertAdvisor);
Log.system.info('注册定时EA服务程序[终了]');
