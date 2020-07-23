/**
 * Copyright 2016-2018 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const assert = require('assert');
const util = require('util');
const path = require('path');
const q = require('q');
const msRestAzure = require('ms-rest-azure');
const azureEnvironment = require('ms-rest-azure/lib/azureEnvironment');
const NetworkManagementClient = require('azure-arm-network');
const ComputeManagementClient = require('azure-arm-compute');
const azureStorage = require('azure-storage');

const AbstractCloudProvider = require('@f5devcentral/f5-cloud-libs').cloudProvider;
const BigIp = require('@f5devcentral/f5-cloud-libs').bigIp;
const AutoscaleInstance = require('@f5devcentral/f5-cloud-libs').autoscaleInstance;
const Logger = require('@f5devcentral/f5-cloud-libs').logger;
const cloudUtil = require('@f5devcentral/f5-cloud-libs').util;
const localCryptoUtil = require('@f5devcentral/f5-cloud-libs').localCryptoUtil;

const REG_EXPS = require('@f5devcentral/f5-cloud-libs').sharedConstants.REG_EXPS;

let logger;

const BACKUP_CONTAINER = 'backup';
const INSTANCES_CONTAINER = 'instances';

const specialLocations = {
    // Azure US Government cloud regions: US DoD Central, US DoD East, US Gov Arizona,
    // US Gov Iowa, US Gov Non-Regional, US Gov Texas, US Gov Virginia, US Sec East1, US Sec West
    AzureUSGovernment: ['usgov', 'usdod', 'ussec'],
    // Azure China cloud regions: China East, China North
    AzureChina: ['china'],
    // Azure Germany cloud regions: Germany Central, Germany Non-Regional, Germany Northeast
    // Note: There is Azure commercial cloud regions in germany so have to be specific
    AzureGermanCloud: ['germanycentral', 'germanynortheast', 'germanynonregional']
};

util.inherits(AzureCloudProvider, AbstractCloudProvider);

/**
 * Constructor.
 * @class
 * @classdesc
 * Azure cloud provider implementation.
 *
 * @param {Ojbect} [options]               - Options for the instance.
 * @param {Object} [options.clOptions]     - Command line options if called from a script.
 * @param {Object} [options.logger]        - Logger to use. Or, pass loggerOptions to get your own logger.
 * @param {Object} [options.loggerOptions] - Options for the logger.
 *                                           See {@link module:logger.getLogger} for details.
 */
function AzureCloudProvider(options) {
    AzureCloudProvider.super_.call(this, options);

    this.features[AbstractCloudProvider.FEATURE_SHARED_PASSWORD] = true;
    this.instancesToRevoke = [];

    const loggerOptions = options ? options.loggerOptions : undefined;

    logger = options ? options.logger : undefined;

    if (logger) {
        this.logger = logger;
        cloudUtil.setLogger(logger);
    } else if (loggerOptions) {
        loggerOptions.module = module;
        logger = Logger.getLogger(loggerOptions);
        cloudUtil.setLoggerOptions(loggerOptions);
        this.logger = logger;
    } else {
        // use super's logger
        logger = this.logger;
        cloudUtil.setLogger(logger);
    }
}

/**
 * Initialize class
 *
 * @param {Object}  providerOptions                            - Provider specific options.
 * @param {String}  [providerOptions.azCredentialsUrl]         - URL to file or location with credentials.
 *     Must specify azCredentialsUrl or provide the credentials directly in the providerOptions.
 *     File/location should contain JSON object with the following:
 *         {
 *             clientId:        Azure client ID
 *             tenantId:        Azure tenant ID
 *             secret:          Azure secret.
 *             subscriptionId:  Azure subscription ID
 *             storageAccount:  Azure storage account
 *             storageKey:      Azure storage account key
 *         }
 * @param {Boolean} [providerOptions.azCredentialsEncrypted]  - Indicates that the credentials are encrypted
 * @param {String}  [providerOptions.environment]             - Azure environment name.
 *      Required if environment should not be determined by instance metadata.
 *      Example: AzureUSGovernment
 * @param {String}  providerOptions.resourceGroup             - Resource group name.
 * @param {String}  providerOptions.scaleSet                  - Scale set name.
 * @param {Object}  [options]                                 - Options for this instance.
 * @param {Boolean} [options.autoscale]                       - Whether or not this instance will
 *                                                            be used for autoscaling.
 *
 * @returns {Promise} A promise which will be resolved when init is complete.
 */
