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

const util = require('util');
const q = require('q');
const msRestAzure = require('ms-rest-azure');
const NetworkManagementClient = require('azure-arm-network');
const ComputeManagementClient = require('azure-arm-compute');
const azureStorage = require('azure-storage');

const AbstractAutoscaleProvider = require('@f5devcentral/f5-cloud-libs').autoscaleProvider;
const BigIp = require('@f5devcentral/f5-cloud-libs').bigIp;
const AutoscaleInstance = require('@f5devcentral/f5-cloud-libs').autoscaleInstance;
const Logger = require('@f5devcentral/f5-cloud-libs').logger;
const cloudUtil = require('@f5devcentral/f5-cloud-libs').util;

let logger;

const BACKUP_CONTAINER = 'backup';
const INSTANCES_CONTAINER = 'instances';

util.inherits(AzureAutoscaleProvider, AbstractAutoscaleProvider);

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
function AzureAutoscaleProvider(options) {
    AzureAutoscaleProvider.super_.call(this, options);

    this.features[AbstractAutoscaleProvider.FEATURE_SHARED_PASSWORD] = true;
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
 * @param {Object}  providerOptions                  - Provider specific options.
 * @param {String}  providerOptions.azCredentialsUrl - URL to file or location with credentials
 *     File/location should contain JSON object with the following:
 *         {
 *             clientId:       Azure client ID
 *             tenantId:       Azure tenant ID
 *             secret:         Azure secret
 *             subscriptionId: Azure subscription ID
 *             storageAccount: Azure storage account
 *             storageKey:     Azure storage account key
 *         }
 * @param {String}  providerOptions.resourceGroup  - Resoource group name.
 * @param {String}  providerOptions.scaleSet       - Scale set name.
 * @param {Object}  [options]                      - Options for this instance.
 * @param {Boolean} [options.autoscale]            - Whether or not this instance will
 *                                                   be used for autoscaling.
 *
 * @returns {Promise} A promise which will be resolved when init is complete.
 */
AzureAutoscaleProvider.prototype.init = function init(providerOptions) {
    const deferred = q.defer();

    let credentialsPromise;
    let credentialsJson;

    this.logger.silly('providerOptions:', providerOptions);

    this.scaleSet = providerOptions.scaleSet;
    this.resourceGroup = providerOptions.resourceGroup;

    if (providerOptions.azCredentialsUrl) {
        credentialsPromise = cloudUtil.getDataFromUrl(providerOptions.azCredentialsUrl);
    } else {
        credentialsPromise = q();
    }

    credentialsPromise
        .then((data) => {
            const tryLogin = function () {
                const loginDeferred = q.defer();

                msRestAzure.loginWithServicePrincipalSecret(
                    credentialsJson.clientId,
                    credentialsJson.secret,
                    credentialsJson.tenantId,
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

            if (providerOptions.azCredentialsUrl) {
                credentialsJson = JSON.parse(data);
            } else {
                credentialsJson = providerOptions;
            }

            return cloudUtil.tryUntil(this, cloudUtil.MEDIUM_RETRY, tryLogin);
        })
        .then((credentials) => {
            this.networkClient = new NetworkManagementClient(credentials, credentialsJson.subscriptionId);
            this.computeClient = new ComputeManagementClient(credentials, credentialsJson.subscriptionId);
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
AzureAutoscaleProvider.prototype.bigIpReady = function bigIpReady() {
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
                logger.debug('Revoking licenses of non-masters that are not known to Azure');
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
AzureAutoscaleProvider.prototype.getInstanceId = function getInstanceId() {
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
 *                        isMaster: <Boolean>,
 *                        hostname: <String>,
 *                        mgmtIp: <String>,
 *                        privateIp: <String>
 *                        publicIp: <String>,
 *                        providerVisible: <Boolean> (does the cloud provider know about this instance),
 *                        external: <Boolean> (true if this instance is external to the autoscale group/set)
 *                    }
 */
AzureAutoscaleProvider.prototype.getInstances = function getInstances(options) {
    const deferred = q.defer();
    const instances = {};
    const bigIps = [];
    const azureInstanceIds = [];
    const initPromises = [];
    const hostnamePromises = [];
    const instanceViewPromises = [];
    const publicIpPromises = [];
    const idsToDelete = [];

    const externalTag = options ? options.externalTag : undefined;

    let vms;
    let bigIp;

    getScaleSetVms(this.computeClient, this.resourceGroup, this.scaleSet)
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
                    if (pubIp.id.toLowerCase().indexOf('/microsoft.compute/virtualmachinescalesets') !== -1) {
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

                // Account for power state possibly being deallocated, set providerVisible to false if so
                if (
                    vms[instanceId].provisioningState === 'Succeeded' ||
                    vms[instanceId].provisioningState === 'Creating'
                ) {
                    instances[instanceId].providerVisible = true;
                    instanceViewPromises.push(getScaleSetVmsInstanceView(
                        this.computeClient,
                        this.resourceGroup,
                        this.scaleSet,
                        instanceId
                    ));
                } else {
                    instances[instanceId].providerVisible = false;
                }
            });

            return q.all(publicIpPromises);
        })
        .then((publicIps) => {
            const instanceViewDeferred = q.defer();

            publicIps.forEach((publicIp) => {
                instances[publicIp.id].publicIp = publicIp.ip;
            });

            q.all(instanceViewPromises)
                .then((instanceViews) => {
                    instanceViews.forEach((instanceView) => {
                        instanceView.statuses.forEach((status) => {
                            const statusCode = status.code.toLowerCase();
                            logger.silly('Instance power code status:', instanceView.instanceId, statusCode);
                            if (statusCode === 'powerstate/deallocated') {
                                instances[instanceView.instanceId].providerVisible = false;
                            }
                        });
                    });
                })
                .catch((err) => {
                    // just log error, but carry on. we don't want to fail on
                    // just reading the power state
                    logger.info('Error reading power state', err);
                })
                .finally(() => {
                    instanceViewDeferred.resolve();
                });

            return instanceViewDeferred.promise;
        })
        .then(() => {
            if (externalTag) {
                return this.getVmsByTag(externalTag, { labelByVmId: true });
            }
            return q();
        })
        .then((externalVms) => {
            if (externalVms) {
                externalVms.forEach((externalVm) => {
                    instances[externalVm.id] = {
                        mgmtIp: externalVm.ip.private,
                        privateIp: externalVm.ip.private,
                        external: true
                    };
                });
            }

            return getInstancesFromDb(this.storageClient);
        })
        .then((registeredInstances) => {
            logger.silly('getInstancesFromDb result:', registeredInstances);

            // Only report instances that are master and/or that Azure also knows about
            const registeredInstanceIds = Object.keys(registeredInstances);
            let providerVisible;
            let instanceId;
            let instance;

            const isValidInstance = function (instanceIdToCheck, instanceToCheck) {
                return (
                    azureInstanceIds.indexOf(instanceIdToCheck) !== -1 ||
                    (instanceToCheck.isMaster && !this.isInstanceExpired(instanceToCheck))
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
                } else {
                    // Get a list of non-master instances that we have in our db that Azure
                    // does not know about and delete them
                    idsToDelete.push(instanceId);

                    // if we're using BIG-IQ for licensing, revoke the licenses
                    // of the deleted BIG-IPs
                    if (this.clOptions.licensePool) {
                        this.instancesToRevoke.push(instance);
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

            logger.debug('Deleting non-masters that are not known to Azure', idsToDelete);
            return deleteInstancesFromDb(this.storageClient, idsToDelete, { noWait: true });
        })
        .then(() => {
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
AzureAutoscaleProvider.prototype.getNicsByTag = function getNicsByTag(tag) {
    const deferred = q.defer();
    const promises = [];
    const nics = [];

    if (!tag || !tag.key || !tag.value) {
        deferred.reject(new Error('Tag with key and value must be provided'));
        return deferred.promise;
    }

    promises.push(getNetworkInterfaces(this.networkClient, this.resourceGroup, tag));
    promises.push(getVmScaleSets(this.computeClient, this.networkClient, this.resourceGroup, tag));

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
AzureAutoscaleProvider.prototype.getVmsByTag = function getVmsByTag(tag, options) {
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
    promises.push(getVmScaleSets(this.computeClient, this.networkClient, this.resourceGroup, tag));

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
 * Elects a new master instance from the available instances
 *
 * @abstract
 *
 * @param {Object} instances - Dictionary of instances as returned by getInstances
 *
 * @returns {Promise} A promise which will be resolved with the instance ID of the
 *                    elected master.
 */
AzureAutoscaleProvider.prototype.electMaster = function electMaster(instances) {
    const instanceIds = Object.keys(instances);
    let lowestInstanceId = Number.MAX_SAFE_INTEGER;
    let lowestExternalpToNumber = Number.MAX_SAFE_INTEGER;

    let masterFound = false;
    let externalInstanceId;

    if (instanceIds.length === 0) {
        return q.reject(new Error('No instances'));
    }

    instanceIds.forEach((instanceId) => {
        const instance = instances[instanceId];
        let currentIpToNumber;

        if (instance.versionOk) {
            if (instance.providerVisible && instanceId < lowestInstanceId) {
                lowestInstanceId = instanceId;
                masterFound = true;
            }
            if (instance.external) {
                currentIpToNumber = cloudUtil.ipToNumber(instance.privateIp);
                if (currentIpToNumber < lowestExternalpToNumber) {
                    lowestExternalpToNumber = currentIpToNumber;
                    externalInstanceId = instanceId;
                    masterFound = true;
                }
            }
        }
    });

    if (masterFound) {
        return q(externalInstanceId || lowestInstanceId);
    }
    return q.reject(new Error('No possible master found'));
};

/**
 * Called to retrieve master instance credentials
 *
 * When joining a cluster we need the username and password for the
 * master instance.
 *
 * Management IP and port are passed in so that credentials can be
 * validated desired.
 *
 * @param {String} mgmtIp - Management IP of master
 * @param {String} port - Managemtn port of master
 *
 * @returns {Promise} A promise which will be resolved with:
 *                    {
 *                        username: <admin_user>,
 *                        password: <admin_password>
 *                    }
 */
AzureAutoscaleProvider.prototype.getMasterCredentials = function getMasterCredentials() {
    return q({
        username: this.bigIp.user,
        password: this.bigIp.password
    });
};

/**
 * Determines if a given instanceId is a valid master
 *
 * @param {String} instanceId - Instance ID to validate as a valid master.
 * @param {Object} instances - Dictionary of instances as returned by getInstances.
 *
 * @returns {Promise} A promise which will be resolved with a boolean indicating
 *                    wether or not the given instanceId is a valid master.
 */
AzureAutoscaleProvider.prototype.isValidMaster = function isValidMaster(instanceId, instances) {
    const possibleMaster = instances[instanceId];
    let bigIp;

    logger.silly('isValidMaster', instanceId, instances);

    // get the password for this scale set
    const passwordPromise = this.clOptions.password ?
        q(this.clOptions.password) : cloudUtil.getDataFromUrl(this.clOptions.passwordUrl);

    return passwordPromise
        .then((bigIpPassword) => {
            // Compare instance's hostname to our hostname
            bigIp = new BigIp({ loggerOptions: this.loggerOptions });
            return bigIp.init(
                possibleMaster.privateIp,
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
                'possibleMaster.hostname:',
                possibleMaster.hostname,
                ', actualHostname:',
                actualHostname
            );
            if (possibleMaster.hostname !== actualHostname) {
                logger.debug(
                    'Master not valid: hostname of possible master (',
                    possibleMaster.hostname,
                    ') does not actual hostname (',
                    actualHostname, ')'
                );
                isValid = false;
            }

            return isValid;
        });
};

/**
 * Called when a master has been elected
 *
 * @param {String} masterId - Instance ID that was elected master.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
AzureAutoscaleProvider.prototype.masterElected = function masterElected(instanceId) {
    // Find other instance in the db that are marked as master, and mark them as non-master
    return getInstancesFromDb(this.storageClient)
        .then((registeredInstances) => {
            const registeredInstanceIds = Object.keys(registeredInstances);
            const promises = [];
            let instance;

            registeredInstanceIds.forEach((registeredId) => {
                instance = registeredInstances[registeredId];
                if (registeredId !== instanceId && instance.isMaster) {
                    instance.isMaster = false;
                    promises.push(this.putInstance(registeredId, instance));
                }
            });

            // Note: we are not returning the promise here - no need to wait for this to complete
            q.all(promises);
        });
};

/**
 * Called to get check for and retrieve a stored UCS file
 *
 * @returns {Promise} A promise which will be resolved with a Buffer containing
 *                    the UCS data if it is present, resolved with undefined if not
 *                    found, or rejected if an error occurs.
 */
AzureAutoscaleProvider.prototype.getStoredUcs = function getStoredUcs() {
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
 * Saves instance info
 *
 * @param {String} instanceId - ID of instance
 * @param {Object} instance   - Instance information as returned by getInstances.
 *
 * @returns {Promise} A promise which will be resolved with instance info.
 */
AzureAutoscaleProvider.prototype.putInstance = function putInstance(instanceId, instance) {
    logger.silly('putInstance:', instanceId, instance);
    const instanceToUpdate = instance;
    instanceToUpdate.lastUpdate = new Date();
    return putJsonObject(this.storageClient, INSTANCES_CONTAINER, instanceId, instanceToUpdate);
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

function getVmScaleSets(computeClient, networkClient, resourceGroup, tag) {
    const deferred = q.defer();
    const promises = [];

    computeClient.virtualMachineScaleSets.list(resourceGroup, (err, results) => {
        let scaleSetName;

        if (err) {
            deferred.reject(err);
            return;
        }

        logger.silly('virtualMachineScaleSets.list results:', results);

        results.forEach((result) => {
            if (result.tags && result.tags[tag.key] && result.tags[tag.key] === tag.value) {
                scaleSetName = result.name;
                promises.push(getScaleSetNetworkPrimaryInterfaces(
                    networkClient,
                    resourceGroup,
                    scaleSetName
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
 *                    the given tag, keyey by nic ID or vmId based on options.labelByVmId
 */
function getVms(computeClient, networkClient, resourceGroup, tag, options) {
    const deferred = q.defer();
    const promises = [];
    let nicName;

    const labelByVmId = options ? options.labelByVmId : undefined;

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
function getScaleSetVms(computeClient, resourceGroup, scaleSetName) {
    const deferred = q.defer();
    const vms = {};

    computeClient.virtualMachineScaleSetVMs.list(resourceGroup, scaleSetName, (err, results) => {
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
 * Gets all Instance View for a VM in a Scale Set
 *
 * @param {Object}    computeClient    - Azure compute instance
 * @param {String}    resourceGroup    - Name of the resource group the scale set is in
 * @param {String}    scaleSetName     - Name of the scale set
 * @param {String}    instanceId       - Scale set instance id to place in results
 *
 * @returns {Promise} Promise which will be resolved with a dictionary of items
 *                    returned from the instance view
 */
function getScaleSetVmsInstanceView(computeClient, resourceGroup, scaleSetName, instanceId) {
    const deferred = q.defer();

    computeClient.virtualMachineScaleSetVMs.getInstanceView(
        resourceGroup,
        scaleSetName,
        instanceId,
        (err, results) => {
            if (err) {
                logger.error('virtualMachineScaleSetVMs.getInstanceView error:', err);
                deferred.reject(err);
            } else {
                // no good way to avoid updating the result object
                results.instanceId = instanceId; // eslint-disable-line no-param-reassign
                logger.silly('virtualMachineScaleSetVMs.getInstanceView results:', results);
                deferred.resolve(results);
            }
        }
    );

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

function getScaleSetNetworkPrimaryInterfaces(networkClient, resourceGroup, scaleSetName) {
    const deferred = q.defer();
    const nics = [];
    let nic;
    let nicId;
    let vmId;

    getScaleSetNetworkInterfaces(networkClient, resourceGroup, scaleSetName)
        .then((results) => {
            results.forEach((result) => {
                if (result.primary === true) {
                    result.ipConfigurations.forEach((ipConfiguration) => {
                        if (ipConfiguration.primary === true) {
                            vmId = result.id.split('/')[10];
                            nicId = `${resourceGroup}-${scaleSetName}${vmId}`;
                            nic = {
                                id: nicId,
                                ip: {
                                    private: ipConfiguration.privateIPAddress
                                }
                            };
                            nics.push(nic);
                        }
                    });
                }
            });

            deferred.resolve(nics);
        });

    return deferred.promise;
}

function getNetworkInterfaces(networkClient, resourceGroup, tag) {
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

function getInstanceIdFromVms(vms, vmId) {
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
 * Gets our view of the current instances
 *
 * @param {Object} storageClient - Azure storage instance
 *
 * @returns {Object} Object containing a dictionary of instances keyed by Instance IDs
 */
function getInstancesFromDb(storageClient) {
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

/**
 * Creates empty containers
 *
 * @param {Object}    storageClient    - Azure storage instance
 * @param {Object[]}  containers       - Array of container names to create
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 */
function createContainers(storageClient, containers) {
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
    const deferred = q.defer();

    const jsonData = JSON.stringify(data);

    storageClient.createBlockBlobFromText(container, name, jsonData, (err) => {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve();
        }
    });

    return deferred.promise;
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

    storageClient.getBlobToText(container, name, (err, data) => {
        if (err) {
            logger.debug('error from getBlobToText:', err);
            deferred.reject(err);
        } else {
            try {
                logger.silly('getBlobToText result:', data);
                deferred.resolve(JSON.parse(data));
            } catch (jsonErr) {
                deferred.reject(jsonErr);
            }
        }
    });

    return deferred.promise;
}

function deleteObject(storageClient, container, name) {
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

module.exports = AzureAutoscaleProvider;
