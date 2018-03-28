#!/usr/bin/env node

/**
 * This script/provider is designed to be used to get the assigned NAT port
 * on the ALB when required, such as for BIG-IQ licensing via public IP
 *
 */

'use strict';

const options = require('commander');
const fs = require('fs');
const q = require('q');
const msRestAzure = require('ms-rest-azure');
const NetworkManagementClient = require('azure-arm-network');
const Logger = require('@f5devcentral/f5-cloud-libs').logger;
const BigIp = require('@f5devcentral/f5-cloud-libs').bigIp;


/**
 * Grab command line arguments
*/
options
    .version('1.0.0')

    .option('--instance-id [type]', 'This Instance ID', '0')
    .option('--nat-base [type]', 'Specify the Nat Base', 'mgmtnatpool.')
    .option('--log-level [type]', 'Specify the Log Level', 'info')
    .parse(process.argv);

const logFile = '/var/log/cloud/azure/azureScaleSet.log';
const logger = Logger.getLogger({ logLevel: options.logLevel, fileName: logFile, console: true });

let credentialsFile;
if (fs.existsSync('/config/cloud/.azCredentials')) {
    credentialsFile = JSON.parse(fs.readFileSync('/config/cloud/.azCredentials', 'utf8'));
} else {
    logger.info('Credentials file not found');
    return;
}

const subscriptionId = credentialsFile.subscriptionId;
const clientId = credentialsFile.clientId;
const tenantId = credentialsFile.tenantId;
const secret = credentialsFile.secret;
const resourceGroupName = credentialsFile.resourceGroupName;

const loadBalancerName = credentialsFile.loadBalancerName;
const instanceId = options.instanceId;
const inboundNatRuleBase = options.natBase;
let instancePort;

const credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);
const networkClient = new NetworkManagementClient(credentials, subscriptionId);
this.logger = logger;
const bigip = new BigIp({ logger: this.logger });

/** Log some basic information
 * Instance ID, Load Balancer Name
*/
logger.info(`Instance ID: ${instanceId} Load Balancer Name: ${loadBalancerName}`);

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
    .then(() => {
        Promise.all([
            listDeploymentALB(resourceGroupName, loadBalancerName),
        ])
            .then((results) => {
                instancePort = getNatRulePort(results[0], instanceId, inboundNatRuleBase);
                logger.info(`Port Selected: ${instancePort}`);
            })
            .catch((err) => {
                logger.error(err);
            });
    });


/**
 * List this deployments Azure Load balancer
 *
 * @param {String} rgName - Name of the resource group
 * @param {String} lbName - Name of the load balancer (should be this scale sets LB)
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function listDeploymentALB(rgName, lbName) {
    const deferred = q.defer();

    networkClient.loadBalancers.get(rgName, lbName, (error, data) => {
        if (error) {
            deferred.reject(error);
        } else {
            deferred.resolve(data);
        }
    });
    return deferred.promise;
}

/**
 * Determine this instances front end port
 *
 * @param {String} loadBalancerConfig - This deployments load balancer config (JSON object)
 * @param {String} instId - This specific VM's instance ID within the scale set
 * @param {String} natRuleBase - Nat Rule prefix (text prior to the instance ID)
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function getNatRulePort(loadBalancerConfig, instId, natRuleBase) {
    const instanceNatRule = natRuleBase + instId;
    const rules = loadBalancerConfig.inboundNatRules;
    let instanceFrontendPort = 'none';

    Object.keys(rules).forEach((rule) => {
        if (rules[rule].name === instanceNatRule) {
            instanceFrontendPort = rules[rule].frontendPort;
        }
    });
    return instanceFrontendPort;
}
