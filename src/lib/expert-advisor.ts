import { Log } from 'ns-common';
import { GoogleFinance, DataProvider } from 'ns-findata';
import { SniperSignal } from 'ns-strategies';
import { Signal, IKdjOutput } from 'ns-signal';
import * as types from 'ns-types';
import { SignalManager, AccountManager, TraderManager } from 'ns-manager';
import { InfluxDB, Param, Enums } from 'ns-influxdb';
import { IResults } from 'influx';

import * as assert from 'power-assert';
import * as numeral from 'numeral';
import * as moment from 'moment';
import * as fetch from 'isomorphic-fetch';
const Loki = require('lokijs');
const config = require('config');

export class ExpertAdvisor {
  symbols: string[];
  account: types.Model.Account;
  order: { [Attr: string]: any };
  backtest: {
    test: boolean,
    isLastDate: string,
    date: string,
    interval: number,
    loki: any
  };
  signal: Signal;
  // 实时监测间隔
  interval: number;
  worker: number;
  dataProvider: DataProvider;

  constructor() {
    assert(config, 'config required.');
    assert(config.trader, 'config.trader required.');
    assert(config.account, 'config.account required.');
    assert(config.ea, 'config.ea required.');
    assert(config.backtest, 'config.backtest required.');
    assert(config.store, 'config.store required.');
    this.symbols = config.ea.symbols;
    this.backtest = config.backtest;
    this.interval = config.ea.interval;
    this.account = { id: config.account.userId };
    this.signal = new Signal(config);
    this.dataProvider = new DataProvider(config.store);
    this.order = {
      eventType: types.EventType.Order,
      tradeType: types.TradeType.Margin,
      orderType: types.OrderType.Limit,
      side: types.OrderSide.Buy,
      amount: 100
    }
  }

  async destroy() {
    clearInterval(this.worker);
    await this.dataProvider.close();
  }

  async start() {
    await this.dataProvider.init();
    // 更新资产
    await this.updAsset();
    if (numeral(this.account.balance).value() === 0) {
      Log.system.warn(`账户：${this.account.id},可用余额：0,不执行EA程序！`);
      return;
    }
    this.worker = setInterval(this.onPretrade.bind(this), this.interval);
  }

  async updAsset() {
    const res = await AccountManager.get(this.account.id);
    if (res) {
      this.account = res;
    }
  }

  async onPretrade() {
    Log.system.info('预交易分析[启动]');
    // 计算kdj信号
    const signalList = <IKdjOutput[] & SniperSignal[]>await this.signal.kdj(this.symbols);
    let i = 0;
    for (const symbol of this.symbols) {
      // 查询数据库中的信号
      const dbSignal = await SignalManager.get({ symbol });
      Log.system.info(`查询数据库中的信号:${JSON.stringify(dbSignal)}`);
      try {
        const signal = signalList[i];
        // kdj算出信号
        if (signal.side) {
          const modelSignal = Object.assign({
            symbol,
            price: signal.lastPrice,
            notes: `k值：${signal.k}`
          }, signal, { side: String(signal.side) });

          if (this.backtest.test) {
            modelSignal.backtest = '1';
            modelSignal.mocktime = signal.lastTime;
          }

          // 记录信号
          await SignalManager.set(modelSignal);
          if (!this.backtest.test) {
            // await this.influxdb.putSignal(<Param.Signal>modelSignal);
          }
          // 推送信号警报
          await this.alertHandle(modelSignal);
          Object.assign(signal, modelSignal)
        }
        // 数据库中已存储信号
        if (dbSignal) {
          await this.tradingHandle(
            symbol,
            <number>signal.lastPrice,
            <string>signal.lastTime,
            dbSignal
          );
        }
        i++;
      } catch (err) {
        Log.system.error(err.stack);
      }
    }

    Log.system.info('预交易分析[终了]');
  }