AzureCloudProvider.prototype.init = function init(providerOptions) {
    const deferred = q.defer();
    this.providerOptions = {};
    Object.assign(this.providerOptions, providerOptions);

    let credentialsPromise;
    let credentialsJson;
    let environment;

    this.logger.silly('providerOptions:', this.providerOptions);

    this.scaleSet = this.providerOptions.scaleSet;
    this.resourceGroup = this.providerOptions.resourceGroup;

    if (this.providerOptions.azCredentialsUrl) {
        credentialsPromise = cloudUtil.getDataFromUrl(this.providerOptions.azCredentialsUrl);
    } else {
        credentialsPromise = q();
    }

    credentialsPromise
        .then((data) => {
            if (this.providerOptions.azCredentialsUrl && this.providerOptions.azCredentialsEncrypted) {
                // assume symmetric encryption
                return localCryptoUtil.symmetricDecryptPassword(data);
            }
            return q(data);
        })
        .then((data) => {
            if (this.providerOptions.azCredentialsUrl) {
                credentialsJson = JSON.parse(data);
            } else {
                credentialsJson = this.providerOptions;
            }

            if (this.providerOptions.environment) {
                return q(this.providerOptions.environment);
            }
            return getInstanceEnvironment();
        })
        .then((response) => {
            environment = azureEnvironment[response];
            if (!environment) {
                return q.reject(new Error(`Provided Azure environment does not exist: ${response}`));
            }
            this.logger.debug(`Using Azure environment: ${environment.name}`);

            const tryLogin = function () {
                const loginDeferred = q.defer();

                msRestAzure.loginWithServicePrincipalSecret(
                    credentialsJson.clientId,
                    credentialsJson.secret,
                    credentialsJson.tenantId,
                    {
                        environment
                    },
                    (err, credentials) => {
                        if (err) {
                            loginDeferred.reject(err);
                        } else {
                            loginDeferred.resolve(credentials);
                        }
                    }
                );

                return loginDeferred.promise;
            };
            if (!credentialsJson.clientId || !credentialsJson.secret || !credentialsJson.tenantId) {
                this.logger.debug('Missing clientId, secret or tenantId. Not logging in to Azure.');
                return q();
            }
            return cloudUtil.tryUntil(this, cloudUtil.MEDIUM_RETRY, tryLogin);
        })
        .then((credentials) => {
            if (credentials && credentialsJson.subscriptionId) {
                this.networkClient = new NetworkManagementClient(
                    credentials,
                    credentialsJson.subscriptionId,
                    environment.resourceManagerEndpointUrl
                );
                this.computeClient = new ComputeManagementClient(
                    credentials,
                    credentialsJson.subscriptionId,
                    environment.resourceManagerEndpointUrl
                );
            } else {
                this.logger.debug('Azure credentials not provided. Not initializing Azure clients');
            }
            if (credentialsJson.storageAccount && credentialsJson.storageKey) {
                this.storageClient = azureStorage.createBlobService(
                    credentialsJson.storageAccount,
                    credentialsJson.storageKey
                );
                return createContainers(this.storageClient, [BACKUP_CONTAINER, INSTANCES_CONTAINER]);
            }
            return q();
        })
        .then(() => {
            deferred.resolve();
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
};

/**
 * BIG-IP is now ready and providers can run BIG-IP functions
 * if necessary
 *
 * @returns {Promise} A promise which will be resolved when init is complete.
 */
AzureCloudProvider.prototype.bigIpReady = function bigIpReady() {
    this.bigIp = new BigIp({ loggerOptions: this.loggerOptions });
    this.bigIp.init(
        'localhost',
        this.clOptions.user,
        this.clOptions.password || this.clOptions.passwordUrl,
        {
            port: this.clOptions.port,
            passwordIsUrl: typeof this.clOptions.passwordUrl !== 'undefined',
            passwordEncrypted: this.clOptions.passwordEncrypted
        }
    )
        .then(() => {
            if (this.instancesToRevoke.length > 0) {
                logger.debug(
                    'Revoking licenses of non-primaries that are not known to Azure',
                    this.instancesToRevoke
                );
                return this.revokeLicenses(this.instancesToRevoke, { bigIp: this.bigIp });
            }
            return q();
        });
};

/**
 * Gets the instance ID of this instance
 *
 * @returns {Promise} A promise which will be resolved with the instance ID of this instance
 *                    or rejected if an error occurs;
 */
AzureCloudProvider.prototype.getInstanceId = function getInstanceId() {
    const deferred = q.defer();
    let instanceName;

    if (!this.instanceId) {
        // Get our instance name from metadata
        getInstanceMetadata()
            .then((metaData) => {
                let message;
                this.logger.silly(metaData);

                if (metaData && metaData.compute) {
                    if (this.clOptions.static) {
                        // Non-autoscaled instances do not have an instance ID. Use vm ID instead.
                        return metaData.compute.vmId;
                    }

                    if (metaData.compute.name) {
                        instanceName = metaData.compute.name;
                        return getInstanceIdFromScaleSet(
                            this.computeClient,
                            this.resourceGroup,
                            this.scaleSet,
                            instanceName
                        );
                    }

                    message = 'compute.name not found in metadata';
                    logger.warn(message);
                    deferred.reject(new Error(message));
                } else {
                    message = 'compute not found in metadata';
                    logger.warn(message);
                    deferred.reject(new Error(message));
                }
                return q();
            })
            .then((instanceId) => {
                deferred.resolve(instanceId);
            })
            .catch((err) => {
                deferred.reject(err);
            });
    } else {
        deferred.resolve(this.instanceId);
    }

    return deferred.promise;
};

/**
 * Gets info for each instance
 *
 * Info is retrieval is cloud specific. Likely either from the cloud infrastructure
 * itself, stored info that we have in a database, or both.
 *
 * @param {Object} [options]             - Optional parameters
 * @param {String} [options.externalTag] - Also look for instances with this
 *                                         tag (outside of the autoscale group/set)
 *
 * @returns {Promise} A promise which will be resolved with a dictionary of instances
 *                    keyed by instance ID. Each instance value should be:
 *                    {
 *                        isPrimary: <Boolean>,
 *                        hostname: <String>,
 *                        mgmtIp: <String>,
 *                        privateIp: <String>
 *                        publicIp: <String>,
 *                        providerVisible: <Boolean> (does the cloud provider know about this instance),
 *                        external: <Boolean> (true if this instance is external to the autoscale group/set)
 *                    }
 */
AzureCloudProvider.prototype.getInstances = function getInstances(options) {
    const deferred = q.defer();
    const instances = {};
    const bigIps = [];
    const azureInstanceIds = [];
    const initPromises = [];
    const hostnamePromises = [];

    const publicIpPromises = [];
    const idsToDelete = [];
    const currInstanceId = options ? options.instanceId : undefined;
    const externalTag = options ? options.externalTag : undefined;

    let vms;
    let bigIp;

    getScaleSetVms(this.computeClient, this.resourceGroup, this.scaleSet, { expand: 'instanceView' })
        .then((results) => {
            vms = results;
            return getScaleSetNetworkInterfaces(this.networkClient, this.resourceGroup, this.scaleSet);
        })
        .then((results) => {
            const nics = results;

            let instanceId;
            let ipConfig;
            let privateIp;

            Object.keys(nics).forEach((nic) => {
                if (nics[nic].virtualMachine) {
                    instanceId = getInstanceIdFromVms(vms, nics[nic].virtualMachine.id);
                    azureInstanceIds.push(instanceId);
                    ipConfig = nics[nic].ipConfigurations[0];
                    privateIp = ipConfig.privateIPAddress;

                    const autoscaleInstance = new AutoscaleInstance()
                        .setPrivateIp(privateIp)
                        .setMgmtIp(privateIp);
                    instances[instanceId] = autoscaleInstance;

                    const pubIp = ipConfig.publicIPAddress;
                    if (pubIp) {
                        // Check if public IP address is within a VMSS
                        if (pubIp.id.toLowerCase()
                            .indexOf('/microsoft.compute/virtualmachinescalesets') !== -1) {
                            publicIpPromises.push(getPublicIpFromScaleSet(
                                this.networkClient,
                                this.resourceGroup,
                                pubIp,
                                instanceId
                            ));
                        } else {
                            publicIpPromises.push(getPublicIp(
                                this.networkClient,
                                this.resourceGroup,
                                pubIp,
                                instanceId
                            ));
                        }
                    }

                    // Account for power state possibly being deallocated,
                    // set providerVisible to false if so
                    if (
                        vms[instanceId].provisioningState === 'Succeeded' ||
                        vms[instanceId].provisioningState === 'Creating'
                    ) {
                        instances[instanceId].providerVisible = true;
                    } else {
                        instances[instanceId].providerVisible = false;
                    }
                }
            });
            try {
                logger.silly(JSON.stringify(vms));
                Object.keys(vms).forEach((vmId) => {
                    vms[vmId].instanceView.statuses.forEach((status) => {
                        const statusCode = status.code.toLowerCase();
                        logger.silly('Instance power code status:',
                            vms[vmId].instanceId, statusCode);
                        if (statusCode === 'powerstate/deallocated' ||
                            statusCode === 'powerstate/deallocating') {
                            instances[vms[vmId].instanceId].providerVisible = false;
                        }
                    });
                });
            } catch (err) {
                // just log error, but carry on. we don't want to fail on
                // just reading the power state
                logger.info('Error reading power state', err);
            }

            return q.all(publicIpPromises);
        })
        .then((publicIps) => {
            publicIps.forEach((publicIp) => {
                instances[publicIp.id].publicIp = publicIp.ip;
            });

            if (externalTag) {
                return this.getVmsByTag(externalTag, { labelByVmId: true });
            }
            return q();
        })
        .then((externalVms) => {
            if (externalVms) {
                externalVms.forEach((externalVm) => {
                    // if we already go this one above, remove that and use
                    // this one as it is using vmId, which is what we want for external
                    // instances
                    const currentKeys = Object.keys(instances);
                    for (let i = 0; i < currentKeys.length; i++) {
                        if (instances[currentKeys[i]].privateIp === externalVm.ip.privateIp) {
                            delete instances[currentKeys[i]];
                        }
                    }

                    instances[externalVm.id] = {
                        mgmtIp: externalVm.ip.private,
                        privateIp: externalVm.ip.private,
                        external: true,
                        providerVisible: true
                    };
                    azureInstanceIds.push(externalVm.id);
                });
            }

            return getInstancesFromDb(this.storageClient);
        })
        .then((registeredInstances) => {
            logger.silly('getInstancesFromDb result:', registeredInstances);

            // Only report instances that are primary and/or that Azure also knows about
            const registeredInstanceIds = Object.keys(registeredInstances);
            let providerVisible;
            let instanceId;
            let instance;

            let isPrimary = false;
            if (registeredInstanceIds.length > 0) {
                isPrimary = registeredInstanceIds.filter((id) => {
                    return currInstanceId === id && registeredInstances[currInstanceId].isPrimary;
                }).length === 1;
            }
            logger.silly(`isPrimary: ${isPrimary}`);

            const isValidInstance = function (instanceIdToCheck, instanceToCheck) {
                return (
                    azureInstanceIds.indexOf(instanceIdToCheck) !== -1 ||
                    (instanceToCheck.isPrimary && !this.isInstanceExpired(instanceToCheck))
                );
            };

            for (let i = 0; i < registeredInstanceIds.length; ++i) {
                instanceId = registeredInstanceIds[i];
                instance = registeredInstances[instanceId];

                if (isValidInstance.call(this, instanceId, instance)) {
                    if (!instances[instanceId]) {
                        providerVisible = false;
                    } else {
                        // We have an updated providerVisible status from above,
                        // so use it
                        providerVisible = instances[instanceId].providerVisible;
                    }
                    instances[instanceId] = instance;
                    instances[instanceId].providerVisible = providerVisible;
                } else if (isPrimary) {
                    // Get a list of non-primary instances that we have in our db that Azure
                    // does not know about and delete them
                    idsToDelete.push(instanceId);

                    // if we're using BIG-IQ for licensing, revoke the licenses
                    // of the deleted BIG-IPs
                    if (this.clOptions.licensePool) {
                        this.instancesToRevoke.push(instance);
                    } else {
                        this.logger.silly('No license pool. Not revoking any licenses.');
                    }
                }
            }

            // get the password for these instances
            return (this.clOptions.password ?
                q(this.clOptions.password) : cloudUtil.getDataFromUrl(this.clOptions.passwordUrl));
        })
        .then((data) => {
            const bigIpPassword = data;

            // If we don't already have the hostname for this instance, get it
            Object.keys(instances).forEach((instanceId) => {
                if (!instances[instanceId].hostname) {
                    logger.silly('No hostname for instance', instanceId);
                    bigIp = new BigIp({ loggerOptions: this.loggerOptions });
                    bigIp.azureInstanceId = instanceId;
                    bigIps.push(bigIp);
                    initPromises.push(bigIp.init(
                        instances[instanceId].privateIp,
                        this.clOptions.user,
                        bigIpPassword,
                        {
                            port: this.clOptions.port,
                            passwordEncrypted: this.clOptions.passwordEncrypted
                        }
                    ));
                }
            });

            return q.all(initPromises);
        })
        .then(() => {
            const hostnameDeferred = q.defer();

            for (let i = 0; i < bigIps.length; ++i) {
                hostnamePromises.push(bigIps[i].list('/tm/sys/global-settings', null, cloudUtil.SHORT_RETRY));
            }

            // Don't fall into catch at the end of this routine. Just
            // don't fill in the hostnames if we can't get them in a reasonable
            // amount of time.
            q.all(hostnamePromises)
                .then((responses) => {
                    hostnameDeferred.resolve(responses);
                })
                .catch(() => {
                    hostnameDeferred.resolve([]);
                });

            return hostnameDeferred.promise;
        })
        .then((responses) => {
            for (let i = 0; i < responses.length; ++i) {
                instances[bigIps[i].azureInstanceId].hostname = responses[i].hostname;
            }

            logger.debug('Deleting non-primaries that are not known to Azure', idsToDelete);
            return deleteInstancesFromDb(this.storageClient, idsToDelete, { noWait: true });
        })
        .then(() => {
            dedupeInstances(instances);
            deferred.resolve(instances);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
};

/**
 * Searches for NICs that have a given tag.
 *
 * @param {Object} tag - Tag to search for. Tag is of the format:
 *
 *                 {
 *                     key: optional key
 *                     value: value to search for
 *                 }
 *
 * @returns {Promise} A promise which will be resolved with an array of instances.
 *                    Each instance value should be:
 *
 *                   {
 *                       id: NIC ID,
 *                       ip: {
 *                           public: public IP (or first public IP on the NIC),
 *                           private: private IP (or first private IP on the NIC)
 *                       }
 *                   }
 */
AzureCloudProvider.prototype.getNicsByTag = function getNicsByTag(tag) {
    const deferred = q.defer();
    const promises = [];
    const nics = [];

    if (!tag || !tag.key || !tag.value) {
        deferred.reject(new Error('Tag with key and value must be provided'));
        return deferred.promise;
    }

    promises.push(getNetworkInterfaces(this.networkClient, this.resourceGroup, tag));
    promises.push(getVmScaleSetNetworkInterfaces(
        this.computeClient,
        this.networkClient,
        this.resourceGroup,
        tag
    ));

    q.all(promises)
        .then((results) => {
            results.forEach((result) => {
                result.forEach((nic) => {
                    nics.push(nic);
                });
            });
            deferred.resolve(nics);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
};

/**
 * Searches for VMs that have a given tag.
 *
 * @param {Object}  tag                 - Tag to search for. Tag is of the format:
 *
 *                                        {
 *                                            key: optional key
 *                                            value: value to search for
 *                                        }
 * @param {Object}  [options]             - Optional parameters
 * @param {Boolean} [options.labelByVmId] - Use the VM id to tag the vm. Default is to
 *                                          tag by instance ID for autoscaled instances
 *                                          and nic ID for static instances
 *
 * @returns {Promise} A promise which will be resolved with an array of instances.
 *                    Each instance value should be:
 *
 *                   {
 *                       id: instance ID,
 *                       ip: {
 *                           public: public IP (or first public IP on the first NIC),
 *                           private: private IP (or first private IP on the first NIC)
 *                       }
 *                   }
 */
AzureCloudProvider.prototype.getVmsByTag = function getVmsByTag(tag, options) {
    const deferred = q.defer();
    const promises = [];
    const vms = [];

    const labelByVmId = options ? options.labelByVmId : undefined;

    if (!tag || !tag.key || !tag.value) {
        deferred.reject(new Error('Tag with key and value must be provided'));
        return deferred.promise;
    }

    logger.debug('Getting vms with tag', tag);

    promises.push(getVms(
        this.computeClient,
        this.networkClient,
        this.resourceGroup,
        tag,
        { labelByVmId }
    ));
    promises.push(getVmScaleSetNetworkInterfaces(
        this.computeClient,
        this.networkClient,
        this.resourceGroup,
        tag,
        { labelByVmId }
    ));

    q.all(promises)
        .then((results) => {
            results.forEach((result) => {
                result.forEach((vm) => {
                    vms.push(vm);
                });
            });
            deferred.resolve(vms);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
};

/**
 * Gets nodes by a resourceId. The resourceId is a string and its meaning is
 * provider specific. The meaning is interpreted by the provider by setting a resourceType,
 * which is also provider specific. All implementing providers will support a type of 'tag'.
 * If resourceType is 'tag', then the format of resourceId is '<tagKey>=<tagValue>'
 *
 * @param {String} resourceId             - The ID of the resource
 *                                            - For resourceType of 'tag', resourceId is '<tagKey>=<tagValue>'
 * @param {Object} resourceType           - The type of resource. All implementing providers must support
 *                                          'tag' but may add others as well. For Azure, the following types
 *                                          are supported:
 *                                              - tag
 *                                              - scaleSet
 *
 * @returns {Promise} A promise which will be resolved with an array of instances.
 *                    Each instance value should be:
 *
 *     {
 *         id: Node ID,
 *         ip: {
 *             public: public IP,
 *             private: private IP
 *         }
 *     }
 */
AzureCloudProvider.prototype.getNodesByResourceId = function getNodesByResourceId(resourceId, resourceType) {
    if (resourceType === 'scaleSet') {
        return getScaleSetNetworkPrimaryInterfaces(
            this.computeClient,
            this.networkClient,
            this.resourceGroup,
            resourceId
        );
    }

    return q.reject(new Error("Only resource types 'tag' and 'scaleSet' are supported"));
};

/**
 * Elects a new primary instance from the available instances
 *
 * @abstract
 *
 * @param {Object} instances - Dictionary of instances as returned by getInstances
 *
 * @returns {Promise} A promise which will be resolved with the instance ID of the
 *                    elected primary.
 */
AzureCloudProvider.prototype.electPrimary = function electPrimary(instances) {
    const instanceIds = Object.keys(instances);
    let lowestInstanceId = Number.MAX_SAFE_INTEGER;
    let lowestExternalpToNumber = Number.MAX_SAFE_INTEGER;

    let primaryFound = false;
    let externalInstanceId;
    const instancesWithRunningConfig = [];

    if (instanceIds.length === 0) {
        return q.reject(new Error('No instances'));
    }

    instanceIds.forEach((instanceId) => {
        const instance = instances[instanceId];
        let currentIpToNumber;
        if (instance.versionOk && instance.providerVisible) {
            if (instanceId < lowestInstanceId) {
                lowestInstanceId = instanceId;
                primaryFound = true;
            }
            if (instance.external) {
                currentIpToNumber = cloudUtil.ipToNumber(instance.privateIp);
                if (currentIpToNumber < lowestExternalpToNumber) {
                    lowestExternalpToNumber = currentIpToNumber;
                    externalInstanceId = instanceId;
                    primaryFound = true;
                }
            }
            if (instance.lastBackup !== new Date(1970, 1, 1).getTime()) {
                instancesWithRunningConfig.push({
                    id: instanceId,
                    mgmtIp: currentIpToNumber
                });
            }
        }
    });
    if (externalInstanceId) {
        lowestInstanceId = externalInstanceId;
    }
    // prefer running config over UCS restore
    // checking if availabe lowestIp has running conf
    logger.silly('electPrimary: checking if lowest ip has running config');
    const isLowestInstanceWithRunningConfig = instancesWithRunningConfig.some((instanceWithRunConf) => {
        return lowestInstanceId === instanceWithRunConf.id;
    });
    // if not return the lowest with config
    if (!isLowestInstanceWithRunningConfig && instancesWithRunningConfig.length > 0) {
        logger.silly('electPrimary: elected primary does not have running config');
        logger.silly('electPrimary: taking lowest with running config');
        instancesWithRunningConfig.sort((instance01, instance02) => {
            return instance01.mgmtIp - instance02.mgmtIp;
        });
        logger.silly(`electPrimary: instance after sort: ${instancesWithRunningConfig}`);
        lowestInstanceId = instancesWithRunningConfig[0].id;
    }

    if (primaryFound) {
        return q(lowestInstanceId);
    }
    return q.reject(new Error('No possible primary found'));
};

/**
 * Called to retrieve primary instance credentials
 *
 * When joining a cluster we need the username and password for the
 * primary instance.
 *
 * Management IP and port are passed in so that credentials can be
 * validated desired.
 *
 * @param {String} mgmtIp - Management IP of primary
 * @param {String} port - Managemtn port of primary
 *
 * @returns {Promise} A promise which will be resolved with:
 *                    {
 *                        username: <admin_user>,
 *                        password: <admin_password>
 *                    }
 */
AzureCloudProvider.prototype.getPrimaryCredentials = function getPrimaryCredentials() {
    return q({
        username: this.bigIp.user,
        password: this.bigIp.password
    });
};

/**
 * Determines if a given instanceId is a valid primary
 *
 * @param {String} instanceId - Instance ID to validate as a valid primary.
 * @param {Object} instances - Dictionary of instances as returned by getInstances.
 *
 * @returns {Promise} A promise which will be resolved with a boolean indicating
 *                    wether or not the given instanceId is a valid primary.
 */
AzureCloudProvider.prototype.isValidPrimary = function isValidPrimary(instanceId, instances) {
    const possiblePrimary = instances[instanceId];
    let bigIp;

    logger.silly('isValidPrimary', instanceId, instances);

    // get the password for this scale set
    const passwordPromise = this.clOptions.password ?
        q(this.clOptions.password) : cloudUtil.getDataFromUrl(this.clOptions.passwordUrl);

    return passwordPromise
        .then((bigIpPassword) => {
            // Compare instance's hostname to our hostname
            bigIp = new BigIp({ loggerOptions: this.loggerOptions });
            return bigIp.init(
                possiblePrimary.privateIp,
                this.clOptions.user,
                bigIpPassword,
                {
                    port: this.clOptions.port,
                    passwordEncrypted: this.clOptions.passwordEncrypted
                }
            );
        })
        .then(() => {
            return bigIp.list('/tm/sys/global-settings', null, cloudUtil.SHORT_RETRY);
        })
        .then((response) => {
            const actualHostname = response.hostname;
            let isValid = true;
            logger.silly(
                'possiblePrimary.hostname:',
                possiblePrimary.hostname,
                ', actualHostname:',
                actualHostname
            );
            if (possiblePrimary.hostname !== actualHostname) {
                logger.debug(
                    'Primary not valid: hostname of possible primary (',
                    possiblePrimary.hostname,
                    ') does not actual hostname (',
                    actualHostname, ')'
                );
                isValid = false;
            }

            return isValid;
        });
};

/**
 * Called when a primary has been elected
 *
 * @param {String} primaryId - Instance ID that was elected primary.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
AzureCloudProvider.prototype.primaryElected = function primaryElected(instanceId) {
    // Find other instance in the db that are marked as primary, and mark them as non-primary
    return getInstancesFromDb(this.storageClient)
        .then((registeredInstances) => {
            const registeredInstanceIds = Object.keys(registeredInstances);
            const promises = [];
            let instance;

            registeredInstanceIds.forEach((registeredId) => {
                instance = registeredInstances[registeredId];
                if (registeredId !== instanceId && instance.isPrimary) {
                    instance.isPrimary = false;
                    promises.push(this.putInstance(registeredId, instance));
                }
            });

            // Note: we are not returning the promise here - no need to wait for this to complete
            q.all(promises);
        });
};

/**
 * Called when a primary has been elected.
 *
 * Update VirtualMachineScaleSet Tags, adding/updating the Deployment primary tag.
 *
 * @param {String} primaryId - The instance ID of the elected primary.
 * @param {Object} instances - Dictionary of instances as returned from getInstances.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
AzureCloudProvider.prototype.tagPrimaryInstance = function tagPrimaryInstance(primaryIid, instances) {
    if (!instances[primaryIid]) {
        return q.reject(new Error('Primary Instance provided not in instances dictionary'));
    }
    return getTagsFromScaleSet(this.computeClient, this.resourceGroup, this.scaleSet)
        .then((tags) => {
            const scaleSetTags = {};
            scaleSetTags.tags = tags;
            scaleSetTags.tags[`${this.resourceGroup}-primary`] = instances[primaryIid].privateIp;
            return updateScaleSet(this.computeClient, this.resourceGroup, this.scaleSet, scaleSetTags);
        })
        .catch((err) => {
            return q.reject(err);
        });
};

/**
 * Called to get check for and retrieve a stored UCS file
 *
 * @returns {Promise} A promise which will be resolved with a Buffer containing
 *                    the UCS data if it is present, resolved with undefined if not
 *                    found, or rejected if an error occurs.
 */
AzureCloudProvider.prototype.getStoredUcs = function getStoredUcs() {
    const deferred = q.defer();

    this.storageClient.listBlobsSegmented(BACKUP_CONTAINER, null, null, (err, result) => {
        if (err) {
            this.logger.warn('listBlobsSegmented failed:', err);
            deferred.reject(err);
            return;
        }

        let newestDate = new Date(1970, 1, 1);
        let newest;
        let currentDate;
        let blobStream;

        result.entries.forEach((entry) => {
            if (entry.name.endsWith('.ucs')) {
                currentDate = new Date(entry.lastModified);
                if (currentDate > newestDate) {
                    newest = entry;
                    newestDate = currentDate;
                }
            }
        });

        if (newest) {
            this.logger.silly('getting blob', newest.name);
            blobStream = this.storageClient.createReadStream(BACKUP_CONTAINER, newest.name);
            deferred.resolve(blobStream);
        } else {
            this.logger.debug('No UCS found in storage account');
            deferred.resolve();
        }
    });

    return deferred.promise;
};

/**
 * Stores a UCS file in cloud storage
 *
 * @param {String} file      - Full path to file to store.
 * @param {Number} maxCopies - Number of files to store. Oldest files over
 *                             this number should be deleted.
 * @param {String} prefix    - The common prefix for autosaved UCS files
 *
 * @returns {Promise} A promise which is resolved when processing is complete.
 */
AzureCloudProvider.prototype.storeUcs = function storeUcs(file, maxCopies, prefix) {
    return putFileObject(this.storageClient, BACKUP_CONTAINER, path.basename(file), file)
        .then(() => {
            return deleteOldestObjects(this.storageClient, BACKUP_CONTAINER, maxCopies, prefix);
        });
};

/**
 * Called to delete a stored UCS file based on filename
 *
 * @param   {String}  UCS filename
 *
 * @returns {Promise} returns a promise which resolves with status of delete operation
 *                    or gets rejected in a case of failures
 *
 */

AzureCloudProvider.prototype.deleteStoredUcs = function deleteStoredUcs(fileName) {
    return deleteObject(this.storageClient, BACKUP_CONTAINER, fileName);
};


/**
 * Gets data from provider specific URI
 *
 * URI must be an Azure Storage account URI
 *
 * @param {String} uri  - The cloud-specific URI of the resource. In this case, the URI is
 *                       expected to be an Azure Storage URI
 *
 * @returns {Promise} A promise which will be resolved with the data from the URI
 *                    or rejected if an error occurs.
 */
AzureCloudProvider.prototype.getDataFromUri = function getDataFromUri(uri) {
    const azureRegex = /https:\/\/[a-z0-9]+\.blob\.core\.windows\.net/;
    if (!uri.match(azureRegex)) {
        return q.reject(new Error('Invalid URI. URI should be an Azure Storage URI'));
    }

    // URI format is: https://account.blob.core.windows.net/container/blob
    let parts = uri.split('blob.core.windows.net/');

    // Get container and blob
    parts = parts[1].split('/');
    if (parts.length < 2) {
        const exampleURI = 'https://account.blob.core.windows.net/container/blob';
        return q.reject(new Error(`Invalid URI. Format should be ${exampleURI}`));
    }

    // Support blobs in 'folders'
    const container = parts.splice(0, 1)[0];
    const blob = parts.join('/');

    return getBlobToText(this.storageClient, container, blob)
        .then((data) => {
            return data.toString();
        })
        .catch((err) => {
            return q.reject(err);
        });
};

/**
 * Saves instance info
 *
 * @param {String} instanceId - ID of instance
 * @param {Object} instance   - Instance information as returned by getInstances.
 *
 * @returns {Promise} A promise which will be resolved with instance info.
 */
AzureCloudProvider.prototype.putInstance = function putInstance(instanceId, instance) {
    logger.silly('putInstance:', instanceId, instance);
    const instanceToUpdate = instance;
    instanceToUpdate.lastUpdate = new Date();
    return putJsonObject.call(this, this.storageClient, INSTANCES_CONTAINER, instanceId, instanceToUpdate);
};

function getInstanceMetadata() {
    return cloudUtil.getDataFromUrl(
        'http://169.254.169.254/metadata/instance?api-version=2017-04-02',
        {
            headers: {
                Metadata: true
            }
        }
    )
        .then((metaData) => {
            return metaData;
        });
}

/**
 * Gets list of network interfaces in a tagged scale set
 *
 * @param {Object}  computeClient         - Azure compute instance
 * @param {Object}  networkClient         - Azure network client instance
 * @param {String}  resourceGroup         - Name of the resource group
 * @param {String}  tag                   - Tag to search for
 * @param {Object}  [options]             - Optional parameters
 * @param {Boolean} [options.labelByVmId] - Use the VM id to tag the vm. Default is to
 *                                          label by nic ID
 *
 * @returns {Promise} A promise which will be resolved with a dictonary of nics with
 *                    the given tag, keyed by nic ID or vmId based on options.labelByVmId
 */
function getVmScaleSetNetworkInterfaces(computeClient, networkClient, resourceGroup, tag, options) {
    assert.ok(computeClient, 'getVmScaleSetNetworkInterfaces: no compute client');
    assert.ok(networkClient, 'getVmScaleSetNetworkInterfaces: no network client');
    assert.ok(resourceGroup, 'getVmScaleSetNetworkInterfaces: no resource group');
    assert.ok(tag, 'getVmScaleSetNetworkInterfaces: no tag');

    const deferred = q.defer();
    const promises = [];

    const labelByVmId = options ? options.labelByVmId : false;

    let vmScaleSets;

    computeClient.virtualMachineScaleSets.list(resourceGroup, (err, results) => {
        let scaleSetName;

        if (err) {
            deferred.reject(err);
            return;
        }

        vmScaleSets = results;

        logger.silly('virtualMachineScaleSets.list results:', vmScaleSets);

        vmScaleSets.forEach((vmScaleSet) => {
            if (vmScaleSet.tags && vmScaleSet.tags[tag.key] && vmScaleSet.tags[tag.key] === tag.value) {
                scaleSetName = vmScaleSet.name;
                promises.push(getScaleSetNetworkPrimaryInterfaces(
                    computeClient,
                    networkClient,
                    resourceGroup,
                    scaleSetName,
                    { labelByVmId }
                ));
            }
        });

        q.all(promises)
            .then((nicResults) => {
                const nics = [];
                nicResults.forEach((nicResult) => {
                    nicResult.forEach((nic) => {
                        nics.push(nic);
                    });
                });
                deferred.resolve(nics);
            })
            .catch((nicErr) => {
                deferred.reject(nicErr);
            });
    });

    return deferred.promise;
}

/**
 * Gets list of VMs with a given tag
 *
 * @param {Object}  computeClient         - Azure compute instance
 * @param {Object}  networkClient         - Azure network client instance
 * @param {String}  resourceGroup         - Name of the resource group
 * @param {String}  tag                   - Tag to search for
 * @param {Object}  [options]             - Optional parameters
 * @param {Boolean} [options.labelByVmId] - Use the VM id to tag the vm. Default is to
 *                                          label by nic ID
 *
 * @returns {Promise} A promise which will be resolved with a dictonary of VMs with
 *                    the given tag, keyed by nic ID or vmId based on options.labelByVmId
 */
function getVms(computeClient, networkClient, resourceGroup, tag, options) {
    assert.ok(computeClient, 'getVms: no compute client');
    assert.ok(networkClient, 'getVms: no network client');
    assert.ok(resourceGroup, 'getVms: no resource group');
    assert.ok(tag, 'getVms: no tag');

    const deferred = q.defer();
    const promises = [];
    let nicName;

    const labelByVmId = options ? options.labelByVmId : false;

    computeClient.virtualMachines.list(resourceGroup, (err, results) => {
        let networkInterfaceOptions;

        if (err) {
            deferred.reject(err);
            return;
        }

        logger.silly('virtualMachines.list results:', results);

        results.forEach((result) => {
            if (labelByVmId) {
                networkInterfaceOptions = {
                    key: result.vmId
                };
            }

            if (
                result.networkProfile &&
                result.tags &&
                result.tags[tag.key] &&
                result.tags[tag.key] === tag.value
            ) {
                result.networkProfile.networkInterfaces.forEach((networkInterface) => {
                    if (
                        !Object.prototype.hasOwnProperty.call(networkInterface, 'primary') ||
                        networkInterface.primary === true
                    ) {
                        nicName = networkInterface.id.split('/')[8];
                        promises.push(getNetworkInterface(
                            networkClient,
                            resourceGroup,
                            nicName,
                            networkInterfaceOptions
                        ));
                    }
                });
            }
        });

        q.all(promises)
            .then((nicResults) => {
                deferred.resolve(nicResults);
            })
            .catch((nicErr) => {
                deferred.reject(nicErr);
            });
    });

    return deferred.promise;
}

/**
 * Gets all VMs in a scale set
 *
 * @param {Object}    computeClient    - Azure compute instance
 * @param {String}    resourceGroup    - Name of the resource group the scale set is in
 * @param {String}    scaleSetName     - Name of the scale set
 *
 * @returns {Promise} Promise which will be resolved with a dictionary of VMs keyed by the instance ID
 */
function getScaleSetVms(computeClient, resourceGroup, scaleSetName, options) {
    assert.ok(computeClient, 'getScaleSetVms: no compute client');
    assert.ok(resourceGroup, 'getScaleSetVms: no resource group');
    assert.ok(scaleSetName, 'getScaleSetVms: no scaleSetName group');

    const deferred = q.defer();
    const vms = {};
    let localOptions = {};

    if (options) {
        localOptions = options;
    }

    computeClient.virtualMachineScaleSetVMs.list(resourceGroup, scaleSetName, localOptions,
        (err, results) => {
            if (err) {
                deferred.reject(err);
            } else {
                logger.silly('virtualMachineScaleSetVMs.list results:', results);
                results.forEach((vm) => {
                    vms[vm.instanceId] = vm;
                });
                deferred.resolve(vms);
            }
        });

    return deferred.promise;
}


/**
 * Gets all network interfaces in a scale set
 *
 * @param {Object}    networkClient   - Azure network client
 * @param {String}    resourceGroup   - Name of the resource group
 * @param {String}    scaleSetName    - Name of the scale set
 *
 * @returns {Promise} Promise which will be resolved with the network interfaces
 *                    or rejected if an error occurs
 */
function getScaleSetNetworkInterfaces(networkClient, resourceGroup, scaleSetName) {
    assert.ok(networkClient, 'getScaleSetNetworkInterfaces: no network client');
    assert.ok(resourceGroup, 'getScaleSetNetworkInterfaces: no resource group');
    assert.ok(scaleSetName, 'getScaleSetNetworkInterfaces: no scaleSetName group');

    const deferred = q.defer();

    networkClient.networkInterfaces.listVirtualMachineScaleSetNetworkInterfaces(
        resourceGroup,
        scaleSetName,
        (err, results) => {
            if (err) {
                deferred.reject(err);
            } else {
                logger.silly(
                    'networkInterfaces.listVirtualMachineScaleSetNetworkInterfaces result:',
                    results
                );
                deferred.resolve(results);
            }
        }
    );

    return deferred.promise;
}

/**
 * Gets primary network interfaces in a scale set
 *
 * @param {Object} computeClient          - Azure compute instance
 * @param {Object} networkClient          - Azure network client
 * @param {String} resourceGroup          - Name of the resource group
 * @param {String} scaleSetName           - Name of the scale set
 * @param {Boolean} [options.labelByVmId] - Use the VM id to tag the vm. Default is to
 *                                          label by nic ID
 *
 *
 * @returns {Promise} Promise which will be resolved with the network interfaces
 *                    or rejected if an error occurs
 */
function getScaleSetNetworkPrimaryInterfaces(
    computeClient,
    networkClient,
    resourceGroup,
    scaleSetName,
    options
) {
    assert.ok(computeClient, 'getScaleSetNetworkPrimaryInterfaces: no compute client');
    assert.ok(networkClient, 'getScaleSetNetworkPrimaryInterfaces: no network client');
    assert.ok(resourceGroup, 'getScaleSetNetworkPrimaryInterfaces: no resource group');
    assert.ok(scaleSetName, 'getScaleSetNetworkPrimaryInterfaces: no scaleSetName group');

    const labelByVmId = options ? options.labelByVmId : false;

    let nic;
    let nicId;
    let instanceId;
    let machineIdToVmIdMap;
    let promise;

    if (labelByVmId) {
        promise = mapMachineIdToVmId(computeClient, resourceGroup, scaleSetName);
    } else {
        promise = q();
    }

    return promise
        .then((results) => {
            if (labelByVmId) {
                machineIdToVmIdMap = results;
            }

            return getScaleSetNetworkInterfaces(networkClient, resourceGroup, scaleSetName);
        })
        .then((results) => {
            const nics = [];
            results.forEach((networkInterface) => {
                if (networkInterface.primary === true) {
                    networkInterface.ipConfigurations.forEach((ipConfiguration) => {
                        if (ipConfiguration.primary === true) {
                            instanceId = networkInterface.id.split('/')[10];
                            nicId = `${resourceGroup}-${scaleSetName}${instanceId}`;
                            nic = {
                                id: labelByVmId ?
                                    machineIdToVmIdMap[networkInterface.virtualMachine.id] || nicId : nicId,
                                ip: {
                                    private: ipConfiguration.privateIPAddress
                                }
                            };
                            nics.push(nic);
                        }
                    });
                }
            });

            return nics;
        });
}

function getNetworkInterfaces(networkClient, resourceGroup, tag) {
    assert.ok(networkClient, 'getNetworkInterfaces: no network client');
    assert.ok(resourceGroup, 'getNetworkInterfaces: no resource group');
    assert.ok(tag, 'getNetworkInterfaces: no tag');

    const deferred = q.defer();
    const promises = [];

    networkClient.networkInterfaces.list(resourceGroup, (err, results) => {
        if (err) {
            deferred.reject(err);
            return;
        }

        logger.silly('networkInterfaces.list results:', results);

        results.forEach((result) => {
            const nicName = result.name;

            if (
                result.primary === true &&
                result.tags &&
                result.tags[tag.key] &&
                result.tags[tag.key] === tag.value
            ) {
                promises.push(getNetworkInterface(networkClient, resourceGroup, nicName));
            }
        });

        q.all(promises)
            .then((nicResults) => {
                deferred.resolve(nicResults);
            })
            .catch((nicErr) => {
                deferred.reject(nicErr);
            });
    });

    return deferred.promise;
}

/**
 * Gets information about a newwork interface
 *
 * @param {Object} networkClient   - Azure network client
 * @param {String} resourceGroup   - Name of the resource group
 * @param {String} nicName         - Name of the network interface
 * @param {Object} [options]       - Optional parameters
 * @param {String} [options.key]   - String to use for the ID of the nic. Default <resourceGroup>-<nic_name>
 *
 * @returns {Promise} A promise which is resolved with the network interface info or rejected
 *                    if an error occurs
 */
function getNetworkInterface(networkClient, resourceGroup, nicName, options) {
    assert.ok(networkClient, 'getNetworkInterface: no network client');
    assert.ok(resourceGroup, 'getNetworkInterface: no resource group');
    assert.ok(nicName, 'getNetworkInterface: no nicName');

    const deferred = q.defer();
    let nic;
    let nicId;

    const providedKey = options ? options.key : undefined;

    networkClient.networkInterfaces.get(resourceGroup, nicName, (err, result) => {
        if (err) {
            deferred.reject(err);
            return;
        }

        logger.silly('networkInterfaces.get result:', result);

        const resourceGroupName = result.id.split('/')[4];
        const actualNicName = result.name;
        nicId = `${resourceGroupName}-${actualNicName}`;

        result.ipConfigurations.forEach((ipConfiguration) => {
            if (ipConfiguration.primary === true) {
                nic = {
                    id: providedKey || nicId,
                    ip: {
                        private: ipConfiguration.privateIPAddress
                    }
                };

                if (ipConfiguration.publicIPAddress) {
                    getPublicIp(networkClient, resourceGroupName, ipConfiguration.publicIPAddress)
                        .then((ipResult) => {
                            nic.ip.public = ipResult.ip;
                            deferred.resolve(nic);
                        })
                        .catch((ipErr) => {
                            deferred.reject(ipErr);
                        });
                } else {
                    deferred.resolve(nic);
                }
            }
        });
    });

    return deferred.promise;
}

/**
 * Gets the public IP from a public IP object
 *
 * @param {Object} networkClient   - Azure network client
 * @param {String} resourceGroup   - Name of the resource group
 * @param {Object} publicIPAddress - Public IP address as found in ipConfigurations returned by Azure APIs
 * @param {String} [id]            - ID to put in the response
 */
function getPublicIp(networkClient, resourceGroup, publicIPAddress, id) {
    assert.ok(networkClient, 'getPublicIp: no network client');
    assert.ok(resourceGroup, 'getPublicIp: no resource group');
    assert.ok(publicIPAddress, 'getPublicIp: no publicIPAddress');

    const deferred = q.defer();
    const publicIpName = publicIPAddress.id.split('/')[8];

    networkClient.publicIPAddresses.get(resourceGroup, publicIpName, (err, result) => {
        if (err) {
            deferred.reject(err);
            return;
        }

        deferred.resolve(
            {
                id,
                ip: result.ipAddress
            }
        );
    });
    return deferred.promise;
}

/**
 * Gets the public IP from the VM Scale Set Resource
 *
 * @param {Object} networkClient   - Azure network client
 * @param {String} resourceGroup   - Name of the resource group
 * @param {Object} publicIPAddress - Public IP address as found in ipConfigurations returned by Azure APIs
 * @param {String} [id]            - ID to put in the response
 */
function getPublicIpFromScaleSet(networkClient, resourceGroup, publicIPAddress, id) {
    assert.ok(networkClient, 'getPublicIpFromScaleSet: no network client');
    assert.ok(resourceGroup, 'getPublicIpFromScaleSet: no resource group');
    assert.ok(publicIPAddress, 'getPublicIpFromScaleSet: no publicIPAddress');

    const deferred = q.defer();
    // Parse out required items
    const publicIpAddressId = publicIPAddress.id.split('/');
    const vmssName = publicIpAddressId[8];
    const vmssVmIndex = publicIpAddressId[10];
    const nicName = publicIpAddressId[12];
    const ipConfigName = publicIpAddressId[14];

    networkClient.publicIPAddresses.listVirtualMachineScaleSetVMPublicIPAddresses(resourceGroup, vmssName,
        vmssVmIndex, nicName, ipConfigName, (err, result) => {
            if (err) {
                deferred.reject(err);
                return;
            }

            deferred.resolve(
                {
                    id,
                    ip: result[0].ipAddress
                }
            );
        });
    return deferred.promise;
}

function getInstanceIdFromScaleSet(computeClient, resourceGroup, scaleSet, instanceName) {
    assert.ok(computeClient, 'getInstanceIdFromScaleSet: no compute client');
    assert.ok(resourceGroup, 'getInstanceIdFromScaleSet: no resource group');
    assert.ok(scaleSet, 'getInstanceIdFromScaleSet: no scaleSet');
    assert.ok(instanceName, 'getInstanceIdFromScaleSet: no instanceName');

    return getScaleSetVms(computeClient, resourceGroup, scaleSet)
        .then((results) => {
            const vms = Object.keys(results);

            let vm;
            let instanceId;

            for (let i = 0; i < vms.length; i++) {
                vm = vms[i];
                if (results[vm].name === instanceName) {
                    instanceId = results[vm].instanceId;
                    break;
                }
            }

            if (instanceId) {
                return instanceId;
            }
            return q.reject(new Error('Unable to determine instance ID'));
        })
        .catch((err) => {
            return q.reject(new Error(`Error getting instance ID: ${err.message}`));
        });
}

function getTagsFromScaleSet(computeClient, resourceGroup, scaleSet) {
    assert.ok(computeClient, 'getTagsFromScaleSet: no compute client');
    assert.ok(resourceGroup, 'getTagsFromScaleSet: no resource group');
    assert.ok(scaleSet, 'getTagsFromScaleSet: no scaleSet');

    const deferred = q.defer();

    computeClient.virtualMachineScaleSets.get(resourceGroup, scaleSet, {}, (err, results) => {
        if (err) {
            deferred.reject(err);
        }
        if (results.tags) {
            logger.silly('Scale Set tags: ', results.tags);
            deferred.resolve(results.tags);
        }
    });
    return deferred.promise;
}

/**
 * Updates parameters on Virtual Machine Scale Set
 * When updating Scale Set Tags, ALL tags should be provided
 *
 * @param {Object} computeClient   - Azure compute client
 * @param {String} resourceGroup   - Name of the resource group
 * @param {String} scaleSet        - Virtual Machine Scale Set name
 * @param {Object} [params]        - Parameters to update in Scale Set
 *      {
 *          tags: {
 *              application: 'app'
 *          }
 *      }
 * @returns {Promise} A promise which is resolved, or rejected if error occurs
 */
function updateScaleSet(computeClient, resourceGroup, scaleSet, params) {
    assert.ok(computeClient, 'updateScaleSet: no compute client');
    assert.ok(resourceGroup, 'updateScaleSet: no resource group');
    assert.ok(scaleSet, 'updateScaleSet: no scaleSet');

    computeClient.virtualMachineScaleSets.update(resourceGroup, scaleSet, params, {}, (err) => {
        if (err) {
            return q.reject(err);
        }
        return q();
    });
}

function getInstanceIdFromVms(vms, vmId) {
    if (!vms || !vmId) {
        logger.silly('vms or vmId is empty');
        return null;
    }

    const vmKeys = Object.keys(vms);

    // Azure VM IDs are returned with different cases from different APIs
    const normalizedId = vmId.toLowerCase();

    for (let i = 0; i < vmKeys.length; i++) {
        const vm = vms[vmKeys[i]];
        if (vm.id.toLowerCase() === normalizedId) {
            return vm.instanceId;
        }
    }

    return null;
}

/**
 * Maps virtualMachine.id to vmId
 *
 * @param {Object} computeClient  - Azure compute instance
 * @param {String} resourceGroup  - Name of the resource group
 * @param {String} scaleSetName   - Name of the scale set
 */
function mapMachineIdToVmId(computeClient, resourceGroup, scaleSetName) {
    assert.ok(computeClient, 'mapMachineIdToVmId: no compute client');
    assert.ok(resourceGroup, 'mapMachineIdToVmId: no resource group');
    assert.ok(scaleSetName, 'mapMachineIdToVmId: no scaleSetName');

    const deferred = q.defer();
    const idMap = {};

    computeClient.virtualMachineScaleSetVMs.list(resourceGroup, scaleSetName, (listErr, results) => {
        if (listErr) {
            deferred.reject(listErr);
        } else {
            const numRequested = results.length;
            let numReceived = 0;

            results.forEach((vm) => {
                computeClient.virtualMachineScaleSetVMs.get(
                    resourceGroup,
                    scaleSetName,
                    vm.instanceId,
                    (getErr, vmDetail) => {
                        numReceived += 1;
                        if (getErr) {
                            deferred.reject(getErr);
                        } else {
                            idMap[vmDetail.id] = vmDetail.vmId;
                            if (numReceived >= numRequested) {
                                deferred.resolve(idMap);
                            }
                        }
                    }
                );
            });
        }
    });

    return deferred.promise;
}

/**
 * Gets our view of the current instances
 *
 * @param {Object} storageClient - Azure storage instance
 *
 * @returns {Object} Object containing a dictionary of instances keyed by Instance IDs
 */
function getInstancesFromDb(storageClient) {
    assert.ok(storageClient, 'getInstancesFromDb: no storage client');

    const deferred = q.defer();

    storageClient.listBlobsSegmented(INSTANCES_CONTAINER, null, null, (err, result) => {
        const promises = [];
        const instanceIds = [];

        if (err) {
            deferred.reject(err);
        } else {
            logger.silly('listBlobsSegmented data:', result);
            result.entries.forEach((entry) => {
                instanceIds.push(entry.name);
                promises.push(getJsonObject(storageClient, INSTANCES_CONTAINER, entry.name));
            });

            q.all(promises)
                .then((dbInstances) => {
                    const instances = {};
                    dbInstances.forEach((instance, index) => {
                        instances[instanceIds[index]] = instance;
                    });
                    deferred.resolve(instances);
                })
                .catch((jsonErr) => {
                    deferred.reject(jsonErr);
                });
        }
    });

    return deferred.promise;
}

/**
 * Generic Azure storage deleteObject
 *
 * @param {Object}    storageClient    - Azure storage instance
 * @param {String[]}  idsToDelete      - Array of IDs to delete
 * @param {Object}    [options]        - Optional parameters
 * @param {Boolean}   [options.noWait] - Whether or not to wait for completion before returning.
 *                                       Default is to wait.
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 */
function deleteInstancesFromDb(storageClient, idsToDelete, options) {
    assert.ok(storageClient, 'deleteInstancesFromDb: no storage client');

    const promises = [];

    const noWait = options ? options.noWait : false;

    if (idsToDelete.length > 0) {
        idsToDelete.forEach((id) => {
            promises.push(deleteObject(storageClient, INSTANCES_CONTAINER, id));
        });

        if (noWait) {
            q.all(promises);
            return q();
        }
        return q.all(promises);
    }
    return q();
}

function deleteOldestObjects(storageClient, container, maxCopies, prefix) {
    assert.ok(storageClient, 'deleteOldestObjects: no storage client');
    assert.ok(container, 'deleteOldestObjects: no container');

    const deferred = q.defer();

    storageClient.listBlobsSegmented(container, null, (err, result) => {
        const promises = [];
        let objectsToCheck;

        if (err) {
            logger.info('deleteOldestObjects: listBlobsSegmented error', err);
            deferred.reject(err);
            return;
        }

        if (!prefix) {
            objectsToCheck = result.entries;
        } else {
            objectsToCheck = result.entries.filter((entry) => {
                return entry.name.startsWith(prefix);
            });
        }

        if (objectsToCheck.length > maxCopies) {
            const idsToDelete = [];

            // Sort so that oldest is first
            objectsToCheck.sort((a, b) => {
                if (a.lastModified < b.lastModified) {
                    return -1;
                } else if (b.lastModified < a.lastModified) {
                    return 1;
                }
                return 0;
            });

            for (let i = 0; i < objectsToCheck.length - maxCopies; i++) {
                idsToDelete.push(objectsToCheck[i].name);
            }

            idsToDelete.forEach((id) => {
                promises.push(deleteObject(storageClient, BACKUP_CONTAINER, id));
            });

            q.all(promises)
                .then(() => {
                    deferred.resolve();
                })
                .catch((deleteErr) => {
                    logger.info('deleteOldestObjects: deleteObject error:', deleteErr);
                    deferred.reject(deleteErr);
                });
        } else {
            deferred.resolve();
        }
    });

    return deferred.promise;
}

/**
 * Gets the Azure Environment from the location in instance metadata
 *
 * @returns {Promise}   Promise which will be resolved with the name of the Environment,
 *                      or rejected if an error occurs.
 */
function getInstanceEnvironment() {
    let environment = azureEnvironment.Azure.name;

    return getInstanceMetadata()
        .then((metadata) => {
            const location = metadata.compute.location.toLowerCase();
            Object.keys(specialLocations).forEach((specialLocation) => {
                specialLocations[specialLocation].forEach((region) => {
                    if (location.indexOf(region) !== -1) {
                        environment = specialLocation;
                    }
                });
            });
            return q(environment);
        })
        .catch((err) => {
            return q.reject(err);
        });
}

/**
 * Creates empty containers
 *
 * @param {Object}    storageClient    - Azure storage instance
 * @param {Object[]}  containers       - Array of container names to create
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 */
function createContainers(storageClient, containers) {
    assert.ok(storageClient, 'createContainers: no storage client');

    const promises = [];

    const createContainer = function (container) {
        const deferred = q.defer();

        storageClient.createContainerIfNotExists(container, (err) => {
            if (err) {
                logger.warn(err);
                deferred.reject(err);
            } else {
                deferred.resolve();
            }
        });

        return deferred.promise;
    };

    containers.forEach((container) => {
        promises.push(createContainer(container));
    });

    return q.all(promises);
}

function putFileObject(storageClient, container, name, file) {
    assert.ok(storageClient, 'putFileObject: no storage client');
    assert.ok(container, 'putFileObject: no container');
    assert.ok(name, 'putFileObject: no name');
    assert.ok(file, 'putFileObject: no file');

    const deferred = q.defer();
    storageClient.createBlockBlobFromLocalFile(container, name, file, (err) => {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve();
        }
    });
    return deferred.promise;
}

/**
 * Stores a JSON ojbect in Azure storage
 *
 * @param {Object}    storageClient    - Azure storage instance
 * @param {String}    container        - Name of the container in which to store the Object
 * @param {String}    name             - Name to store the object as
 * @param {Object}    data             - Object to store
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 *                    or rejected if an error occurs.
 */
function putJsonObject(storageClient, container, name, data) {
    assert.ok(storageClient, 'putJsonObject: no storage client');
    assert.ok(container, 'putJsonObject: no container');
    assert.ok(name, 'putJsonObject: no name');

    const jsonData = JSON.stringify(data);

    const tryCreateBlob = function () {
        const deferred = q.defer();

        storageClient.createBlockBlobFromText(container, name, jsonData, (err) => {
            if (err) {
                deferred.reject(err);
            } else {
                deferred.resolve();
            }
        });
        return deferred.promise;
    };

    return cloudUtil.tryUntil(this, cloudUtil.MEDIUM_RETRY, tryCreateBlob);
}

/**
 * Gets a JSON ojbect from Azure storage
 *
 * @param {Object}    storageClient    - Azure storage instance
 * @param {String}    container        - Name of the container in which to store the Object
 * @param {String}    name             - Name to store the object as
 *
 * @returns {Promise} Promise which will be resolved with the object
 *                    or rejected if an error occurs.
 */
function getJsonObject(storageClient, container, name) {
    const deferred = q.defer();
    getBlobToText(storageClient, container, name)
        .then((data) => {
            try {
                logger.silly('getBlobToText result:', data);
                deferred.resolve(JSON.parse(data));
            } catch (jsonErr) {
                deferred.reject(jsonErr);
            }
        })
        .catch((err) => {
            deferred.reject(err);
        });
    return deferred.promise;
}

function getBlobToText(storageClient, container, name) {
    assert.ok(storageClient, 'getBlobToText: no storage client');
    assert.ok(container, 'getBlobToText: no container');
    assert.ok(name, 'getBlobToText: no name');

    const deferred = q.defer();

    storageClient.getBlobToText(container, name, (err, data) => {
        if (err) {
            logger.debug('error from getBlobToText:', err);
            deferred.reject(err);
        } else {
            deferred.resolve(data);
        }
    });
    return deferred.promise;
}

function deleteObject(storageClient, container, name) {
    assert.ok(storageClient, 'deleteObject: no storage client');
    assert.ok(container, 'deleteObject: no container');
    assert.ok(name, 'deleteObject: no name');

    const deferred = q.defer();

    storageClient.deleteBlobIfExists(container, name, (err) => {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve();
        }
    });

    return deferred.promise;
}

/**
 * De-duplicates instances object
 *
 * Occasionally we end up with a duplicate - one by machine id
 * and one by vmId. We want the vmId, which is a UUID format
 *
 * @param {Object[]} instances
 */
function dedupeInstances(instances) {
    const ipToIdMap = {};
    const instanceIds = instances ? Object.keys(instances) : [];

    for (let i = 0; i < instanceIds.length; i++) {
        const instanceId = instanceIds[i];
        const instance = instances[instanceId];

        if (!ipToIdMap[instance.privateIp]) {
            ipToIdMap[instance.privateIp] = instanceId;
        } else if (REG_EXPS.UUID.test(instanceId)) {
            if (instance.providerVisible) {
                // eslint-disable-next-line
                delete instances[ipToIdMap[instance.privateIp]];
                ipToIdMap[instance.privateIp] = instanceId;
            } else {
                // eslint-disable-next-line
                delete instances[instanceId];
            }
        } else {
            // eslint-disable-next-line
            delete instances[instanceId];
        }
    }
}

module.exports = AzureCloudProvider;
