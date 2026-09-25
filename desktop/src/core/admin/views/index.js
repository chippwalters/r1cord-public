// The admin pages, one module per r1cord_server/templates/*.html.

'use strict';

const { config } = require('./config');
const { dashboard } = require('./dashboard');
const { devices } = require('./devices');
const { importPage } = require('./import');
const { job } = require('./job');
const { pairing } = require('./pairing');
const { republish } = require('./republish');
const { system } = require('./system');

module.exports = { config, dashboard, devices, importPage, job, pairing, republish, system };
