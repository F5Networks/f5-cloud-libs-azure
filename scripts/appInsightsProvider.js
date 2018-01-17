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

 /**
 * Grab command line arguments
 */
options
    .version('1.0.0')

    .option('--key [type]', 'Application Insights Key', 'specify_key')
    .option('--log-level [type]', 'Specify the Log Level', 'info')
    .parse(process.argv);


var Logger = require('f5-cloud-libs').logger;
var logger = Logger.getLogger({logLevel: options.logLevel, fileName: '/var/log/cloud/azure/azureMetricsCollector.log'});

var BigIp = require('f5-cloud-libs').bigIp;
var bigip = new BigIp({logger: logger});


/**
 * Gather Metrics and send to Application Insights
 */
if (options.logLevel == "debug" || options.logLevel == "silly") { appInsights.enableVerboseLogging(); }
appInsights.setup(options.key);
var client = appInsights.client;

var cpuMetricName = 'F5_TMM_CPU';
var trafficMetricName = 'F5_TMM_TRAFFIC';


bigip.init(
    'localhost',
    'svc_user',
    'file:///config/cloud/.passwd',
    {
        passwordIsUrl: true,
        port: '8443',
        passwordEncrypted: true
    }
)
.then(function() {
    logger.info("Waiting for BIG-IP to be ready.");
    return bigip.ready();
})
.then(function() {
    Promise.all([
        bigip.list('/tm/sys/tmm-info/stats'),
        bigip.list('/tm/sys/traffic/stats'),
    ])
    .then((results) => {
        var cpuMetricValue = calc_tmm_cpu(results[0].entries);
        logger.debug('Metric Name: ' + cpuMetricName + ' Metric Value: ' + cpuMetricValue)
        client.trackMetric(cpuMetricName, cpuMetricValue);

        var trafficMetricValue = calc_traffic(results[1].entries);
        logger.debug('Metric Name: ' + trafficMetricName + ' Metric Value: ' + trafficMetricValue)
        client.trackMetric(trafficMetricName, trafficMetricValue);
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

/**
 * Take in traffic statistics and calculate total sum of client and server side
 * in bytes
 *
 * @param {String} data - The JSON with traffic stats entries
 *
*/
function calc_traffic(data) {
    /** Should only be one entry */
    for (r in data) {
        var stats = data[r].nestedStats.entries;
    }
    c_side_bits_in = stats["oneMinAvgClientSideTraffic.bitsIn"].value;
    c_side_bits_out = stats["oneMinAvgClientSideTraffic.bitsOut"].value;
    s_side_bits_in = stats["oneMinAvgServerSideTraffic.bitsIn"].value;
    s_side_bits_out = stats["oneMinAvgServerSideTraffic.bitsOut"].value;

    logger.silly('Client Side Bits: ' + c_side_bits_in + ' ' + c_side_bits_out);
    logger.silly('Server Side Bits: ' + s_side_bits_in + ' ' + s_side_bits_out);

    var traffic_bits_list = [c_side_bits_in, c_side_bits_out, s_side_bits_in, s_side_bits_out];
    var sum_bytes = traffic_bits_list.reduce((previous, current) => current += previous) / 8;
    return parseInt(sum_bytes)
}
