import { ExpertAdvisor } from './lib/expert-advisor';
import { Log, Util } from 'ns-common';

const config = require('config');
Log.init(Log.category.system, Log.level.ALL, 'ns-expert-advisor');

const expertAdvisor = new ExpertAdvisor();
expertAdvisor.start();