import { ExpertAdvisor } from './expert-advisor';
import * as assert from 'power-assert';
import * as types from 'ns-types';

const expertAdvisor = new ExpertAdvisor();
const testGet5minData = async () => {

  const _start = Date.now();
  for (let i = 0; i < 10; i++) {
    const start = Date.now();
    const bars = await expertAdvisor.get5minData('6553');
    /*console.log(
      '%s\n...\n%s',
      JSON.stringify(bars[0], null, 2),
      JSON.stringify(bars[bars.length - 1], null, 2)
    );*/
    console.log('len: ' + bars.length);
    console.log('执行时间: %dms', Date.now() - start);
  }
  console.log('总执行时间: %dms', Date.now() - _start);
  assert(true);
}


const testGetCq5minData = async () => {

  const res = await expertAdvisor.getCq5minData('6553');
  console.log(res);
  assert(true);
}

const testOnPretrade = async () => {
  const hisData: types.Bar[] = await expertAdvisor._getTest5minData('6664');
  await expertAdvisor.updAsset();
  for (let i = 0; i < hisData.length; i++) {
    await expertAdvisor.onPretrade();
  }
  assert(true);
}

const testPostOrder = async () => {
  const order: types.LimitOrder = {
    price: 2300,
    symbol: '6664',
    orderType: types.OrderType.Limit,
    tradeType: types.TradeType.Margin,
    side: types.OrderSide.Buy,
    amount: 200,
    eventType: types.EventType.Order
  };
  const res = await expertAdvisor.postOrder(order);
  console.log(res.status)
  assert(true);
}

describe('ExpertAdvisor测试', () => {
  before(async () => {
    await expertAdvisor.start();
  })
  /*it('测试数据获取', testGet5minData);
  it('测试CQ数据', testGetCq5minData);*/
  it('预交易测试', testOnPretrade);
  // it('交易服务测试', testPostOrder);
  after(async () => {
    console.log('测试后处理');
    await expertAdvisor.destroy();
  });
});
