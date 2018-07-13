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
    .option('--log-file [type]', 'Specify the log file location', '/var/log/cloud/azure/scaleSet.log')
    .parse(process.argv);

const logger = Logger.getLogger({ logLevel: options.logLevel, fileName: options.logFile, console: true });

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
const vmssName = credentialsFile.vmssName;

const loadBalancerName = credentialsFile.loadBalancerName;
const instanceId = options.instanceId;
const inboundNatRuleBase = options.natBase;

const credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);
this.networkClient = new NetworkManagementClient(credentials, subscriptionId);
this.logger = logger;
const bigip = new BigIp({ logger: this.logger });

/** Log some basic information
 * Instance ID, Load Balancer Name
*/
logger.debug('Instance ID:', instanceId, 'Load Balancer Name:', loadBalancerName,
    'VMSS Name:', vmssName);

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
        const promises = [];
        if (loadBalancerName) {
            promises.push(listDeploymentALB(this.networkClient, resourceGroupName, loadBalancerName));
        } else {
            promises.push(q(''));
        }
        promises.push(getPublicIpFromScaleSet(this.networkClient, resourceGroupName, vmssName, instanceId));

        Promise.all(promises)
            .then((results) => {
                const instanceInfo = {};
                instanceInfo.port = getNatRulePort(results[0], instanceId, inboundNatRuleBase);
                instanceInfo.publicIp = results[1];

                logger.info('instanceInfo:', instanceInfo);
            })
            .catch((err) => {
                const error = err.message ? err.message : err;
                logger.error(error);
            });
    });


/**
 * Gets the public IP address of this VM from the VM Scale Set Resource
 *
 * @param {Object} networkClient - Azure network client
 * @param {String} resourceGroup - Name of the resource group
 * @param {Object} vName         - Name of the VMSS
 * @param {String} ir            - VMSS ID
 * @returns {List} A list of public IP addresses
*/
function getPublicIpFromScaleSet(networkClient, resourceGroup, vName, id) {
    const deferred = q.defer();
    const ipAddress = [];

    networkClient.publicIPAddresses.listVirtualMachineScaleSetPublicIPAddresses(resourceGroup,
        vName, (err, result) => {
            if (err) {
                deferred.reject(err);
                return;
            }

            result.forEach((pubIp) => {
                const pubIpId = pubIp.id.split('/');
                const vmssVmId = pubIpId[10];
                // If matches our ID, add to list
                if (id === vmssVmId) {
                    ipAddress.push(pubIp.ipAddress);
                }
            });
            if (ipAddress.length) {
                deferred.resolve(ipAddress[0]);
            }
            // just resolve ipAddress if we dont have any matches
            deferred.resolve(ipAddress);
        });

    return deferred.promise;
}

/**
 * List this deployments Azure Load balancer
 *
  *@param {String} networkClient - Azure network client
 * @param {String} rgName        - Name of the resource group
 * @param {String} lbName        - Name of the load balancer (should be this scale sets LB)
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function listDeploymentALB(networkClient, rgName, lbName) {
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
 * @param {String} instId             - This specific VM's instance ID within the scale set
 * @param {String} natRuleBase        - Nat Rule prefix (text prior to the instance ID)
 *
 * @returns {String} The front end port of the instancesId
*/
function getNatRulePort(loadBalancerConfig, instId, natRuleBase) {
    let instanceFrontendPort = 'none';
    if (loadBalancerConfig) {
        const instanceNatRule = natRuleBase + instId;
        const rules = loadBalancerConfig.inboundNatRules;

        Object.keys(rules).forEach((rule) => {
            if (rules[rule].name === instanceNatRule) {
                instanceFrontendPort = rules[rule].frontendPort;
            }
        });
    }
    return instanceFrontendPort;
}
