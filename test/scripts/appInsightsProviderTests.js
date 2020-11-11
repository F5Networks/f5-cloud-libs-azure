/**
 * Copyright 2019 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const q = require('q');
const util = require('util');
const assert = require('assert');
const expect = require("chai").expect;
const path_resolve = require('path').resolve;
const child_process = require('child_process');

describe('AppInsightsProvider Process Count test', () => {
    it('Two Running AppInsightsProvider Processes test', (done) => {
        child_process.exec('node ./scripts/appInsightsProvider.js --log-file ./test/scripts/test.log', 'utf8', (err, stdout, stderr) => {});
        child_process.exec('node ./scripts/appInsightsProvider.js --log-file ./test/scripts/test.log', 'utf8', (err, stdout, stderr) => {
            expect(stdout).to.contain('Another appInsightsProvider process already running.');
            done();
        });
    });
});


