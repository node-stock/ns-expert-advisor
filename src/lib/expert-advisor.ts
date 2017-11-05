import { Log } from 'ns-common';
import { GoogleFinance, DataProvider } from 'ns-findata';
import { SniperStrategy, SniperSingal } from 'ns-strategies';
import * as types from 'ns-types';
import { Manager } from 'ns-manager';
import { WebTrader as Trader } from 'ns-trader';
import * as assert from 'power-assert';
import * as numeral from 'numeral';
import * as moment from 'moment';
const Loki = require('lokijs');

export class ExpertAdvisor {
  symbol: string;
  account: { id: string, balance: number };
  backtest: {
    test: boolean,
    isLastDate: string,
    date: string,
    interval: number,
    loki: any
  };
  // 实时监测间隔
  interval: number;
  manager: Manager;
  trader: Trader;
  dataProvider: DataProvider;

  constructor(config: { [Attr: string]: any }) {
    assert(config, 'config required.');
    assert(config.trader, 'config.trader required.');
    assert(config.account, 'config.account required.');
    assert(config.ea, 'config.ea required.');
    assert(config.backtest, 'config.backtest required.');
    assert(config.store, 'config.store required.');
    this.symbol = config.trader.symbol;
    this.backtest = config.backtest;
    // 回测模式时，启动临时中间数据库
    if (this.backtest.test) {
      this.backtest.loki = new Loki('backtest.db');
    }
    this.interval = this.backtest.test ? this.backtest.interval : config.ea.interval;
    this.manager = new Manager();
    this.trader = new Trader(config);
    this.account = { id: config.account.userId, balance: 0 };
    this.dataProvider = new DataProvider(config.store);
  }

  destroy() {
    this.manager.destroy();
    this.trader.end();
    this.dataProvider.close();
  }

  async start() {
    await this.dataProvider.init()
    // 更新余额
    await this.updBalance();
    if (this.account.balance === 0) {
      Log.system.warn(`账户：${this.account.id},可用余额：0,不执行EA程序！`);
      return;
    }
    setInterval(this.onPretrade, this.interval);
    await this.trader.init();
  }

  async updBalance() {
    this.account.balance = await this.manager.asset.getBalance(this.account.id);
  }

  async _getTest5minData(symbol: string): Promise<types.Bar[]> {

    let hisData: types.Bar[] = [];
    // 取最近一日数据
    if (this.backtest.isLastDate) {
      hisData = <types.Bar[]>await GoogleFinance.getHistory({
        q: symbol,
        x: 'TYO',
        p: '1d',
        i: 300
      });
    } else if (this.backtest.date) {
      hisData = await this.dataProvider.get5minBar({
        symbol: this.symbol,
        date: this.backtest.date
      })
    }
    return hisData;
  }

  async getTest5minData(symbol: string): Promise<types.Bar[]> {
    const hisData: types.Bar[] = await this._getTest5minData(symbol);
    if (hisData.length === 0) {
      throw new Error('回测环境未获取5分钟线数据！');
    }
    const loki = this.backtest.loki;
    let coll = loki.getCollection(symbol);
    if (!coll) {
      coll = loki.addCollection(symbol);
      // 插入第一条数据
      // TODO coll.insert(hisData[0]);
      coll.insert(hisData.slice(0, 15));
    } else {
      // 插入下一条数据
      coll.insert(hisData[coll.find().length]);
    }
    return <types.Bar[]>coll.chain().find().data({ removeMeta: true });
  }

  async get5minData(symbol: string): Promise<types.Bar[]> {
    if (this.backtest.test) {
      return await this.getTest5minData(symbol);
    }
    // 获取历史数据
    const hisData = <types.Bar[]>await GoogleFinance.getHistory({
      q: symbol,
      x: 'TYO',
      p: '1d',
      i: 300
    });
    // 获取当天最5分钟k线
    const barData = await this.dataProvider.getLast5minBar(symbol);
    // 合并数据
    barData.map((bar) => {
      const res = hisData.find((his) => his.time !== bar.time);
      if (res) {
        hisData.push(res);
      }
    })
    return hisData;
  }

