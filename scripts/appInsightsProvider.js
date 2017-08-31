#!/usr/bin/env node

/**
 * This provider is designed to be used to grab specific metrics from the current
 * BIG-IP and then run some calculations on those metrics and send them to 
 * Application Insights
 * 
 * Requires the Application Insights SDK - Listed Below
 * https://github.com/Microsoft/ApplicationInsights-node.js
 * 
 */

var options = require('commander');
var fs = require('fs');
var appInsights = require("applicationinsights");
var util = require('f5-cloud-libs').util;

var LogLevel = 'info'; // Set to debug/silly for more logging
var Logger = require('f5-cloud-libs').logger;
var logger = Logger.getLogger({logLevel: LogLevel, fileName: '/var/tmp/metricsCollector.log'});

var BigIp = require('f5-cloud-libs').bigIp;
var bigip = new BigIp({logger: logger});

/**
 * Grab command line arguments
 */
options
    .version('3.3.1')

    .option('--key <app_insights_key>', 'key')
    .parse(process.argv);


/**
 * Gather Metrics and send to Application Insights
 * Note: add this if debugging appInsights - appInsights.enableVerboseLogging();
 */
appInsights.setup(options.key);
var client = appInsights.client;

var cpuMetricName = 'F5_TMM_CPU';


bigip.init(
    'localhost',
    'admin',
    'file:///config/cloud/passwd',
    {
        passwordIsUrl: true,
        port: '8443'
    }
)
.then(function() {
    Promise.all([
        bigip.list('/tm/sys/tmm-info/stats'),
    ])
    .then((results) => {
        var cpuMetricValue = calc_tmm_cpu(results[0].entries);
        logger.debug('Metric Name: ' + cpuMetricName + ' Metric Value: ' + cpuMetricValue)

        client.trackMetric(cpuMetricName, cpuMetricValue);
    })
    .catch(err => {
        logger.info('Error: ', err);
    });
});


/**
 * Take in TMM CPU stat and calculate AVG (right now is simply the mean)
 *
 * @param {String} data - The JSON with individual TMM CPU stats entries
 *
*/
function calc_tmm_cpu(data) {
    var cpu_list = []
    for (r in data) {
        var stats = data[r].nestedStats.entries;
        cpu_list.push(stats.oneMinAvgUsageRatio.value);
        logger.silly('TMM: ' + stats.tmmId.description + ' oneMinAvgUsageRatio: ' + stats.oneMinAvgUsageRatio.value + '\n');
    }
    var sum = cpu_list.reduce((previous, current) => current += previous);
    var avg = sum / cpu_list.length;
    return parseInt(avg)
}
