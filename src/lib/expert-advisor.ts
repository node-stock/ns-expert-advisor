import { Log, Util, Scheduler } from 'ns-common';
import { GoogleFinance } from 'ns-findata';
import { SniperStrategy, SniperSingal } from 'ns-strategies';
import { Bar, Signal } from 'ns-types';
import { SignalManager } from 'ns-manager';

import * as moment from 'moment';

Log.init(Log.category.system, Log.level.ALL, 'ns-expert-advisor');

class ExpertAdvisor {
  // 实时监测间隔
  interval: number;

  constructor() {
    this.interval = moment.duration(1, 'm').asMilliseconds();
  }

  start() {
    // 如果为交易时间，直接启动EA服务
    if (Util.isTradeTime()) {
      Log.system.info('当前为交易时间，直接启动EA服务');
      this.trading();
    }
    Log.system.info('注册定时EA服务程序[开始]');
    const eaTask = new Scheduler('0 9 * * *'); // */3 * * * * *
    eaTask.invok((ea: ExpertAdvisor) => {
      if (!Util.isTradeDate(new Date())) {
        Log.system.info('当前非交易日，不启动EA服务');
        return;
      }

      Log.system.info('定时启动EA服务');
      try {
        ea.trading();
      } catch (err) {
        Log.system.error(`EA服务异常：${err.stack}`);
        /*if (startServ.isConnected()) {
          Log.system.info('发送异常，关闭DDE数据订阅服务');
          startServ.close();
        }*/
      }
    }, this);
    Log.system.info('注册定时EA服务程序[终了]');
  }

  trading() {
    setInterval(async () => {
      const symbol = '6553';
      const hisData = await GoogleFinance.getHistory({
        q: symbol,
        x: 'TYO',
        p: '1d',
        i: 300
      });

      const sniper = new SniperStrategy();
      const singal: SniperSingal = sniper.execute('6553', <Bar[]>hisData);
      if (singal.side) {
        Log.system.info(`获得买卖信号：${JSON.stringify(singal)}`);
        const price = hisData[hisData.length - 1].close;
        const signalManager = new SignalManager();
        // 记录信号
        await signalManager.setSignal(<Signal>Object.assign({
          symbol, price,
          notes: `k值：${singal.k}`
        }, singal));
      }
    }, this.interval);
  }
}
