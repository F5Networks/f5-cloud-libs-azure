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
    logger.info('Credentials file not found');
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
var logger = Logger.getLogger({logLevel: options.logLevel, fileName: '/var/log/appInsightsApiKey.log'});

var credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);
var client = new appInsights(credentials, subscriptionId);

logger.info('App Insights ID: ' + appInsightsId);

if ( options.keyOperation == "create" ) {
    /**
     * Create App Insights API Key
     */
    var apiKeyProperties = {};
    var date = Date.now();
    apiKeyProperties.name = 'apikeysdk' + date;

    var basePropertiesUri = '/subscriptions/' + subscriptionId + '/resourceGroups/' + resourceGroupName + '/providers/microsoft.insights/components/' + appInsightsResourceName;
    apiKeyProperties.linkedReadProperties = [ basePropertiesUri + '/api',
    basePropertiesUri + '/draft',
    basePropertiesUri + '/extendqueries',
    basePropertiesUri + '/search',
    basePropertiesUri + '/aggregate'];

    client.aPIKeys.create(resourceGroupName, appInsightsResourceName, apiKeyProperties).then((resp) => {
        logger.debug('List Response:');
        logger.debug(resp);
        logger.info('API Key Name: ' + apiKeyProperties.name);
        logger.info('API Key ID: ' + resp.id.split('/apikeys/')[1]);
        logger.info('API Key: ' + resp.apiKey);
    }).catch((err) => {
    logger.info('An error ocurred');
    logger.info(err);
    });
}

if ( options.keyOperation == "delete" ) {
    /**
     * Delete App Insights API Key
     */
    if ( options.keyId === null || options.keyId === undefined ) {
        throw new Error('keyId cannot be null or undefined when delete has been specified');
    }
    client.aPIKeys.deleteMethod(resourceGroupName, appInsightsResourceName, options.keyId).then((resp) => {
        logger.info('Delete Response:');
        logger.info(resp);
    }).catch((err) => {
    logger.info('An error ocurred');
    logger.info(err);
    });
}

if ( options.logLevel == "debug" || options.logLevel == "silly" ) {
    /**
     * List App Insight API Keys
     */
    client.aPIKeys.list(resourceGroupName, appInsightsResourceName).then((keys) => {
        logger.debug('List of keys:');
        logger.debug(keys);
    }).catch((err) => {
        logger.info('An error ocurred');
        logger.info(err);
    });

    /**
     * List App Insight Instances
     */
    client.components.list().then((components) => {
        logger.debug('List of components:');
        logger.debug(components);
    }).catch((err) => {
    logger.info('An error ocurred');
    logger.info(err);
    });
}

