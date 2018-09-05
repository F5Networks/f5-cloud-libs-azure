#!/usr/bin/env node

/**
 * This script/provider is designed to be used to grab specific metrics from the current
 * BIG-IP and then run some calculations on those metrics and send them to
 * Application Insights
 *
 * Requires the Application Insights SDK - Listed Below
 * https://github.com/Microsoft/ApplicationInsights-node.js
 *
 */

'use strict';

const options = require('commander');
const q = require('q');
const appInsights = require('applicationinsights');
const Logger = require('@f5devcentral/f5-cloud-libs').logger;
const BigIp = require('@f5devcentral/f5-cloud-libs').bigIp;

/**
 * Grab command line arguments
*/
options
    .version('1.0.0')

    .option('--key [type]', 'Application Insights Key', 'specify_key')
    .option('--log-level [type]', 'Specify the Log Level', 'info')
    .option('--mgmt-port [type]', 'Specify the BIG-IP mgmt port', '8443')
    .option('--log-file [type]', 'Specify the log file location', '/var/log/cloud/azure/metricsCollector.log')
    .parse(process.argv);

const loggerOptions = { logLevel: options.logLevel, fileName: options.logFile, console: true };
const logger = Logger.getLogger(loggerOptions);
this.logger = logger;
const bigip = new BigIp({ logger: this.logger });


/**
 * Gather Metrics and send to Application Insights
 */
appInsights.setup(options.key);
const client = appInsights.defaultClient;

const cpuMetricName = 'F5_TMM_CPU';
const trafficMetricName = 'F5_TMM_TRAFFIC';

bigip.init(
    'localhost',
    'svc_user',
    'file:///config/cloud/.passwd',
    {
        passwordIsUrl: true,
        port: options.mgmtPort,
        passwordEncrypted: true
    }
)
    .then(() => {
        logger.debug('Waiting for BIG-IP to be ready.');
        return bigip.ready();
    })
    .then(() => {
        return q.all([
            bigip.list('/tm/sys/tmm-info/stats'),
            bigip.list('/tm/sys/traffic/stats'),
        ]);
    })
    .then((results) => {
        const cpuMetricValue = calcTmmCpu(results[0].entries);
        const trafficMetricValue = calcTraffic(results[1].entries);
        /** Log name/value if debug is enabled */
        logger.debug(`Metric Name: ${cpuMetricName} Metric Value: ${cpuMetricValue}`);
        logger.debug(`Metric Name: ${trafficMetricName} Metric Value: ${trafficMetricValue}`);
        /** Send metrics to application insights */
        client.trackMetric({ name: cpuMetricName, value: cpuMetricValue });
        client.trackMetric({ name: trafficMetricName, value: trafficMetricValue });
    })
    .catch((err) => {
        const error = err.message ? err.message : err;
        logger.error(error);
    });


/**
 * Take in TMM CPU stat and calculate AVG (right now is simply the mean)
 *
 * @param {String} data - The JSON with individual TMM CPU stats entries
 *
*/
function calcTmmCpu(data) {
    const cpuList = [];
    let stats;
    let sum = 0;
    Object.keys(data).forEach((item) => {
        stats = data[item].nestedStats.entries;
        cpuList.push(stats.oneMinAvgUsageRatio.value);
        logger.silly(`TMM: ${stats.tmmId.description}`
            + ` oneMinAvgUsageRatio: ${stats.oneMinAvgUsageRatio.value}`);
    });

    cpuList.forEach((item) => {
        sum += item;
    });
    const avg = sum / cpuList.length;
    return parseInt(avg, 10);
}

/**
 * Take in traffic statistics and calculate total sum of client and server side
 * in bytes
 *
 * @param {String} data - The JSON with traffic stats entries
 *
*/
function calcTraffic(data) {
    /** Should only be one entry */
    let stats;
    let sumBits = 0;
    Object.keys(data).forEach((item) => {
        stats = data[item].nestedStats.entries;
    });
    const cSideBitsIn = stats['oneMinAvgClientSideTraffic.bitsIn'].value;
    const cSideBitsOut = stats['oneMinAvgClientSideTraffic.bitsOut'].value;
    const sSideBitsIn = stats['oneMinAvgServerSideTraffic.bitsIn'].value;
    const sSideBitsOut = stats['oneMinAvgServerSideTraffic.bitsOut'].value;

    logger.silly(`Client Side Bits: ${cSideBitsIn} ${cSideBitsOut}`);
    logger.silly(`Server Side Bits: ${sSideBitsIn} ${sSideBitsOut}`);

    const trafficBitsList = [cSideBitsIn, cSideBitsOut, sSideBitsIn, sSideBitsOut];
    trafficBitsList.forEach((item) => {
        sumBits += item;
    });
    const sumBytes = sumBits / 8;
    return parseInt(sumBytes, 10);
}
