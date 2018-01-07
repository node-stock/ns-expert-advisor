import { ExpertAdvisor, ITradingInput } from './expert-advisor';
import * as assert from 'power-assert';
import * as types from 'ns-types';
import { SlackAlerter } from 'ns-alerter';

const expertAdvisor = new ExpertAdvisor();
const testGet5minData = async () => {
  /*
    const _start = Date.now();
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      const bars = await expertAdvisor.get5minData('6553');
      /*console.log(
        '%s\n...\n%s',
        JSON.stringify(bars[0], null, 2),
        JSON.stringify(bars[bars.length - 1], null, 2)
      );*/
  /* console.log('len: ' + bars.length);
   console.log('执行时间: %dms', Date.now() - start);
 }
 console.log('总执行时间: %dms', Date.now() - _start);
 assert(true);*/
}


const testGetCq5minData = async () => {
  /*
    const res = await expertAdvisor.getCq5minData('6553');
    console.log(res);
    assert(true);*/
}

const testOnPretrade = async () => {/*
  const hisData: types.Bar[] = await expertAdvisor._getTest5minData('6664');
  await expertAdvisor.updAsset();
  for (let i = 0; i < hisData.length; i++) {
    await expertAdvisor.onPretrade();
  }
  assert(true);*/
}

const testPostOrder = async () => {
  const order: types.LimitOrder = {
    account_id: 'test',
    price: '2300',
    symbol: '6664',
    orderType: types.OrderType.Limit,
    tradeType: types.TradeType.Margin,
    symbolType: types.SymbolType.stock,
    side: types.OrderSide.Buy,
    amount: '200',
    eventType: types.EventType.Order,
    backtest: '1'
  };
  const res = await expertAdvisor.postOrder(order);
  console.log(res)
  assert(true);
}

const testPostSlack = async () => {
  const signal: types.Model.Signal = {
    price: '0.00001234',
    symbol: 'btc_jpy',
    side: types.OrderSide.Buy
  };
  await SlackAlerter.sendSignal(signal);
  assert(true);
}

const testTradingHandle = async () => {
  /*const input: ITradingInput = {
    symbol: 'xrp_jpy',
    type: types.SymbolType.cryptocoin,
    price: '87.24',
    time: 'test',
    signal: {
      side: types.OrderSide.Buy,
      price: '86'
    }
  };
  const res = await expertAdvisor.tradingHandle(input);
  console.log(res);*/
  assert(true);
}
// expertAdvisor.start();

describe('ExpertAdvisor测试', () => {
  before(async () => {
    await expertAdvisor.dataProvider.init();
  });
  /*
  it('测试数据获取', testGet5minData);
  it('测试CQ数据', testGetCq5minData);*/
  // it('测试交易处理', testTradingHandle);
  it('测试发送交易信号', testPostSlack);
  // it('预交易测试', testOnPretrade);
  // it('测试发送交易信息', testPostOrderSlack);
  // it('测试发送数字货币信号', testPostSlack);
  /* it('交易服务测试', testPostOrder);*/
  after(async () => {
    console.log('测试后处理');
    await expertAdvisor.destroy();
  });
});
