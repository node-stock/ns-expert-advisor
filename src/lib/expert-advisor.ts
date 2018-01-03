import { Log, Util } from 'ns-common';
import { DataProvider } from 'ns-findata';
import { Signal, IKdjOutput } from 'ns-signal';
import { SlackAlerter } from 'ns-alerter';
import * as types from 'ns-types';
import { SignalManager, AccountManager, OrderManager, TransactionManager } from 'ns-manager';

import * as assert from 'power-assert';
import * as moment from 'moment';
import * as fetch from 'isomorphic-fetch';
import { BigNumber } from 'BigNumber.js';
const Loki = require('lokijs');
const config = require('config');

export interface ITradingInput {
  symbol: string,
  symbolType: string,
  price: string,
  time: string,
  signal: types.Signal
}

export class ExpertAdvisor {
  symbols: string[];
  coins: string[];
  accountId: string;
  coinId: string;
  order: types.Order;
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
  worker: number = 0;
  dataProvider: DataProvider;
  // 是否监视股票数据
  watchStock: boolean;

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
    this.watchStock = config.ea.symbolType.includes['stock'];
    this.accountId = config.account.userId;
    this.coinId = config.account.coinId;
    this.signal = new Signal(config);
    this.dataProvider = new DataProvider(config.store);
    this.order = {
      eventType: types.EventType.Order,
      tradeType: types.TradeType.Margin,
      orderType: types.OrderType.Limit,
      symbolType: types.SymbolType.stock,
      side: types.OrderSide.Buy,
      symbol: '',
      backtest: '1',
      price: '0',
      amount: '100'
    }
  }

  async destroy() {
    clearInterval(this.worker);
    await this.dataProvider.close();
  }

  async start() {
    Log.system.info('启动智能交易应用...');
    await this.dataProvider.init();
    // await this.onPretrade();
    this.worker = setInterval(this.onPretrade.bind(this), this.interval);
  }

  async onPretrade() {
    try {

      Log.system.info('预交易分析[启动]');
      // 更新订单状态
      await OrderManager.updateStatus();
      let signalList: IKdjOutput[] = [];
      let watchList: string[] = []
      if (this.coins && this.coins.length > 0) {
        signalList = signalList.concat(<IKdjOutput[]>await this.signal.kdj(
          this.coins, types.SymbolType.cryptocoin, types.CandlestickUnit.Min5));
        watchList = this.coins;
      }
      if (this.watchStock && Util.isTradeTime() && this.symbols.length > 0) {
        watchList = watchList.concat(this.symbols)
        Log.system.info('股市交易时间,查询股市信号');
        signalList = signalList.concat(<IKdjOutput[]>await this.signal.kdj(
          this.symbols, types.SymbolType.stock, types.CandlestickUnit.Min5));
      }
      Log.system.info('监视列表：', watchList);
      let i = 0;
      for (const symbol of watchList) {
        Log.system.info(`处理商品：${symbol}`);
        // 查询数据库中的信号
        const dbSignal = <types.Signal>await SignalManager.get({ symbol });
        Log.system.info(`查询数据库中的信号:${JSON.stringify(dbSignal)}`);
        try {
          const signal = signalList[i];
          // kdj算出信号时
          if (signal && signal.side) {
            await this.signalHandle(symbol, signal, dbSignal);
          }
          // 数据库中已存储信号
          if (dbSignal) {
            // 交易处理
            await this.tradingHandle({
              symbol,
              symbolType: <types.SymbolType>signal.symbolType,
              price: String(signal.lastPrice),
              time: String(signal.lastTime),
              signal: dbSignal
            });
          }
          i++;
        } catch (err) {
          Log.system.error(err.stack);
        }
      }

      Log.system.info('预交易分析[终了]');
    } catch (e) {
      Log.system.error(e.stack);
      await this.dataProvider.close();
      await this.dataProvider.init();
    }
  }

  // 信号处理
  async signalHandle(symbol: string, signal: IKdjOutput, dbSignal: types.Model.Signal | null) {
    const modelSignal: types.Model.Signal = Object.assign({
      symbol,
      price: signal.lastPrice,
      type: signal.symbolType,
      notes: `k值：${signal.k}`
    }, signal, { side: String(signal.side) });
    if (dbSignal && dbSignal.id) {
      modelSignal.id = dbSignal.id;
    }
    if (this.backtest.test) {
      modelSignal.backtest = '1';
      // modelSignal.mocktime = signal.lastTime;
    } else {
      modelSignal.backtest = '0';
    }

    // 更新信号
    if (dbSignal) {
      Log.system.info(`查询出已存储信号(${JSON.stringify(dbSignal, null, 2)})`);
      const signalInterval = Date.now() - new Date(String(dbSignal.updated_at)).getTime();
      if (signalInterval <= (120 * 1000)) {
        Log.system.info(`信号间隔小于2分钟,不发送信号！`);
      } else {
        /*if (dbSignal.id) {
          Log.system.info(`删除${modelSignal.symbol},${modelSignal.side}旧信号。`);
          // 删除旧信号
          await SignalManager.removeById(dbSignal.id);
          delete modelSignal.id;
        }*/
        Log.system.info(`推送信号警报。`);
        // 推送信号警报
        await SlackAlerter.sendSignal(modelSignal);
      }
    }
    // 记录信号
    await SignalManager.set(modelSignal);
  }

  // 交易处理
  async tradingHandle(input: ITradingInput) {
    Log.system.info('交易信号处理[启动]');
    let accountId = this.accountId;
    if (input.symbolType === types.SymbolType.cryptocoin) {
      accountId = this.coinId;
    }
    // 查询资产
    const account = await AccountManager.get(accountId);
    if (!account) {
      Log.system.error(`系统出错，未查询到用户(${accountId})信息。`);
      return;
    }
    // 更新订单状态
    await OrderManager.updateStatus();
    // 订单对象
    const order: types.Order = Object.assign({}, this.order, {
      symbol: input.symbol,
      symbolType: input.symbolType,
      price: input.price,
      backtest: input.signal.backtest,
      side: input.signal.side === types.OrderSide.Sell ? types.OrderSide.BuyClose : input.signal.side,
    });
    let tradeAssetType;
    if (input.symbolType === types.SymbolType.cryptocoin) {
      const res = Util.getTradeUnit(input.symbol);
      order.amount = res.amount;

      if (this.backtest.test) {
        const divNum = input.symbol === types.Pair.BTC_JPY ? 10 : 100;
        order.amount = new BigNumber(order.amount).div(divNum).toString();
        Log.system.info(`测试模式,${input.symbol}购买单位除以${divNum}：变为${order.amount}`);
      }
      // 交易类型：使用现金为undefined,使用比特币为btc
      tradeAssetType = res.type;
    }
    if (order.backtest === '1') {
      Log.system.info(`订单为测试单追加mocktime: ${input.time}`);
      order.mocktime = input.time;
    }

    const signalPrice = new BigNumber(input.signal.price);
    const currentPrice = new BigNumber(input.price);

    // 买入信号
    if (input.signal.side === types.OrderSide.Buy) {
      Log.system.info('买入信号');
      // 信号价格 < 当前价格(价格止跌上涨)
      if (signalPrice.lessThan(currentPrice)) {
        Log.system.info(`买入信号出现后,${input.symbol}价格止跌上涨,买入处理[开始]`);
        // 查询持仓
        if (account.positions && account.positions.length > 0) {
          const position = account.positions.find(posi =>
            posi.symbol === input.symbol && posi.side === input.signal.side);
          if (position) {
            Log.system.info(`查询出已持有此商品(${JSON.stringify(position, null, 2)})`);
            const buyInterval = Date.now() - new Date(String(position.created_at)).getTime();
            Log.system.info(`与持仓买卖间隔(${buyInterval})`);
            if (buyInterval <= (600 * 1000)) {
              Log.system.info(`买卖间隔小于10分钟,中断买入操作`);
              return;
            }
          }
        }

        const balanceAsset = account.assets.find(o => o.asset === types.AssetType.Jpy);
        const bitcoinAsset = account.assets.find(o => o.asset === types.AssetType.Btc);
        if (!balanceAsset || new BigNumber(balanceAsset.free_amount).isNegative()) {
          Log.system.error(`余额异常(${JSON.stringify(balanceAsset, null, 2)})`);
          return;
        }
        if (!bitcoinAsset || new BigNumber(bitcoinAsset.free_amount).isNegative()) {
          Log.system.error(`余币异常(${JSON.stringify(bitcoinAsset, null, 2)})`);
          return;
        }
        const balance = new BigNumber(balanceAsset.free_amount);
        const bitcoin = new BigNumber(bitcoinAsset.free_amount);
        // 订单价格
        const orderPrice = new BigNumber(order.price)
          .times(order.amount).plus(Util.getFee(input.symbol));
        if (tradeAssetType === types.AssetType.Btc) {
          Log.system.info(`通过比特币购买，可用余币：${bitcoin}`);
          if (bitcoin.lessThan(orderPrice)) {
            Log.system.warn(`可用余币：${bitcoin} < 订单价格：${orderPrice}，退出买入处理！`);
            return;
          }
        } else {
          if (balance.lessThan(orderPrice)) {
            Log.system.warn(`可用余额：${balance} < 订单价格：${orderPrice}，退出买入处理！`);
            return;
          }
        }
        Log.system.info(`订单价格:${orderPrice}`);
        try {
          // 下单买入
          await this.postOrder(accountId, order);
          await SlackAlerter.sendOrder(order);
          Log.system.info(`发送买入指令`);
        } catch (e) {
          Log.system.warn('发送买入指令失败：', e.stack);
        }
        // 消除信号
        if (input.signal.id) {
          await SignalManager.removeById(input.signal.id);
        }
        Log.system.info(`买入处理[终了]`);
      } else if (signalPrice.greaterThanOrEqualTo(currentPrice)) { // 价格继续下跌
        Log.system.info('更新买入信号价格', input.price);
        input.signal.price = input.price;
        // 记录当前价格
        await SignalManager.set(<types.Model.Signal>input.signal);
      }
    } else if (input.signal.side === types.OrderSide.Sell) {
      Log.system.info('卖出信号');
      // 查询是否有持仓
      let position: types.Model.Position | undefined;
      if (account.positions && account.positions.length != 0) {
        position = account.positions.find((posi: types.Model.Position) => {
          return posi.symbol === String(input.symbol) && posi.side === types.OrderSide.Buy;
        });
      }
      if (!position) {
        Log.system.warn('未查询到持仓，不进行卖出！');
        return;
      }
      Log.system.info(`获取持仓:${JSON.stringify(position)}`);
      if (!position.price) {
        Log.system.error('持仓价格为空！');
        return;
      }
      const posiPrice = new BigNumber(position.price);
      const pip = currentPrice.minus(posiPrice);
      Log.system.info(`信号价格(${signalPrice.toString()}) > 当前价格(${currentPrice.toString()})`);
      if (position.type === types.SymbolType.stock) {
        Log.system.info(` && 盈利超过700(${pip.toString}[当前价格(${currentPrice} - 持仓价格(${posiPrice})] > 7) `);
      }
      // 止盈规则
      const profitRule = input.symbolType === types.SymbolType.cryptocoin ?
        currentPrice.greaterThan(posiPrice) : pip.greaterThan(new BigNumber(7)); // >= 1.1
      // 信号出现时价格 > 当前价格(价格下跌) && 并且盈利超过700（数字货币无此限制）
      if (signalPrice.greaterThan(currentPrice) && profitRule) {
        Log.system.info(`卖出信号出现后, ${input.symbol}价格下跌, 卖出处理[开始]`);
        try {
          // 下单卖出
          await this.postOrder(accountId, order);
          await SlackAlerter.sendOrder(order);
        } catch (e) {
          Log.system.warn('发送卖出请求失败：', e.stack);
        }
        // 消除信号
        if (input.signal.id) {
          await SignalManager.removeById(input.signal.id);
        }
      } else if (signalPrice.lessThan(currentPrice)) { // 价格继续上涨
        Log.system.info('更新卖出信号价格', input.price);
        input.signal.price = input.price;
        // 记录当前价格
        await SignalManager.set(<types.Model.Signal>input.signal);
      }
    }
    Log.system.info('交易信号处理[终了]');
  }

  async postOrder(accountId: string, order: types.Order): Promise<any> {
    // 调用下单API
    const requestOptions = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        accountId,
        orderInfo: order
      })
    };
    const url = `http://${config.trader.host}:${config.trader.port}/api/v1/order`;
    return await fetch(url, requestOptions);
  }
}