  // 交易处理
  async tradingHandle(
    symbol: string,
    price: number,
    time: string,
    signal: {
      [Attr: string]: any
    }) {
    Log.system.info('交易信号处理[启动]');
    // 买入信号
    if (signal.side === types.OrderSide.Buy) {
      Log.system.info('买入信号');
      // 信号股价 < 当前股价(股价止跌上涨)
      if (<number>signal.price < price) {
        Log.system.info('买入信号出现后,股价止跌上涨,立即买入', price);
        const order = <types.LimitOrder>Object.assign({}, this.order, {
          symbol,
          side: types.OrderSide.Buy,
          price
        });
        if (this.backtest.test) {
          order.backtest = '1';
          order.mocktime = time;
        }
        try {
          // 买入
          await this.postOrder(order);
        } catch (e) {
          Log.system.warn('发送买入请求失败：', e.stack);
        }
        // 记录交易信息
        await TraderManager.set(this.account.id, order);
        // 消除信号
        await SignalManager.remove(signal.id);
        // 更新资产
        await this.updAsset();
      } else if (<number>signal.price > price) { // 股价继续下跌
        Log.system.info('更新买入信号股价', price);
        signal.price = price;
        if (this.backtest.test) {
          signal.backtest = '1';
          signal.mocktime = time;
        }
        // 记录当前股价
        await SignalManager.set(<types.Model.Signal>signal);
      }
    } else if (signal.side === types.OrderSide.Sell) {
      Log.system.info('卖出信号');
      // 查询是否有持仓
      let position: types.Model.Position | undefined;
      if (this.account.positions) {
        position = this.account.positions.find((posi) => {
          return posi.symbol === String(symbol) && posi.side === types.OrderSide.Buy;
        })
      }
      if (!position) {
        Log.system.warn('未查询到持仓，不进行卖出！');
        return;
      }
      Log.system.info(`获取持仓:${JSON.stringify(position)}`);
      if (!position.price) {
        Log.system.error('持仓股价为空！');
        return;
      }
      Log.system.info(`信号股价(${signal.price}) > 当前股价(${price}) && 盈利超过700(${price} - ${position.price} > 7)`);
      // 信号出现时股价 > 当前股价(股价下跌) && 并且盈利超过700
      if (signal.price > price && price - position.price > 7) {
        Log.system.info('卖出信号出现后,股价下跌,立即卖出', price);
        const order = <types.LimitOrder>Object.assign({}, this.order, {
          symbol,
          side: types.OrderSide.BuyClose,
          price,
        });
        if (this.backtest.test) {
          order.backtest = '1';
          order.mocktime = time;
        }
        try {
          // 卖出
          await this.postOrder(order);
        } catch (e) {
          Log.system.warn('发送卖出请求失败：', e.stack);
        }
        // 记录交易信息
        await TraderManager.set(this.account.id, order);
        // 消除信号
        await SignalManager.remove(signal.id);
        // 更新资产
        await this.updAsset();
      } else if (signal.price < price) { // 股价继续上涨
        Log.system.info('更新卖出信号股价', price);
        signal.price = price;
        if (this.backtest.test) {
          signal.backtest = '1';
          signal.mocktime = time;
        }
        // 记录当前股价
        await SignalManager.set(<types.Model.Signal>signal);
      }
    }
    Log.system.info('交易信号处理[终了]');
  }

  // 警报处理
  async alertHandle(signal: types.Signal) {
    await this.postSlack(signal);
  }

  async signalHandle(symbol: string, hisData: types.Bar[], signal: { [Attr: string]: any }) {
    Log.system.info('处理信号[启动]');
    const price: number = numeral(hisData[hisData.length - 1].close).value();
    const time = moment(hisData[hisData.length - 1].time).format('YYYY-MM-DD HH:mm:ss');

    // time = moment.tz(time, 'Asia/Tokyo').format();
    Log.system.info(`symbol：${symbol}, price：${price}, time：${time}`);
    // 买入信号
    if (signal.side === types.OrderSide.Buy) {
      Log.system.info('买入信号');
      // 信号股价 < 当前股价(股价止跌上涨)
      if (signal.price < price) {
        Log.system.info('买入信号出现后,股价止跌上涨,立即买入', price);
        const order = <types.LimitOrder>Object.assign({}, this.order, {
          symbol,
          side: types.OrderSide.Buy,
          price
        });
        if (this.backtest.test) {
          order.backtest = '1';
          order.mocktime = time;
        }
        try {
          // 买入
          await this.postOrder(order);
        } catch (e) {
          Log.system.warn('发送买入请求失败：', e.stack);
        }
        // 记录交易信息
        await TraderManager.set(this.account.id, order);
        // 消除信号
        await SignalManager.remove(signal.id);
        // 更新资产
        await this.updAsset();
      } else if (signal.price > price) { // 股价继续下跌
        Log.system.info('更新买入信号股价', price);
        signal.price = price;
        if (this.backtest.test) {
          signal.backtest = '1';
          signal.mocktime = time;
        }
        // 记录当前股价
        await SignalManager.set(<types.Model.Signal>signal);
      }
    } else if (signal.side === types.OrderSide.Sell) {
      Log.system.info('卖出信号');
      // 查询是否有持仓
      let position: types.Model.Position | undefined;
      if (this.account.positions) {
        position = this.account.positions.find((posi) => {
          return posi.symbol === String(symbol) && posi.side === types.OrderSide.Buy;
        })
      }
      if (!position) {
        Log.system.warn('未查询到持仓，不进行卖出！');
        return;
      }
      Log.system.info(`获取持仓:${JSON.stringify(position)}`);
      if (!position.price) {
        Log.system.error('持仓股价为空！');
        return;
      }
      Log.system.info(`信号股价(${signal.price}) > 当前股价(${price}) && 盈利超过700(${price} - ${position.price} > 7)`);
      // 信号出现时股价 > 当前股价(股价下跌) && 并且盈利超过700
      if (signal.price > price && price - position.price > 7) {
        Log.system.info('卖出信号出现后,股价下跌,立即卖出', price);
        const order = <types.LimitOrder>Object.assign({}, this.order, {
          symbol,
          side: types.OrderSide.BuyClose,
          price,
        });
        if (this.backtest.test) {
          order.backtest = '1';
          order.mocktime = time;
        }
        try {
          // 卖出
          await this.postOrder(order);
        } catch (e) {
          Log.system.warn('发送卖出请求失败：', e.stack);
        }
        // 记录交易信息
        await TraderManager.set(this.account.id, order);
        // 消除信号
        await SignalManager.remove(signal.id);
        // 更新资产
        await this.updAsset();
      } else if (signal.price < price) { // 股价继续上涨
        Log.system.info('更新卖出信号股价', price);
        signal.price = price;
        if (this.backtest.test) {
          signal.backtest = '1';
          signal.mocktime = time;
        }
        // 记录当前股价
        await SignalManager.set(<types.Model.Signal>signal);
      }
    }
    Log.system.info('处理信号[终了]');
  }

