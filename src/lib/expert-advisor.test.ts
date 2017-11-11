import { ExpertAdvisor } from './expert-advisor';
import * as assert from 'power-assert';
import * as types from 'ns-types';

const expertAdvisor = new ExpertAdvisor();

const testGet5minData = async (done: () => void) => {

  const _start = Date.now();
  for (let i = 0; i < 10; i++) {
    const start = Date.now();
    const bars = await expertAdvisor.get5minData('6553');
    console.log(
      '%s\n...\n%s',
      JSON.stringify(bars[0], null, 2),
      JSON.stringify(bars[bars.length - 1], null, 2)
    );
    console.log('len: ' + bars.length);
    console.log('执行时间: %dms', Date.now() - start);
  }
  console.log('总执行时间: %dms', Date.now() - _start);
  assert(true);
  done();
}

const testOnPretrade = async (done: () => void) => {
  const hisData: types.Bar[] = await expertAdvisor._getTest5minData('6664');
  await expertAdvisor.updAsset();
  for (let i = 0; i < hisData.length; i++) {
    await expertAdvisor.onPretrade();
  }
  assert(true);
  done();
}

describe('ExpertAdvisor测试', () => {
  /*it('测试数据获取', function (done) {
    this.timeout(300000);
    testGet5minData(done);
  });*/
  it('交易测试', function (done) {
    this.timeout(3000000);
    testOnPretrade(done);
  });
  after(() => {
    console.log('测试后处理');
    expertAdvisor.destroy();
  });
});
