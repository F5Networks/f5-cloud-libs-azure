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

/**
 * Grab command line arguments
*/
options
    .version('1.0.0')

    .option('--key-operation [type]', 'Application Insights Key', 'create')
    .option('--key-id [type]', 'Specify the API Key ID for deletion')
    .option('--log-level [type]', 'Specify the Log Level', 'info')
    .option('--log-file [type]', 'Specify log file location', '/var/log/cloud/azure/appInsightsApiKey.log')
    .parse(process.argv);

const loggerOptions = { logLevel: options.logLevel, fileName: options.logFile, console: true };
const logger = Logger.getLogger(loggerOptions);

let credentialsFile;
if (fs.existsSync('/config/cloud/.azCredentials')) {
    credentialsFile = JSON.parse(fs.readFileSync('/config/cloud/.azCredentials', 'utf8'));
} else {
    logger.error('Credentials file not found');
    return;
}

const subscriptionId = credentialsFile.subscriptionId;
const clientId = credentialsFile.clientId;
const tenantId = credentialsFile.tenantId;
const secret = credentialsFile.secret;
const resourceGroupName = credentialsFile.resourceGroupName;
const appInsightsResourceName = credentialsFile.appInsightsName;
const appInsightsId = credentialsFile.appInsightsId;


const credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);
const client = new AppInsights(credentials, subscriptionId);

logger.info('App Insights ID:', appInsightsId);

/**
 * Check if operation is create, delete or list and act accordingly
 */
if (options.keyOperation === 'create') {
    Promise.all([
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
    Promise.all([
        deleteAppInsightApiKey(resourceGroupName, appInsightsResourceName, options.keyId)
    ])
        .then((results) => {
            logger.info('Delete Response:', results[0]);
        })
        .catch((err) => {
            logger.error('Error:', err);
        });
}
if (options.keyOperation === 'list' || options.logLevel === 'debug' || options.logLevel === 'silly') {
    Promise.all([
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
    if (keyId === null || keyId === undefined) {
        throw new Error('keyId cannot be null or undefined when delete has been specified');
    }

    const deferred = q.defer();
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
