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
const f5CloudLibs = require('@f5devcentral/f5-cloud-libs');
const localCryptoUtil = require('@f5devcentral/f5-cloud-libs').localCryptoUtil;

const Logger = f5CloudLibs.logger;
const BigIp = f5CloudLibs.bigIp;

/**
 * Grab command line arguments
*/
options
    .version('1.0.0')

    .option('--instance-id [type]', 'This Instance ID', '0')
    .option('--nat-base [type]', 'Specify the Nat Base', 'mgmtnatpool.')
    .option('--log-level [type]', 'Specify the Log Level', 'info')
    .option('--config-file [type]', 'Specify the configuration file', '/config/cloud/.azCredentials')
    .option('--log-file [type]', 'Specify the log file location', '/var/log/cloud/azure/scaleSet.log')
    .parse(process.argv);

const logger = Logger.getLogger({ logLevel: options.logLevel, fileName: options.logFile, console: true });
const bigip = new BigIp({ logger });

let configFile;
if (fs.existsSync(options.configFile)) {
    configFile = fs.readFileSync(options.configFile, 'utf8');
} else {
    logger.info('Credentials file not found');
    return;
}

let resourceGroupName;
let vmssName;
let loadBalancerName;
let instanceId;
let inboundNatRuleBase;

q.all(
    localCryptoUtil.symmetricDecryptPassword(configFile),
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
)
    .then((results) => {
        configFile = JSON.parse(results[0]);

        resourceGroupName = configFile.resourceGroupName;
        vmssName = configFile.vmssName;
        loadBalancerName = configFile.loadBalancerName;
        instanceId = options.instanceId;
        inboundNatRuleBase = options.natBase;

        const credentials = new msRestAzure.ApplicationTokenCredentials(
            configFile.clientId, configFile.tenantId, configFile.secret
        );
        this.networkClient = new NetworkManagementClient(credentials, configFile.subscriptionId);

        /** Log some basic information such as: Instance ID, Load Balancer Name, VMSS Name */
        logger.debug('Instance ID:', instanceId, 'Load Balancer Name:', loadBalancerName,
            'VMSS Name:', vmssName);

        const promises = [];
        promises.push(getPublicIpFromScaleSet(this.networkClient, resourceGroupName, vmssName, instanceId));
        if (loadBalancerName) {
            promises.push(listDeploymentALB(this.networkClient, resourceGroupName, loadBalancerName));
        } else {
            promises.push(q(''));
        }

        return q.all(promises);
    })
    .then((results) => {
        const instanceInfo = {};
        instanceInfo.publicIp = results[0];
        instanceInfo.port = getNatRulePort(results[1], instanceId, inboundNatRuleBase);

        logger.info('instanceInfo:', instanceInfo);
    })
    .catch((err) => {
        const error = err.message ? err.message : err;
        logger.error(error);
    });


/**
 * Gets the public IP address of this VM from the VM Scale Set Resource
 *
 * @param {Object} networkClient - Azure network client
 * @param {String} resourceGroup - Name of the resource group
 * @param {String} vName         - Name of the VMSS
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
