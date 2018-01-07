import { Log, Util } from 'ns-common';
import { DataProvider } from 'ns-findata';
import { Signal, IKdjSignal, IKdjOutput } from 'ns-signal';
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
  symbol: string;
  symbolType: string;
  price: string;
  time: string;
  signal: types.Signal;
}

export class ExpertAdvisor {
  symbols: string | string[];
  coins: string[];
  accounts: types.ConfigAccount[];
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
    assert(config.accounts, 'config.accounts required.');
    assert(config.ea, 'config.ea required.');
    assert(config.backtest, 'config.backtest required.');
    assert(config.store, 'config.store required.');
    this.symbols = config.ea.symbols;
    this.coins = config.ea.coins;
    this.backtest = config.backtest;
    this.interval = config.ea.interval;
    this.watchStock = config.ea.symbolType.includes['stock'];
    this.accounts = config.accounts;
    this.signal = new Signal(config);
    this.dataProvider = new DataProvider(config.store);
    this.order = {
      account_id: '',
      eventType: types.EventType.Order,
      tradeType: types.TradeType.Spot,
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
    Log.system.info('启动智能交易程序...');
    await this.dataProvider.init();
    await SignalManager.removeAll();
    // await this.onPretrade();
    this.worker = setInterval(this.onPretrade.bind(this), this.interval);
  }

  async onPretrade() {
    try {
      const { watchList, signalList } = await this.getSignalAndWatchList();
      Log.system.info('预交易分析[启动]');
      // 更新订单状态
      await OrderManager.updateStatus();
      Log.system.info('监视列表：', watchList);
      let i = 0;
      for (const symbol of watchList) {
        Log.system.info(`处理商品：${symbol}`);
        const signal = signalList.find((o: IKdjSignal) => o.symbol === symbol);
        // 查询数据库中的信号
        let dbSignals = <types.Signal[]>await SignalManager.getAll({ symbol });
        Log.system.info(`查询数据库中的信号:${JSON.stringify(dbSignals)}`);
        // 返回kdj信号时
        if (signal && signal.results.length > 0) {

          const kdjOutputs = signal.results;
          for (const kdjOutput of kdjOutputs) {
            // 产生信号时，进行处理
            if (kdjOutput.strategy && kdjOutput.strategy.side) {
              const strategy = kdjOutput.strategy;
              const dbSignal = dbSignals.find(o => o.side === strategy.side);
              const isHandledSignal = await this.signalHandle(symbol, signal.symbolType, kdjOutput, dbSignal);
              if (isHandledSignal) {
                dbSignals = <types.Signal[]>await SignalManager.getAll({ symbol });
              }
            }
            // 数据库中已存储信号
            if (dbSignals.length > 0 && kdjOutput.lastPrice && kdjOutput.lastTime) {
              // 交易处理
              await this.tradingHandle({
                symbol,
                symbolType: signal.symbolType,
                price: kdjOutput.lastPrice,
                time: kdjOutput.lastTime,
                signal: dbSignals[0]
              });
            }
          }
        }
      }
      i++;
    } catch (err) {
      Log.system.error(err.stack);
    }
    Log.system.info('预交易分析[终了]');
  }

  async getSignalAndWatchList() {
    Log.system.info('获取信号和监视列表[启动]');
    let signalList: IKdjSignal[] = [];
    let watchList: string[] = []
    if (this.coins && this.coins.length > 0) {
      signalList = await this.getKdjSignals(this.coins);
      watchList = this.coins;
    }
    if (this.watchStock && Util.isTradeTime() && this.symbols.length > 0) {
      watchList = watchList.concat(this.symbols)
      Log.system.info('股市交易时间,查询股市信号');
      signalList = signalList.concat(await this.signal.kdj(
        this.symbols, types.SymbolType.stock, [types.CandlestickUnit.Min5]));
    }
    Log.system.info('获取信号和监视列表[终了]');
    return { signalList, watchList }
  }

  // 信号处理
  async signalHandle(symbol: string, symbolType: string, kdjOutput: IKdjOutput, dbSignal?: types.Signal) {
    Log.system.info('信号处理[启动]');
    if (!kdjOutput.strategy) {
      Log.system.error(`信号策略结果为${kdjOutput.strategy}，退出信号处理`);
      return;
    }
    const modelSignal: types.Model.Signal = Object.assign({
      symbol,
      price: kdjOutput.lastPrice,
      type: symbolType,
      time: kdjOutput.lastTime,
      notes: `k值：${kdjOutput.strategy.k}`
    }, kdjOutput, { side: String(kdjOutput.strategy.side) });
    if (this.backtest.test) {
      modelSignal.backtest = '1';
      // modelSignal.mocktime = signal.lastTime;
    } else {
      modelSignal.backtest = '0';
    }

    // 未存储信号 或者信号时间段不一致时
    if (!dbSignal || (dbSignal
      && dbSignal.time !== kdjOutput.lastTime
      && dbSignal.timeframe === kdjOutput.timeframe)) {
      // 记录信号
      await SignalManager.set(modelSignal);
      Log.system.info(`推送信号警报：`, modelSignal);
      // 推送信号警报
      await SlackAlerter.sendSignal(modelSignal);
      Log.system.info('信号处理[终了]');
      return true;
    }
    Log.system.info('信号处理[终了]');
    return false;
  }

