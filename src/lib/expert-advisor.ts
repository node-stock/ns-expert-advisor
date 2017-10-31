import { Log, Util, Scheduler } from 'ns-common';
import { GoogleFinance } from 'ns-findata';
import { SniperStrategy, SniperSingal } from 'ns-strategies';
import * as types from 'ns-types';
import { Manager } from 'ns-manager';
import { WebTrader as Trader } from 'ns-trader';

import * as moment from 'moment';

Log.init(Log.category.system, Log.level.ALL, 'ns-expert-advisor');

class ExpertAdvisor {
  symbol: string;
  accountinfo: { id: string, balance: number };
  // 实时监测间隔
  interval: number;
  manager: Manager;
  trader: Trader;

  constructor() {
    this.symbol = '6553';
    this.interval = moment.duration(1, 'm').asMilliseconds();
    this.manager = new Manager();
    this.trader = new Trader(this.symbol);
    this.accountinfo = { id: 'stoc', balance: 0 };
  }

  init() {
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
      this.trading().catch((err) => {
        Log.system.error(`EA服务异常：${err.stack}`);
      });
    }, this);
    Log.system.info('注册定时EA服务程序[终了]');
  }

  destroy() {
    this.manager.destroy();
    this.trader.end();
  }

  // 自动交易方法
  async trading() {
    this.accountinfo.balance = await this.manager.asset.getBalance(this.symbol);
    setInterval(this.onInterval, this.interval);
    await this.trader.init();
  }

  async onInterval() {
    // 获取历史数据
    const hisData = <types.Bar[]>await GoogleFinance.getHistory({
      q: this.symbol,
      x: 'TYO',
      p: '1d',
      i: 300
    });
    if (hisData.length === 0) {
      Log.system.error(`未查询到历史数据!`);
      return;
    }
    // 查询数据库中的信号
    const res = await this.manager.signal.get({
      symbol: this.symbol
    })
    // 已有信号
    if (res) {
      const price = hisData[hisData.length - 1].close;
      // 买入信号
      if (res.side === types.OrderSide.Buy) {
        // 信号股价 < 当前股价(股价止跌上涨)
        if (res.price < price) {
          Log.system.info('股价止跌上涨,立即买入', price);
          const order = <types.LimitOrder>Object.assign({
            side: types.OrderSide.Buy,
            price
          }, this.trader.order);
          // 买入
          await this.trader.buy(order);
          // 记录交易信息
          await this.manager.trader.set(this.accountinfo, order);
          // 消除信号
          await this.manager.signal.remove(res.id);
        } else if (res.price > price) { // 股价继续下跌
          Log.system.info('更新买入信号股价', price);
          res.price = price;
          // 记录当前股价
          this.manager.signal.set(res);
        }
      }

    } else {
      // 没有信号时，执行策略取得信号
      const singal: SniperSingal = SniperStrategy.execute(this.symbol, hisData);
      // 获得买卖信号
      if (singal.side) {
        Log.system.info(`获得买卖信号：${JSON.stringify(singal)}`);
        const price = hisData[hisData.length - 1].close;
        // 记录信号
        await this.manager.signal.set(<types.Signal>Object.assign({
          symbol: this.symbol, price,
          notes: `k值：${singal.k}`
        }, singal));
      }
    }
  }
}