  // 拉取信号
  async pullSignal(symbol: string, hisData: types.Bar[]) {
    Log.system.info('拉取信号[启动]');

    // 没有信号时，执行策略取得信号
    const signal: SniperSignal | null = SniperStrategy.execute(symbol, hisData);
    const price = numeral(hisData[hisData.length - 1].close).value();
    // 获得买卖信号
    if (signal && signal.side) {
      Log.system.info(`获得买卖信号：${JSON.stringify(signal)}`);
      if (signal.side === types.OrderSide.Buy) {
        // 订单价格
        const orderPrice = price * 100 + 500;
        Log.system.info(`订单价格:${JSON.stringify(orderPrice)}`);
        if (<number>this.account.balance < orderPrice) {
          const balance = numeral(this.account.balance).format('0,0');
          Log.system.warn(`可用余额：${balance} < 订单价格(${symbol})：${numeral(orderPrice).format('0,0')}，不拉取信号！`);
          return;
        }
      } else if (signal.side === types.OrderSide.Sell) {

        // 查询是否有持仓
        if (this.account.positions) {
          const position = this.account.positions.find((posi) => {
            return posi.symbol === String(symbol) && posi.side === types.OrderSide.Buy;
          });

          if (!position) {
            Log.system.warn('未查询到持仓，不保存卖出信号！');
            return;
          }
        }
      }
      const modelSignal = <types.Model.Signal>Object.assign({
        symbol, price,
        notes: `k值：${signal.k}`
      }, signal);

      if (this.backtest.test) {
        modelSignal.backtest = '1';
        if (hisData[hisData.length - 1].time) {
          modelSignal.mocktime = moment(hisData[hisData.length - 1].time).format('YYYY-MM-DD HH:mm:ss');
        }
      }
      // 记录信号
      await SignalManager.set(modelSignal);
      if (!this.backtest.test) {
        // await this.influxdb.putSignal(<Param.Signal>modelSignal);
      }
      await this.postSlack(modelSignal);
    }
    Log.system.info('拉取信号[终了]');
  }

  public async postOrder(order: types.Order): Promise<any> {
    const requestOptions = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        orderInfo: order
      })
    };
    const url = `http://${config.trader.host}:${config.trader.port}/api/v1/order`;
    return await fetch(url, requestOptions);
  }

  public async postSlack(signal: types.Model.Signal) {
    const requestOptions = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        attachments: [
          {
            color: signal.side === 'buy' ? 'danger' : 'good',
            title: '銘柄：' + signal.symbol,
            text: signal.notes,
            fields: [
              {
                title: '价格',
                value: signal.price,
                short: true
              },
              {
                title: '方向',
                value: signal.side === 'buy' ? '买入' : '卖出',
                short: true
              }
            ],
            footer: '5分钟KDJ   ' + moment().format('YYYY-MM-DD hh:mm:ss'),
            footer_icon: 'https://platform.slack-edge.com/img/default_application_icon.png'
          }
        ]
      })
    };
    return await fetch(config.slack.url, requestOptions);
  }
}
