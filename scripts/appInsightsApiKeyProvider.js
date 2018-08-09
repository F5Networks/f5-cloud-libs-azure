#!/usr/bin/env node

/**
 * This provider is designed to be used to manage certain application insights
 * objects, such as creation of an API key
 *
 * Requires the Application Insights management SDK - Listed Below
 * https://www.npmjs.com/package/azure-arm-appinsights
 *
 */

'use strict';

const options = require('commander');
const fs = require('fs');
const q = require('q');
const msRestAzure = require('ms-rest-azure');
const AppInsights = require('azure-arm-appinsights');
const Logger = require('@f5devcentral/f5-cloud-libs').logger;
const localCryptoUtil = require('@f5devcentral/f5-cloud-libs').localCryptoUtil;

/**
 * Grab command line arguments
*/
options
    .version('1.0.0')

    .option('--key-operation [type]', 'Application Insights Key', 'create')
    .option('--key-id [type]', 'Specify the API Key ID for deletion')
    .option('--log-level [type]', 'Specify the Log Level', 'info')
    .option('--config-file [type]', 'Specify the configuration file', '/config/cloud/.azCredentials')
    .option('--log-file [type]', 'Specify log file location', '/var/log/cloud/azure/appInsightsApiKey.log')
    .parse(process.argv);

const loggerOptions = { logLevel: options.logLevel, fileName: options.logFile, console: true };
const logger = Logger.getLogger(loggerOptions);

let configFile;
if (fs.existsSync(options.configFile)) {
    configFile = fs.readFileSync(options.configFile, 'utf8');
} else {
    logger.error('Credentials file not found');
    return;
}

let subscriptionId;
let resourceGroupName;
let appInsightsResourceName;
let appInsightsId;
let client;

localCryptoUtil.symmetricDecryptPassword(configFile)
    .then((data) => {
        configFile = JSON.parse(data);
        subscriptionId = configFile.subscriptionId;
        resourceGroupName = configFile.resourceGroupName;
        appInsightsResourceName = configFile.appInsightsName;
        appInsightsId = configFile.appInsightsId;
        const clientId = configFile.clientId;
        const tenantId = configFile.tenantId;
        const secret = configFile.secret;

        const credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);
        client = new AppInsights(credentials, subscriptionId);

        logger.info('App Insights ID:', appInsightsId);

        /**
         * Check if operation is create, delete or list and act accordingly
         */
        if (options.keyOperation === 'create') {
            q.all([
                createAppInsightApiKey(resourceGroupName, appInsightsResourceName)
            ])
                .then((results) => {
                    const response = results[0];
                    response.appInsightsId = appInsightsId;
                    logger.info('Response:', response);
                    logger.debug('API Key Name:', response.name);
                    logger.debug('API Key ID:', response.id.split('/apikeys/')[1]);
                    logger.debug('API Key:', response.apiKey);
                })
                .catch((err) => {
                    logger.error('Error:', err);
                });
        } else if (options.keyOperation === 'delete') {
            q.all([
                deleteAppInsightApiKey(resourceGroupName, appInsightsResourceName, options.keyId)
            ])
                .then((results) => {
                    logger.info('Delete Response:', results[0]);
                })
                .catch((err) => {
                    logger.error('Error:', err);
                });
        } else if (options.keyOperation === 'list') {
            q.all([
                listAppInsightInstances(),
                listAppInsightApiKeys(resourceGroupName, appInsightsResourceName)
            ])
                .then((results) => {
                    logger.info('List of App Insight components:', results[0]);
                    logger.info('List of API keys:', results[1]);
                })
                .catch((err) => {
                    logger.error('Error:', err);
                });
        }
    })
    .catch((err) => {
        logger.error('Error:', err);
    });

/**
* Create App Insights API Key
*
* @returns {Promise}
*/
function createAppInsightApiKey(rgName, resourceName) {
    const date = Date.now();
    const apiKeyProperties = {};
    apiKeyProperties.name = `apikeysdk${date}`;

    const basePropertiesUri = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`
        + `/providers/microsoft.insights/components/${appInsightsResourceName}`;
    apiKeyProperties.linkedReadProperties = [`${basePropertiesUri}/api`,
        `${basePropertiesUri}/draft`,
        `${basePropertiesUri}/extendqueries`,
        `${basePropertiesUri}/search`,
        `${basePropertiesUri}/aggregate`];

    const deferred = q.defer();
    client.aPIKeys.create(rgName, resourceName, apiKeyProperties, (err, data) => {
        if (err) {
            logger.error('An error ocurred', err);
            deferred.reject(err);
        } else {
            deferred.resolve(data);
        }
    });
    return deferred.promise;
}
/**
* Delete App Insights API Key
*
* @returns {Promise}
*/
function deleteAppInsightApiKey(rgName, resourceName, keyId) {
    const deferred = q.defer();
    if (keyId === null || keyId === undefined) {
        deferred.reject(new Error('keyId cannot be null or undefined when delete has been specified'));
    }

    client.aPIKeys.deleteMethod(rgName, resourceName, keyId, (err, data) => {
        if (err) {
            logger.error('An error ocurred', err);
            deferred.reject(err);
        } else {
            deferred.resolve(data);
        }
    });
    return deferred.promise;
}

/**
* List all App Insight Instances
*
* @returns {Promise}
*/
function listAppInsightInstances() {
    const deferred = q.defer();

    client.components.list((err, data) => {
        if (err) {
            logger.error('An error ocurred', err);
            deferred.reject(err);
        } else {
            deferred.resolve(data);
        }
    });
    return deferred.promise;
}

/**
* List App Insight API Keys
*
* @returns {Promise}
*/
function listAppInsightApiKeys(rgName, resourceName) {
    const deferred = q.defer();

    client.aPIKeys.list(rgName, resourceName, (err, data) => {
        if (err) {
            logger.error('An error ocurred', err);
            deferred.reject(err);
        } else {
            deferred.resolve(data);
        }
    });
    return deferred.promise;
}
