#!/usr/bin/env node

/**
 * This provider is designed to be used to manage certain application insights
 * objects, such as creation of an API key
 * 
 * Requires the Application Insights management SDK - Listed Below
 * https://www.npmjs.com/package/azure-arm-appinsights
 * 
 */

var options = require('commander');
var fs = require('fs');
var msRestAzure = require('ms-rest-azure');
var appInsights = require("azure-arm-appinsights");

if (fs.existsSync('/config/cloud/.azCredentials')) {
    var credentialsFile = JSON.parse(fs.readFileSync('/config/cloud/.azCredentials', 'utf8'));
}
else {
    logger.error('Credentials file not found');
    return;
}

var subscriptionId = credentialsFile.subscriptionId;
var clientId = credentialsFile.clientId;
var tenantId = credentialsFile.tenantId;
var secret = credentialsFile.secret;
var resourceGroupName = credentialsFile.resourceGroupName;
var appInsightsResourceName = credentialsFile.appInsightsName;
var appInsightsId = credentialsFile.appInsightsId;

 /**
 * Grab command line arguments
 */
options
    .version('1.0.0')

    .option('--key-operation [type]', 'Application Insights Key', 'create')
    .option('--key-id [type]', 'Specify the API Key ID for deletion')
    .option('--log-level [type]', 'Specify the Log Level', 'info')
    .parse(process.argv);

var Logger = require('f5-cloud-libs').logger;
var logger = Logger.getLogger({logLevel: options.logLevel, fileName: '/var/log/cloud/azure/appInsightsApiKey.log'});

var credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);
var client = new appInsights(credentials, subscriptionId);

logger.info('App Insights ID:', appInsightsId);

/**
 * Check if operation is create, delete or list and act accordingly
 */
if ( options.keyOperation == "create" ) {
    Promise.all([
        createAppInsightApiKey(resourceGroupName, appInsightsResourceName)
    ])
    .then((results) => {
        logger.debug('List Response:', results[0]);
        logger.info('API Key Name:', results[0].name);
        logger.info('API Key ID:', results[0].id.split('/apikeys/')[1]);
        logger.info('API Key:', results[0].apiKey);
    })
    .catch(err => {
        logger.error('Error:', err);
    });
} else if ( options.keyOperation == "delete" ) {
    Promise.all([
        deleteAppInsightApiKey(resourceGroupName, appInsightsResourceName, options.keyId)
    ])
    .then((results) => {
        logger.info('Delete Response:', results[0]);
    })
    .catch(err => {
        logger.error('Error:', err);
    });
}
if ( options.keyOperation == "list" || options.logLevel == "debug" || options.logLevel == "silly" ) {
    Promise.all([
        listAppInsightInstances(),
        listAppInsightApiKeys(resourceGroupName, appInsightsResourceName)
    ])
    .then((results) => {
        logger.info('List of App Insight components:', results[0]);
        logger.info('List of API keys:', results[1]);
    })
    .catch(err => {
        logger.error('Error:', err);
    });
}

/**
* Create App Insights API Key
*
* @returns {Promise}
*/
function createAppInsightApiKey(rgName, resourceName) {
    var date = Date.now();
    var apiKeyProperties = {};
    apiKeyProperties.name = 'apikeysdk' + date;

    var basePropertiesUri = '/subscriptions/' + subscriptionId + '/resourceGroups/' + resourceGroupName + '/providers/microsoft.insights/components/' + appInsightsResourceName;
    apiKeyProperties.linkedReadProperties = [ basePropertiesUri + '/api',
        basePropertiesUri + '/draft',
        basePropertiesUri + '/extendqueries',
        basePropertiesUri + '/search',
        basePropertiesUri + '/aggregate'];

    return new Promise(
    function (resolve, reject) {
        client.aPIKeys.create(rgName, resourceName, apiKeyProperties,
        (err, data) => {
            if (err) {
                logger.error('An error ocurred', err);
                reject(err);
            }
            else {
                resolve(data);
            }
        });
    });
}

/**
* Delete App Insights API Key
*
* @returns {Promise}
*/
function deleteAppInsightApiKey(rgName, resourceName, keyId) {
    if ( keyId === null || keyId === undefined ) {
        throw new Error('keyId cannot be null or undefined when delete has been specified');
    }

    return new Promise(
    function (resolve, reject) {
        client.aPIKeys.deleteMethod(rgName, resourceName, keyId,
        (err, data) => {
            if (err) {
                logger.error('An error ocurred', err);
                reject(err);
            }
            else {
                resolve(data);
            }
        });
    });
}

/**
* List all App Insight Instances
*
* @returns {Promise}
*/
function listAppInsightInstances() {
    return new Promise(
    function (resolve, reject) {
        client.components.list(
        (err, data) => {
            if (err) {
                logger.error('An error ocurred', err);
                reject(err);
            }
            else {
                resolve(data);
            }
        });
    });
}

/**
* List App Insight API Keys
*
* @returns {Promise}
*/
function listAppInsightApiKeys(rgName, resourceName) {
    return new Promise(
    function (resolve, reject) {
        client.aPIKeys.list(rgName, resourceName,
        (err, data) => {
            if (err) {
                logger.error('An error ocurred', err);
                reject(err);
            }
            else {
                resolve(data);
            }
        });
    });
}
