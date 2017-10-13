#!/usr/bin/env node

var LogLevel = 'info';
var Logger = require('f5-cloud-libs').logger;
var logger = Logger.getLogger({logLevel: LogLevel, fileName: '/var/tmp/azureScaleSet.log'});

var util = require('f5-cloud-libs').util;
var fs = require('fs');

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

var loadBalancerName = credentialsFile.loadBalancerName;
var instanceId = credentialsFile.instanceId;
var inboundNatRuleBase = 'mgmtnatpool.';
var instancePort

var msRestAzure = require('ms-rest-azure');
var credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);

var networkManagementClient = require('azure-arm-network');
var networkClient = new networkManagementClient(credentials, subscriptionId);


var BigIp;
var bigip;
BigIp = require('f5-cloud-libs').bigIp;
bigip = new BigIp({logger: logger});

/** Log some base information
 * Instance ID, Load Balancer Name
*/
logger.info('Instance ID: ' + instanceId + ' Load Balancer Name: ' + loadBalancerName);

bigip.init(
    'localhost',
    'svc_user',
    'file:///config/cloud/.passwd',
    {
        passwordIsUrl: true,
        port: '8443'
    }
)
.then(function() {
    Promise.all([
        listDeploymentALB(resourceGroupName, loadBalancerName),
    ])
    .then((results) => {
        instancePort = getNatRulePort(results[0], instanceId, inboundNatRuleBase)
        logger.info('Port Selected: ' + instancePort);
    })
    .catch(err => {
        logger.info('Error: ', err);
    });
});


/**
 * List this deployments Azure Load balancer
 *
 * @param {String} resourceGroupName - Name of the resource group
 * @param {String} loadBalancerName - Name of the load balancer (should be this scale sets LB)
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function listDeploymentALB(resourceGroupName, loadBalancerName) {
    return new Promise(
    function (resolve, reject) {
        networkClient.loadBalancers.get(resourceGroupName, loadBalancerName,
        (error, data) => {
            if (error) {
                reject(error);
            }
            else {
                resolve(data);
            }
        });
    });
}

/**
 * Determine this instances front end port
 *
 * @param {String} loadBalancerConfig - This deployments load balancer config (JSON object)
 * @param {String} instanceId - This specific VM's instance ID within the scale set
 * @param {String} inboundNatRuleBase - Nat Rule prefix (text prior to the instance ID)
 * 
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function getNatRulePort(loadBalancerConfig, instanceId, inboundNatRuleBase) {
    var instanceInboundNatRule = inboundNatRuleBase + instanceId
    var rules = loadBalancerConfig.inboundNatRules
    var rule
    var instanceFrontendPort

    for (rule in rules) {
        if (rules[rule].name == instanceInboundNatRule) {
            instanceFrontendPort = rules[rule].frontendPort
        }
    }
    return instanceFrontendPort;
}


