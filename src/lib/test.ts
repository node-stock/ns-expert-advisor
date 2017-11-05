import { Log } from 'ns-common';
import { GoogleFinance, DataProvider } from 'ns-findata';
import { SniperStrategy, SniperSingal } from 'ns-strategies';
import * as types from 'ns-types';
import { Manager } from 'ns-manager';
import { WebTrader as Trader } from 'ns-trader';
import * as moment from 'moment';
import * as assert from 'power-assert';
import { updateLocale } from 'moment';

// 获取历史数据
GoogleFinance.getHistory({
  q: '6553',
  x: 'TYO',
  p: '1d',
  i: 300
}).then((res) => console.log(res));