  // 交易处理
  async tradingHandle(input: ITradingInput) {
    Log.system.info('交易信号处理[启动]');
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

    if (input.symbolType === types.SymbolType.cryptocoin) {
      for (let [index, acc] of this.accounts.entries()) {
        const accountId = acc.bitbank.id;
        // 查询资产
        const account = await AccountManager.get(accountId);
        if (!account) {
          Log.system.error(`系统出错，未查询到用户(${accountId})信息。`);
          return;
        }
        // 查询信号是否已使用
        const usedOrder = await OrderManager.get({
          symbol: input.symbol,
          signal_id: input.signal.id,
          side: input.signal.side,
          account_id: account.id
        }, true);
        // 未使用时，执行订单
        if (!usedOrder) {
          Log.system.info(`用户(${accountId})，执行订单。`);
          order.backtest = account.backtest;
          order.account_id = account.id;
          order.signal_id = input.signal.id;
          const isLast = index === this.accounts.length - 1;
          await this.execOrder(input, account, order, isLast, tradeAssetType);
        }
      }
    }
    Log.system.info('交易信号处理[终了]');
  }

  // 执行订单
  async execOrder(
    input: ITradingInput,
    account: types.Account,
    order: types.Order,
    isLast: boolean,
    tradeAssetType?: types.AssetType
  ) {
    Log.system.info('执行订单[开始]');

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
            // 查询信号是否已使用
            const order = OrderManager.get({ signal_id: input.signal.id, symbol: input.symbol }, true);
            if (order) {
              Log.system.info(`信号已被使用,中断买入操作`);
              return;
            }
          }
        }

        const balanceAsset = account.assets.find(o => o.asset === types.AssetType.Jpy);
        const bitcoinAsset = account.assets.find(o => o.asset === types.AssetType.Btc);
        const balance = new BigNumber(balanceAsset ? balanceAsset.free_amount : '0');
        const bitcoin = new BigNumber(bitcoinAsset ? bitcoinAsset.free_amount : '0');
        if (balance.isNegative()) {
          Log.system.error(`余额异常(${JSON.stringify(balanceAsset, null, 2)})`);
          return;
        }
        if (bitcoin.isNegative()) {
          Log.system.error(`余币异常(${JSON.stringify(bitcoinAsset, null, 2)})`);
          return;
        }
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
          Log.system.info(`可用余额：${balance}`);
          if (balance.lessThan(orderPrice)) {
            Log.system.warn(`可用余额：${balance} < 订单价格：${orderPrice}，退出买入处理！`);
            return;
          }
        }
        Log.system.info(`订单价格:${orderPrice}`);
        try {
          // 下单买入
          await this.postOrder(order);
          await SlackAlerter.sendOrder(order);
          Log.system.info(`发送买入指令`);
        } catch (e) {
          Log.system.warn('发送买入指令失败：', e.stack);
        }
        Log.system.info(`买入处理[终了]`);
      } else if (signalPrice.greaterThan(currentPrice)) { // 价格继续下跌
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
          await this.postOrder(order);
          await SlackAlerter.sendOrder(order);
        } catch (e) {
          Log.system.warn('发送卖出请求失败：', e.stack);
        }
      } else if (signalPrice.lessThan(currentPrice)) { // 价格继续上涨
        Log.system.info('更新卖出信号价格', input.price);
        input.signal.price = input.price;
        // 记录当前价格
        await SignalManager.set(<types.Model.Signal>input.signal);
      }
    }
    Log.system.info('执行订单[终了]');
  }

  async postOrder(order: types.Order) {
    // 调用下单API
    const requestOptions = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        orderInfo: order
      })
    };
    const url = `http://${config.trader.host}:${config.trader.port}/api/v1/order`;
    await fetch(url, requestOptions);
  }

  async getKdjSignals(symbols: string[]) {
    const units = [
      types.CandlestickUnit.Min5,
      types.CandlestickUnit.Min30,
      types.CandlestickUnit.Hour1,
      types.CandlestickUnit.Hour4
    ];
    return await this.signal.kdj(symbols, types.SymbolType.cryptocoin, units);
  }
}
