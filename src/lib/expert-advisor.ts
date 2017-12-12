import { Log, Util } from 'ns-common';
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

export interface ITradingInput {
  symbol: string,
  type: string,
  price: number,
  time: string,
  signal: {
    [Attr: string]: any
  }
}

export class ExpertAdvisor {
  symbols: string[];
  coins: string[];
  accountId: string;
  coinId: string;
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
    this.coins = config.ea.coins;
    this.backtest = config.backtest;
    this.interval = config.ea.interval;
    this.accountId = config.account.userId;
    this.coinId = config.account.coinId;
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
    this.worker = setInterval(this.onPretrade.bind(this), this.interval);
  }

  async onPretrade() {
    Log.system.info('预交易分析[启动]');
    const signalList: IKdjOutput[] = [];
    if (this.coins && this.coins.length > 0) {
      signalList.concat(<IKdjOutput[]>await this.signal.kdj(
        this.coins, types.SymbolType.cryptocoin, types.CandlestickUnit.Min5));
    }
    if (Util.isTradeTime()) {
      Log.system.info('股市交易时间,查询股市信号');
      signalList.concat(<IKdjOutput[]>await this.signal.kdj(
        this.symbols, types.SymbolType.stock, types.CandlestickUnit.Min5));
    }
    let i = 0;
    for (const symbol of this.symbols) {
      // 查询数据库中的信号
      const dbSignal = await SignalManager.get({ symbol });
      Log.system.info(`查询数据库中的信号:${JSON.stringify(dbSignal)}`);
      try {
        const signal = signalList[i];
        // kdj算出信号时
        if (signal.side) {
          await this.signalHandle(symbol, signal);
        }
        // 数据库中已存储信号
        if (dbSignal) {
          if (dbSignal.symbol.indexOf('_btc') !== -1) {
            Log.system.warn(`暂时未对应此商品:${dbSignal.symbol}`);
            return;
          }
          // 交易处理
          await this.tradingHandle({
            symbol,
            type: <types.SymbolType>signal.symbolType,
            price: <number>signal.lastPrice,
            time: <string>signal.lastTime,
            signal: dbSignal
          });
        }
        i++;
      } catch (err) {
        Log.system.error(err.stack);
      }
    }

    Log.system.info('预交易分析[终了]');
  }

  // 信号处理
  async signalHandle(symbol: string, signal: IKdjOutput) {
    const modelSignal: types.Model.Signal = Object.assign({
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
  }

  getFee(symbolType: types.SymbolType) {
    return symbolType === types.SymbolType.cryptocoin ? 0 : 500;
  }

  // 交易处理
  async tradingHandle(input: ITradingInput) {
    Log.system.info('交易信号处理[启动]');
    // 买入信号
    if (input.signal.side === types.OrderSide.Buy) {
      Log.system.info('买入信号');
      // 信号股价 < 当前股价(股价止跌上涨)
      if (<number>input.signal.price < input.price) {
        Log.system.info(`买入信号出现后,${input.symbol}股价止跌上涨,买入处理[开始]`);

        const order = <types.LimitOrder>Object.assign({}, this.order, {
          symbol: input.symbol,
          side: types.OrderSide.Buy,
          price: input.price
        });
        let accountId = this.accountId;
        if (input.type === types.SymbolType.cryptocoin) {
          order.amount = 0.001
          accountId = this.coinId;
        }
        if (this.backtest.test) {
          order.backtest = '1';
          order.mocktime = input.time;
        }

        // 查询资产
        const account = await AccountManager.get(accountId);
        if (!account) {
          Log.system.error(`系统出错，未查询到用户(${this.accountId})信息。`);
          return;
        }
        // 订单价格
        const orderPrice = order.price * order.amount + this.getFee(<types.SymbolType>input.type);
        if (<number>account.balance < orderPrice) {
          Log.system.warn(`可用余额：${account.balance} < 订单价格：${orderPrice}，退出买入处理！`);
          return;
        }
        Log.system.info(`订单价格:${orderPrice}`);
        try {
          // 买入
          await this.postOrder(order);
          await this.postTradeSlack(order, 0);
          Log.system.info(`发送买入指令`);
        } catch (e) {
          Log.system.warn('发送买入指令失败：', e.stack);
        }
        // 记录交易信息
        await TraderManager.set(this.accountId, order);
        // 消除信号
        await SignalManager.remove(input.signal.id);
        Log.system.info(`买入处理[终了]`);
      } else if (<number>input.signal.price > input.price) { // 股价继续下跌
        Log.system.info('更新买入信号股价', input.price);
        input.signal.price = input.price;
        if (this.backtest.test) {
          input.signal.backtest = '1';
          input.signal.mocktime = input.time;
        }
        // 记录当前股价
        await SignalManager.set(<types.Model.Signal>input.signal);
      }
    } else if (input.signal.side === types.OrderSide.Sell) {
      Log.system.info('卖出信号');
      let accountId = this.accountId;
      if (input.type === types.SymbolType.cryptocoin) {
        accountId = this.coinId;
      }
      // 查询资产
      const account = await AccountManager.get(accountId);
      if (!account) {
        Log.system.error(`系统出错，未查询到用户(${accountId})信息。`);
        return;
      }
      // 查询是否有持仓
      let position: types.Model.Position | undefined;
      if (account.positions) {
        position = account.positions.find((posi) => {
          return posi.symbol === String(input.symbol) && posi.side === types.OrderSide.Buy;
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
      Log.system.info(`信号股价(${input.signal.price}) > 当前股价(${input.price}) && 盈利超过700(${input.price - position.price} > 7)`);
      const profitRule = input.type === types.SymbolType.cryptocoin ? true : input.price - position.price > 7;
      // 信号出现时股价 > 当前股价(股价下跌) && 并且盈利超过700（数字货币无此限制）
      if (input.signal.price > input.price && profitRule) {
        Log.system.info(`卖出信号出现后,${input.symbol}股价下跌,卖出处理[开始]`);
        const order = <types.LimitOrder>Object.assign({}, this.order, {
          symbol: input.symbol,
          side: types.OrderSide.BuyClose,
          price: input.price,
        });
        if (input.type === types.SymbolType.cryptocoin) {
          order.amount = 0.001
        }
        if (this.backtest.test) {
          order.backtest = '1';
          order.mocktime = input.time;
        }
        try {
          // 卖出
          await this.postOrder(order);
          const profit = (order.price * order.amount) - (input.price * order.amount)
            - this.getFee(<types.SymbolType>input.type);
          await this.postTradeSlack(order, profit);
        } catch (e) {
          Log.system.warn('发送卖出请求失败：', e.stack);
        }
        // 记录交易信息
        await TraderManager.set(this.accountId, order);
        // 消除信号
        await SignalManager.remove(input.signal.id);
      } else if (input.signal.price < input.price) { // 股价继续上涨
        Log.system.info('更新卖出信号股价', input.price);
        input.signal.price = input.price;
        if (this.backtest.test) {
          input.signal.backtest = '1';
          input.signal.mocktime = input.time;
        }
        // 记录当前股价
        await SignalManager.set(<types.Model.Signal>input.signal);
      }
    }
    Log.system.info('交易信号处理[终了]');
  }

  // 警报处理
  async alertHandle(signal: types.Model.Signal) {
    await this.postSlack(signal);
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
        channel: signal.type === 'stock' ? '#kdj' : '#coin',
        attachments: [
          {
            color: signal.side === 'buy' ? 'danger' : 'good',
            title: '商品：' + signal.symbol,
            text: signal.notes,
            fields: [
              {
                title: '价格',
                value: signal.price + '',
                short: true
              },
              {
                title: '方向',
                value: signal.side === 'buy' ? '买入' : '卖出',
                short: true
              }
            ],
            footer: '5分钟KDJ   ' + moment().format('YYYY-MM-DD hh:mm:ss'),
            footer_icon: signal.type === 'stock' ?
              'https://platform.slack-edge.com/img/default_application_icon.png' : 'https://png.icons8.com/dusk/2x/bitcoin.png'
          }
        ]
      })
    };
    return await fetch(config.slack.url, requestOptions);
  }

  public async postTradeSlack(order: types.Order, profit: number) {
    const requestOptions = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        channel: '#coin_trade',
        attachments: [
          {
            color: order.side === 'buy' ? 'danger' : 'good',
            title: '商品：' + order.symbol,
            fields: [
              {
                title: '价格',
                value: order.price + '',
                short: true
              },
              {
                title: '方向',
                value: order.side === 'buy' ? '买入' : '卖出',
                short: true
              },
              {
                title: '数量',
                value: order.amount + '',
                short: true
              },
              {
                title: '盈利',
                value: profit + '',
                short: true
              }
            ],
            footer: 'AI自动交易   ' + moment().format('YYYY-MM-DD hh:mm:ss'),
            footer_icon: 'https://png.icons8.com/dusk/2x/event-accepted.png'
          }
        ]
      })
    };
    return await fetch(config.slack.url, requestOptions);
  }
}
