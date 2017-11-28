import { Log } from 'ns-common';
import { GoogleFinance, DataProvider } from 'ns-findata';
import { SniperStrategy, SniperSingal } from 'ns-strategies';
import * as types from 'ns-types';
import { Manager } from 'ns-manager';
import { WebTrader as Trader } from 'ns-trader';
import { InfluxDB, Param, Enums } from 'ns-influxdb';
import { IResults } from 'influx';

import * as assert from 'power-assert';
import * as numeral from 'numeral';
import * as moment from 'moment-timezone';
import { any } from 'bluebird';
const Loki = require('lokijs');
const config = require('config');

export class ExpertAdvisor {
  symbols: string[];
  account: types.Model.Account;
  backtest: {
    test: boolean,
    isLastDate: string,
    date: string,
    interval: number,
    loki: any
  };
  // 实时监测间隔
  interval: number;
  worker: number;
  manager: Manager;
  trader: Trader;
  dataProvider: DataProvider;
  influxdb: InfluxDB;

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
    this.influxdb = new InfluxDB(config.influxdb);
    this.manager = new Manager();
    this.trader = new Trader(config);
    this.dataProvider = new DataProvider(config.store);
    // 回测模式时，启动临时中间数据库
    if (this.backtest.test) {
      this.backtest.loki = new Loki('backtest.db');
    }
  }

  destroy() {
    clearInterval(this.worker);
    this.manager.destroy();
    this.trader.end();
    this.dataProvider.close();
  }

  async start() {
    // 更新资产
    await this.updAsset();
    if (numeral(this.account.balance).value() === 0) {
      Log.system.warn(`账户：${this.account.id},可用余额：0,不执行EA程序！`);
      return;
    }
    this.worker = setInterval(this.onPretrade.bind(this), this.interval);
    await this.trader.init();
  }

  async updAsset() {
    const res = await this.manager.asset.get(this.account.id);
    if (res) {
      this.account = res;
    }
  }

  async _getTest5minData(symbol: string, type: 'mysql' | 'influxdb'): Promise<types.Bar[]> {

    let hisData: types.Bar[] = [];
    // 取最近一日数据
    if (this.backtest.isLastDate) {
      if (type === 'influxdb') {
        const query = `select * from ${Enums.Measurement.Candlestick_5min} where time > now() - 24h and symbol = '${symbol}'`;
        hisData = await this._getCq5minData(query);
      } else if (type === 'mysql') {
        hisData = <types.Bar[]>await GoogleFinance.getHistory({
          q: symbol,
          x: 'TYO',
          p: '1d',
          i: 300
        });
      }
    } else if (this.backtest.date) {
      if (type === 'influxdb') {
        const query = `select * from ${Enums.Measurement.Candlestick_5min} where time > now() - 24h and symbol = '${symbol}'`;
        hisData = await this._getCq5minData(query);
      } else if (type === 'mysql') {
        hisData = await this.dataProvider.get5minBar({
          symbol,
          date: this.backtest.date
        })
      }
    }
    return hisData;
  }

  async getTest5minData(symbol: string, type: 'mysql' | 'influxdb'): Promise<types.Bar[]> {
    const loki = this.backtest.loki;
    const inCollName = 'i_' + symbol;

    let inColl = loki.getCollection(inCollName);
    let hisData: types.Bar[] = [];
    // 股票输入表为空时，通过接口获取数据
    if (!inColl) {
      hisData = await this._getTest5minData(symbol, type);
      if (hisData.length === 0) {
        throw new Error('回测环境未获取5分钟线数据！');
      }
      inColl = loki.addCollection(inCollName);
      inColl.insert(JSON.parse(JSON.stringify(hisData)));
    } else {
      hisData = inColl.chain().find().data({ removeMeta: true });
    }
    // 取出数据导入输出表
    let outColl = loki.getCollection(symbol);
    if (!outColl) {
      outColl = loki.addCollection(symbol);
      // 插入第一条数据
      outColl.insert(hisData[0]);
    } else {
      const insertData = hisData[outColl.find().length];
      if (insertData) {
        outColl.insert(insertData);
      }
    }
    return <types.Bar[]>outColl.chain().find().data({ removeMeta: true });
  }

  async _getCq5minData(query: string): Promise<types.Bar[]> {
    const res = await this.influxdb.connection.query(query);
    const barList: types.Bar[] = new Array();
    res.forEach(el => {
      barList.push(<types.Bar>el);
    });
    return barList;
  }

  async getCq5minData(symbol: string): Promise<types.Bar[]> {
    const query = `select * from ${Enums.Measurement.Candlestick_5min} where time > now() - 12h and symbol = '${symbol}'`;
    return await this._getCq5minData(query);
  }

  async get5minData(symbol: string, type: 'mysql' | 'influxdb'): Promise<types.Bar[]> {
    Log.system.info('获取5分钟数据方法[启动]');
    if (this.backtest.test) {
      return await this.getTest5minData(symbol, type);
    }
    let hisData: types.Bar[] = new Array();
    if (type === 'influxdb') {
      const res = await this.getCq5minData(symbol);
      res.forEach(el => {
        hisData.push(<types.Bar>el);
      });
    } else if (type === 'mysql') {
      // 获取历史数据
      hisData = <types.Bar[]>await GoogleFinance.getHistory({
        q: symbol,
        x: 'TYO',
        p: '1d',
        i: 300
      });
      if (hisData.length) {
        console.log(
          'google获取数据：%s\n...\n%s',
          JSON.stringify(hisData[0], null, 2),
          JSON.stringify(hisData[hisData.length - 1], null, 2)
        );
        Log.system.info('len: ', hisData.length)
      }
      // 获取当天5分钟k线
      const barData = <types.Bar[]>await this.dataProvider.getLast5minBar(symbol);
      if (barData.length) {
        console.log(
          '获取当天5分钟k线：%s\n...\n%s',
          JSON.stringify(barData[0], null, 2),
          JSON.stringify(barData[barData.length - 1], null, 2)
        );
        Log.system.info('len: ', barData.length);
      }
      // 合并数据
      barData.map((bar) => {
        const res = hisData.find((his) => his.time !== bar.time);
        if (res) {
          hisData.push(res);
        }
      })
    }
    Log.system.info('获取5分钟数据方法[终了]');
    return hisData;
  }

  async onPretrade() {
    Log.system.info('预交易分析[启动]');

    for (const symbol of this.symbols) {

      const hisData: types.Bar[] = await this.get5minData(symbol, 'influxdb'); // this.get5minData(this.symbol);
      if (hisData.length === 0) {
        Log.system.error(`未查询到历史数据!`);
        return;
      }
      Log.system.info(
        '获取数据: %s\n...\n%s',
        JSON.stringify(hisData[0], null, 2),
        JSON.stringify(hisData[hisData.length - 1], null, 2)
      );
      Log.system.info('len: ' + hisData.length);

      // 查询数据库中的信号
      const singal = await this.manager.signal.get({ symbol });
      Log.system.info(`查询数据库中的信号:${JSON.stringify(singal)}`);
      try {
        // 已有信号
        if (singal) {
          // 处理信号
          await this.singalHandle(symbol, hisData, singal);
        } else {
          // 获取信号并存储
          await this.pullSingal(symbol, hisData);
        }
      } catch (err) {
        Log.system.error(err.stack);
      }
    }

    Log.system.info('预交易分析[终了]');
  }

  async singalHandle(symbol: string, hisData: types.Bar[], singal: { [Attr: string]: any }) {
    Log.system.info('处理信号[启动]');
    const price: number = numeral(hisData[hisData.length - 1].close).value();
    let time = String(hisData[hisData.length - 1].time);

    // 为文字时间类型时间
    if (Date.parse(time)) {
      time = (<{ [Attr: string]: any }>hisData[hisData.length - 1]).time;
      if (typeof (<any>time).getNanoTime === 'function') {
        time = String((<any>time).getNanoTime() / Math.pow(10, 6));
        time = moment.unix(Number(time) / 1000).format('YYYY-MM-DD HH:mm:ss');
      } else {
        // 文字时间字符串
        time = time.replace('T', ' ').replace('.000Z', '');
      }
    } else {
      time = moment.unix(Number(time) / 1000).format('YYYY-MM-DD HH:mm:ss');
    }
    // time = moment.tz(time, 'Asia/Tokyo').format();
    Log.system.info(`symbol：${symbol}, price：${price}, time：${time}`);
    // 买入信号
    if (singal.side === types.OrderSide.Buy) {
      Log.system.info('买入信号');
      // 信号股价 < 当前股价(股价止跌上涨)
      if (singal.price < price) {
        Log.system.info('买入信号出现后,股价止跌上涨,立即买入', price);
        const order = <types.LimitOrder>Object.assign({}, this.trader.order, {
          symbol,
          side: types.OrderSide.Buy,
          price
        });
        if (this.backtest.test) {
          order.backtest = '1';
          order.mocktime = time;
        }
        // 买入
        await this.trader.buy(order);
        // 记录交易信息
        await this.manager.trader.set(this.account, order);
        // 消除信号
        await this.manager.signal.remove(singal.id);
        // 更新资产
        await this.updAsset();
      } else if (singal.price > price) { // 股价继续下跌
        Log.system.info('更新买入信号股价', price);
        singal.price = price;
        if (this.backtest.test) {
          singal.backtest = '1';
          singal.mocktime = time;
        }
        // 记录当前股价
        await this.manager.signal.set(<types.Model.Signal>singal);
      }
    } else if (singal.side === types.OrderSide.Sell) {
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
      Log.system.info(`信号股价(${singal.price}) > 当前股价(${price}) && 盈利超过700(${price} - ${position.price} > 7)`);
      // 信号出现时股价 > 当前股价(股价下跌) && 并且盈利超过700
      if (singal.price > price && price - position.price > 7) {
        Log.system.info('卖出信号出现后,股价下跌,立即卖出', price);
        const order = <types.LimitOrder>Object.assign({}, this.trader.order, {
          symbol,
          side: types.OrderSide.Sell,
          price,
        });
        if (this.backtest.test) {
          order.backtest = '1';
          order.mocktime = time;
        }
        // 卖出
        await this.trader.sell(order);
        // 记录交易信息
        await this.manager.trader.set(this.account, order);
        // 消除信号
        await this.manager.signal.remove(singal.id);
        // 更新资产
        await this.updAsset();
      } else if (singal.price < price) { // 股价继续上涨
        Log.system.info('更新卖出信号股价', price);
        singal.price = price;
        if (this.backtest.test) {
          singal.backtest = '1';
          singal.mocktime = time;
        }
        // 记录当前股价
        await this.manager.signal.set(<types.Model.Signal>singal);
      }
    }
    Log.system.info('处理信号[终了]');
  }

  // 拉取信号
  async pullSingal(symbol: string, hisData: types.Bar[]) {
    Log.system.info('拉取信号[启动]');

    // 没有信号时，执行策略取得信号
    const singal: SniperSingal | null = SniperStrategy.execute(symbol, hisData);
    const price = numeral(hisData[hisData.length - 1].close).value();
    // 获得买卖信号
    if (singal && singal.side) {
      Log.system.info(`获得买卖信号：${JSON.stringify(singal)}`);
      if (singal.side === types.OrderSide.Buy) {
        // 订单价格
        const orderPrice = price * 100 + 500;
        Log.system.info(`订单价格:${JSON.stringify(orderPrice)}`);
        if (<number>this.account.balance < orderPrice) {
          const balance = numeral(this.account.balance).format('0,0');
          Log.system.warn(`可用余额：${balance} < 订单价格(${symbol})：${numeral(orderPrice).format('0,0')}，不拉取信号！`);
          return;
        }
      } else if (singal.side === types.OrderSide.Sell) {

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
      const modelSingal = <types.Model.Signal>Object.assign({
        symbol, price,
        notes: `k值：${singal.k}`
      }, singal);

      if (this.backtest.test) {
        modelSingal.backtest = '1';
        if (hisData[hisData.length - 1].time) {
          modelSingal.mocktime = moment.unix((<number>hisData[hisData.length - 1].time) / 1000).format('YYYY-MM-DD HH:mm:ss');
        }
      }
      // 记录信号
      await this.manager.signal.set(modelSingal);
      await this.influxdb.putSignal(<Param.Signal>modelSingal);
    }
    Log.system.info('拉取信号[终了]');
  }
}