  async onPretrade() {
    Log.system.info('预交易分析[启动]');
    const hisData: types.Bar[] = await this.get5minData(this.symbol);
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
    const singal = await this.manager.signal.get({
      symbol: this.symbol
    });
    Log.system.info(`查询数据库中的信号:${JSON.stringify(singal)}`);
    try {
      // 已有信号
      if (singal) {
        // 处理信号
        await this.singalHandle(this.symbol, hisData, singal);
      } else {
        // 获取信号并存储
        await this.pullSingal(this.symbol, hisData);
      }
    } catch (err) {
      Log.system.error(err.stack);
    }
    Log.system.info('预交易分析[终了]');
  }

  async singalHandle(symbol: string, hisData: types.Bar[], singal: { [Attr: string]: any }) {
    Log.system.info('处理信号[启动]');
    const price: number = numeral(hisData[hisData.length - 1].close).value();
    const time = moment.unix((<number>hisData[hisData.length - 1].time) / 1000).format('YYYY-MM-DD HH:mm:ss');
    // 买入信号
    if (singal.side === types.OrderSide.Buy) {
      Log.system.info('买入信号');
      // 信号股价 < 当前股价(股价止跌上涨)
      if (singal.price < price) {
        Log.system.info('买入信号出现后,股价止跌上涨,立即买入', price);
        const order = <types.LimitOrder>Object.assign({}, this.trader.order, {
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
        // 更新余额
        await this.updBalance();
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
      const posiInput: { [Attr: string]: any } = {
        symbol: symbol,
        account_id: this.account.id,
        side: types.OrderSide.Buy
      };
      if (this.backtest.test) {
        posiInput.backtest = '1';
        posiInput.mocktime = time;
      }

      // 获取持仓
      const position = await this.manager.position.get(<types.Model.Position>posiInput);
      if (!position || !position.price) {
        throw new Error(`持仓:${JSON.stringify(position)},卖出信号出错`);
      }
      Log.system.info(`获取持仓:${JSON.stringify(position)}`);
      Log.system.info(`信号股价(${singal.price}) > 当前股价(${price}) && 盈利超过1000(${price} - ${position.price} > 10)`);
      // 信号出现时股价 > 当前股价(股价下跌) && 并且盈利超过1000
      if (singal.price > price && price - position.price > 10) {
        Log.system.info('卖出信号出现后,股价下跌,立即卖出', price);
        const order = <types.LimitOrder>Object.assign({}, this.trader.order, {
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
        // 更新余额
        await this.updBalance();
      }
    }
    Log.system.info('处理信号[终了]');
  }

  // 拉取信号
  async pullSingal(symbol: string, hisData: types.Bar[]) {
    Log.system.info('拉取信号[启动]');
    // 订单价格
    const orderPrice = numeral(hisData[hisData.length - 1].close).value() * 100 + 500;
    Log.system.info(`订单价格:${JSON.stringify(orderPrice)}`);
    if (this.account.balance < orderPrice) {
      const balance = numeral(this.account.balance).format('0,0');
      Log.system.warn(`可用余额：${balance} < 订单价格(${symbol})：${numeral(orderPrice).format('0,0')}，不拉取信号！`);
      return;
    }

    // 没有信号时，执行策略取得信号
    const singal: SniperSingal | null = SniperStrategy.execute(symbol, hisData);
    // 获得买卖信号
    if (singal && singal.side) {
      Log.system.info(`获得买卖信号：${JSON.stringify(singal)}`);
      if (singal.side === types.OrderSide.Sell) {
        // 查询是否有持仓
        const position = await this.manager.position.get({
          symbol, account_id: this.account.id,
          side: types.OrderSide.Buy
        });
        if (!position) {
          Log.system.warn('未查询到持仓，不保存卖出信号！');
          return;
        }
      }
      const price = hisData[hisData.length - 1].close;
      const modelSingal = <types.Model.Signal>Object.assign({
        symbol, price,
        notes: `k值：${singal.k}`
      }, singal)

      if (this.backtest.test) {
        modelSingal.backtest = '1';
        if (hisData[hisData.length - 1].time) {
          modelSingal.mocktime = moment.unix((<number>hisData[hisData.length - 1].time) / 1000).format('YYYY-MM-DD HH:mm:ss');
        }
      }
      // 记录信号
      await this.manager.signal.set(modelSingal);
    }
    Log.system.info('拉取信号[终了]');
  }
}
