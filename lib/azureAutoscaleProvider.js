/**
* Copyright 2016-2017 F5 Networks, Inc.
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

var util = require('util');
var q = require('q');

var msRestAzure = require('ms-rest-azure');
var NetworkManagementClient = require('azure-arm-network');
var ComputeManagementClient = require('azure-arm-compute');
var azureStorage = require('azure-storage');
var AbstractAutoscaleProvider;
var BigIp;
var Logger;
var logger;
var cloudUtil;

const BACKUP_CONTAINER = "backup";
const INSTANCES_CONTAINER = "instances";

// In production we should be installed as a node_module under f5-cloud-libs
// In test, that will not be the case, so use our dev dependency version
// of f5-cloud-libs
try {
    AbstractAutoscaleProvider = require('../../../../f5-cloud-libs').autoscaleProvider;
    BigIp = require('../../../../f5-cloud-libs').bigIp;
    Logger = require('../../../../f5-cloud-libs').logger;
    cloudUtil = require('../../../../f5-cloud-libs').util;
}
catch (err) {
    AbstractAutoscaleProvider = require('f5-cloud-libs').autoscaleProvider;
    BigIp = require('f5-cloud-libs').bigIp;
    Logger = require('f5-cloud-libs').logger;
    cloudUtil = require('f5-cloud-libs').util;
}

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
* @param {Object} [options.loggerOptions] - Options for the logger. See {@link module:logger.getLogger} for details.
*/
function AzureAutoscaleProvider(options) {
    AzureAutoscaleProvider.super_.call(this, options);

    this.features[AbstractAutoscaleProvider.FEATURE_SHARED_PASSWORD] = true;
    this.instancesToRevoke = [];

    options = options || {};
    if (options.logger) {
        logger = this.logger = options.logger;
    }
    else if (options.loggerOptions) {
        options.loggerOptions.module = module;
        logger = this.logger = Logger.getLogger(options.loggerOptions);
    }
}

/**
* Initialize class
*
* @param {Object} providerOptions                  - Provider specific options.
* @param {String} providerOptions.azCredentialsUrl - URL to file or location with credentials
*     File/location should contain JSON object with the following:
*         {
*             clientId:       Azure client ID
*             tenantId:       Azure tenant ID
*             secret:         Azure secret
*             subscriptionId: Azure subscription ID
*             storageAccount: Azure storage account
*             storageKey:     Azure storage account key
*         }
* @param {String} providerOptions.resourceGroup    - Resoource group name.
* @param {String} providerOptions.scaleSet         - Scale set name.
*
* @returns {Promise} A promise which will be resolved when init is complete.
*/
AzureAutoscaleProvider.prototype.init = function(providerOptions) {
    var deferred = q.defer();
    var credentialsPromise;
    var credentialsJson;

    this.logger.silly('providerOptions:', providerOptions);

    this.scaleSet = providerOptions.scaleSet;
    this.resourceGroup = providerOptions.resourceGroup;

    if (providerOptions.azCredentialsUrl) {
        credentialsPromise = cloudUtil.getDataFromUrl(providerOptions.azCredentialsUrl);
    }
    else {
        credentialsPromise = q();
    }

    credentialsPromise
        .then(function(data) {
            var tryLogin = function() {
                var loginDeferred = q.defer();

                msRestAzure.loginWithServicePrincipalSecret(
                    credentialsJson.clientId,
                    credentialsJson.secret,
                    credentialsJson.tenantId,
                    function(err, credentials) {
                        if (err) {
                            loginDeferred.reject(err);
                        }
                        else {
                            loginDeferred.resolve(credentials);
                        }
                    }
                );

                return loginDeferred.promise;
            };

            if (providerOptions.azCredentialsUrl) {
                credentialsJson = JSON.parse(data);
            }
            else {
                credentialsJson = providerOptions;
            }

            return cloudUtil.tryUntil(this, cloudUtil.MEDIUM_RETRY, tryLogin);
        }.bind(this))
        .then(function(credentials) {
            this.networkClient = new NetworkManagementClient(credentials, credentialsJson.subscriptionId);
            this.computeClient = new ComputeManagementClient(credentials, credentialsJson.subscriptionId);
            if (credentialsJson.storageAccount && credentialsJson.storageKey) {
                this.storageClient = azureStorage.createBlobService(credentialsJson.storageAccount, credentialsJson.storageKey);
                return createContainers(this.storageClient, [BACKUP_CONTAINER, INSTANCES_CONTAINER]);
            }
        }.bind(this))
        .then(function() {
            deferred.resolve();
        }.bind(this))
        .catch(function(err) {
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
AzureAutoscaleProvider.prototype.bigIpReady = function() {
    this.bigIp = new BigIp({loggerOptions: this.loggerOptions});
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
    .then(function() {
        if (this.instancesToRevoke.length > 0) {
            logger.debug('Revoking licenses of non-masters that are not known to Azure');
            return this.revokeLicenses(this.instancesToRevoke, {bigIp: this.bigIp});
        }
    }.bind(this));
};

/**
* Gets the instance ID of this instance
*
* @returns {Promise} A promise which will be resolved with the instance ID of this instance
*                    or rejected if an error occurs;
*/
AzureAutoscaleProvider.prototype.getInstanceId = function() {
    var deferred = q.defer();
    var instanceName;

    if (!this.instanceId) {
        // Get our instance name from metadata
        getInstanceMetadata()
            .then(function(metaData) {
                this.logger.silly(metaData);

                if (metaData && metaData.compute && metaData.compute.name) {
                    instanceName = metaData.compute.name;

                    // Get scale set VMs
                    return getScaleSetVms(this.computeClient, this.resourceGroup, this.scaleSet);
                }
                else {
                    logger.warn('compute.name not found in meta data');
                }
            }.bind(this))
            .then(function(results) {
                var vm;

                for (vm in results) {
                    if (results[vm].name === instanceName) {
                        this.instanceId = results[vm].instanceId;
                        break;
                    }
                }

                if (this.instanceId) {
                    deferred.resolve(this.instanceId);
                }
                else {
                    deferred.reject(new Error('Unable to determine instance ID'));
                }
            }.bind(this))
            .catch(function(err) {
                deferred.reject(err);
            });
    }
    else {
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
* @abstract
*
* @returns {Promise} A promise which will be resolved with a dictionary of instances
*                    keyed by instance ID. Each instance value should be:
*                   {
*                       isMaster: <Boolean>,
*                       hostname: <String>,
*                       mgmtIp: <String>,
*                       privateIp: <String>
*                       providerVisible: <Boolean> (does the cloud provider know about this instance)
*                   }
*/
AzureAutoscaleProvider.prototype.getInstances = function() {
    var deferred = q.defer();
    var instances = {};
    var bigIps = [];
    var azureInstanceIds = [];
    var initPromises = [];
    var hostnamePromises = [];
    var idsToDelete = [];
    var vms;
    var bigIp;
    var i;

    getScaleSetVms(this.computeClient, this.resourceGroup, this.scaleSet)
        .then(function(results) {
            vms = results;
            return getScaleSetNetworkInterfaces(this.networkClient, this.resourceGroup, this.scaleSet);
        }.bind(this))
        .then(function(results) {
            var nics = results;
            var nic;
            var instanceId;
            var privateIp;
            var promises = [];
            var deferred = q.defer();

            for (nic in nics) {
                instanceId = getInstanceIdFromVms(vms, nics[nic].virtualMachine.id);
                azureInstanceIds.push(instanceId);
                privateIp = nics[nic].ipConfigurations[0].privateIPAddress;
                instances[instanceId] = {
                    mgmtIp: privateIp,
                    privateIp: privateIp
                };

                if (vms[instanceId].provisioningState === 'Succeeded' || vms[instanceId].provisioningState === 'Creating') {
                    instances[instanceId].providerVisible = true;
                    promises.push(getScaleSetVmsInstanceView(this.computeClient, this.resourceGroup, this.scaleSet, instanceId));
                }
                else {
                    instances[instanceId].providerVisible = false;
                }
            }

            // Account for power state possibly being deallocated, set providerVisible to false if so
            q.all(promises)
                .then(function(results) {
                    results.forEach(function(result) {
                        result.statuses.forEach(function(status) {
                            var statusCode = status.code.toLowerCase();
                            logger.silly('Instance power code status:', result.instanceId, statusCode);
                            if (statusCode === 'powerstate/deallocated') {
                                instances[result.instanceId].providerVisible = false;
                            }
                        });
                    });
                    deferred.resolve();
                }).catch(function() {
                    // Just continue if error state achieved
                    deferred.resolve();
                });

            return deferred.promise;
        }.bind(this))
        .then(function() {
            return getInstancesFromDb(this.storageClient);
        }.bind(this))
        .then(function(registeredInstances) {
            logger.silly('getInstancesFromDb result:', registeredInstances);

            // Only report instances that are master and/or that Azure also knows about
            var registeredInstanceIds = Object.keys(registeredInstances);
            var providerVisible;
            var instanceId;
            var instance;
            var i;

            var isValidInstance = function(instanceId, instance) {
                return (
                    azureInstanceIds.indexOf(instanceId) !== -1 ||
                    (instance.isMaster && !this.isInstanceExpired(instance))
                );
            };

            for (i = 0; i < registeredInstanceIds.length; ++i) {
                instanceId = registeredInstanceIds[i];
                instance = registeredInstances[instanceId];

                if (isValidInstance.call(this, instanceId, instance)) {
                    if (!instances[instanceId]) {
                        providerVisible = false;
                    }
                    else {
                        // We have an updated providerVisible status from above,
                        // so use it
                        providerVisible = instances[instanceId].providerVisible;
                    }
                    instances[instanceId] = instance;
                    instances[instanceId].providerVisible = providerVisible;
                }
                else {
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
            return (this.clOptions.password ? q(this.clOptions.password) : cloudUtil.getDataFromUrl(this.clOptions.passwordUrl));
        }.bind(this))
        .then(function(data) {

            var bigIpPassword = data;

            // If we don't already have the hostname for this instance, get it
            Object.keys(instances).forEach(function(instanceId) {
                if (!instances[instanceId].hostname) {
                    logger.silly('No hostname for instance', instanceId);
                    bigIp = new BigIp({loggerOptions: this.loggerOptions});
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
            }.bind(this));

            return q.all(initPromises);

        }.bind(this))
        .then(function() {
            var deferred = q.defer();

            for (i = 0; i < bigIps.length; ++i) {
                hostnamePromises.push(bigIps[i].list('/tm/sys/global-settings', null, cloudUtil.SHORT_RETRY));
            }

            // Don't fall into catch at the end of this routine. Just
            // don't fill in the hostnames if we can't get them in a reasonable
            // amount of time.
            q.all(hostnamePromises)
                .then(function(responses) {
                    deferred.resolve(responses);
                })
                .catch(function() {
                    deferred.resolve([]);
                });

            return deferred.promise;
        }.bind(this))
        .then(function(responses) {
            for (i = 0; i < responses.length; ++i) {
                instances[bigIps[i].azureInstanceId].hostname = responses[i].hostname;
            }

            logger.debug('Deleting non-masters that are not known to Azure', idsToDelete);
            return deleteInstancesFromDb(this.storageClient, idsToDelete, {noWait: true});
        }.bind(this))
        .then(function() {
            deferred.resolve(instances);
        })
        .catch(function(err) {
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
AzureAutoscaleProvider.prototype.getNicsByTag = function(tag) {
    var deferred = q.defer();
    var promises = [];
    var nics = [];

    if (!tag || !tag.key || !tag.value) {
        deferred.reject(new Error('Tag with key and value must be provided'));
        return deferred.promise;
    }

    promises.push(getNetworkInterfaces(this.networkClient, this.resourceGroup, tag));
    promises.push(getVmScaleSets(this.computeClient, this.networkClient, this.resourceGroup, tag));

    q.all(promises)
    .then(function(results) {
        results.forEach(function(result) {
            result.forEach(function(nic) {
                nics.push(nic);
            });
        });
        deferred.resolve(nics);
    }.bind(this))
    .catch(function(err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

/**
* Searches for VMs that have a given tag.
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
*                       id: instance ID,
*                       ip: {
*                           public: public IP (or first public IP on the first NIC),
*                           private: private IP (or first private IP on the first NIC)
*                       }
*                   }
*/
AzureAutoscaleProvider.prototype.getVmsByTag = function(tag) {
    var deferred = q.defer();
    var promises = [];
    var vms = [];

    if (!tag || !tag.key || !tag.value) {
        deferred.reject(new Error('Tag with key and value must be provided'));
        return deferred.promise;
    }

    promises.push(getVms(this.computeClient, this.networkClient, this.resourceGroup, tag));
    promises.push(getVmScaleSets(this.computeClient, this.networkClient, this.resourceGroup, tag));

    q.all(promises)
    .then(function(results) {
        results.forEach(function(result) {
            result.forEach(function(vm) {
                vms.push(vm);
            });
        });
        deferred.resolve(vms);
    }.bind(this))
    .catch(function(err) {
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
AzureAutoscaleProvider.prototype.electMaster = function(instances) {
    var instanceIds = Object.keys(instances);
    var masterId =  Number.MAX_SAFE_INTEGER;
    var masterFound = false;

    if (instanceIds.length === 0) {
        return q.reject(new Error('No instances'));
    }

    instanceIds.forEach(function(instanceId) {
        if (instances[instanceId].providerVisible && instanceId < masterId) {
            masterId = instanceId;
            masterFound = true;
        }
    });

    if (masterFound) {
        return q(masterId);
    }
    else {
        return q.reject(new Error('No possible master found'));
    }
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
AzureAutoscaleProvider.prototype.getMasterCredentials = function() {
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
AzureAutoscaleProvider.prototype.isValidMaster = function(instanceId, instances) {
    var possibleMaster = instances[instanceId];
    var bigIp;

    logger.silly('isValidMaster', instanceId, instances);

    // get the password for this scale set
    return (this.clOptions.password ? q(this.clOptions.password) : cloudUtil.getDataFromUrl(this.clOptions.passwordUrl))
        .then(function(bigIpPassword) {
            // Compare instance's hostname to our hostname
            bigIp = new BigIp({loggerOptions: this.loggerOptions});
            return bigIp.init(
                possibleMaster.privateIp,
                this.clOptions.user,
                bigIpPassword,
                {
                    port: this.clOptions.port,
                    passwordEncrypted: this.clOptions.passwordEncrypted
                }
            );
        }.bind(this))
        .then(function() {
            return bigIp.list('/tm/sys/global-settings', null, cloudUtil.SHORT_RETRY);
        }.bind(this))
        .then(function(response) {
            var actualHostname = response.hostname;
            var isValid = true;

            logger.silly('possibleMaster.hostname:', possibleMaster.hostname, ', actualHostname:', actualHostname);
            if (possibleMaster.hostname !== actualHostname) {
                logger.debug("Master not valid: hostname of possible master (", possibleMaster.hostname, ") does not actual hostname (", actualHostname, ")");
                isValid = false;
            }

            return isValid;
        }.bind(this));
};

/**
 * Called when a master has been elected
 *
 * @param {String} masterId - Instance ID that was elected master.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
AzureAutoscaleProvider.prototype.masterElected = function(instanceId) {

    // Find other instance in the db that are marked as master, and mark them as non-master
    return getInstancesFromDb(this.storageClient)
        .then(function(registeredInstances) {
            var registeredInstanceIds = Object.keys(registeredInstances);
            var promises = [];
            var instance;

            registeredInstanceIds.forEach(function(registeredId) {
                instance = registeredInstances[registeredId];
                if (registeredId !== instanceId && instance.isMaster) {
                    instance.isMaster = false;
                    promises.push(this.putInstance(registeredId, instance));
                }
            }.bind(this));

            // Note: we are not returning the promise here - no need to wait for this to complete
            q.all(promises);
        }.bind(this));
};

/**
* Called to get check for and retrieve a stored UCS file
*
* @returns {Promise} A promise which will be resolved with a Buffer containing
*                    the UCS data if it is present, resolved with undefined if not
*                    found, or rejected if an error occurs.
*/
AzureAutoscaleProvider.prototype.getStoredUcs = function() {
    var deferred = q.defer();

    this.storageClient.listBlobsSegmented(BACKUP_CONTAINER, null, null, function(err, result) {
        if (err) {
            this.logger.warn('listBlobsSegmented failed:', err);
            deferred.reject(err);
            return;
        }

        var newestDate = new Date(1970, 1, 1);
        var newest;
        var currentDate;
        var blobStream;

        result.entries.forEach(function(entry) {
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
        }
        else {
            this.logger.debug('No UCS found in storage account');
            deferred.resolve();
        }
    }.bind(this));

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
AzureAutoscaleProvider.prototype.putInstance = function(instanceId, instance) {
    logger.silly('putInstance:', instanceId, instance);
    instance.lastUpdate = new Date();
    return putJsonObject(this.storageClient, INSTANCES_CONTAINER, instanceId, instance);
};

var getInstanceMetadata = function() {
    return cloudUtil.getDataFromUrl(
        'http://169.254.169.254/metadata/instance?api-version=2017-04-02',
        {
            headers: {
                Metadata: true
            }
        })
        .then(function(metaData) {
            return metaData;
        });
};

var getVmScaleSets = function(computeClient, networkClient, resourceGroup, tag) {
    var deferred = q.defer();
    var promises = [];

    computeClient.virtualMachineScaleSets.list(resourceGroup, function(err, results) {
        var scaleSetName;

        if (err) {
            deferred.reject(err);
            return;
        }

        logger.silly('virtualMachineScaleSets.list results:', results);

        results.forEach(function(result) {
            if (result.tags && result.tags[tag.key] && result.tags[tag.key] === tag.value) {
                scaleSetName = result.name;
                promises.push(getScaleSetNetworkPrimaryInterfaces(networkClient, resourceGroup, scaleSetName));
            }
        }.bind(this));

        q.all(promises)
        .then(function(results) {
            var nics = [];
            results.forEach(function(result) {
                result.forEach(function(nic) {
                    nics.push(nic);
                });
            });
            deferred.resolve(nics);
        }.bind(this))
        .catch(function(err) {
            deferred.reject(err);
        });
    }.bind(this));

    return deferred.promise;
};

var getVms = function(computeClient, networkClient, resourceGroup, tag) {
    var deferred = q.defer();
    var vmName;
    var nicName;
    var promises = [];

    computeClient.virtualMachines.list(resourceGroup, function(err, results) {

        if (err) {
            deferred.reject(err);
            return;
        }

        logger.silly('virtualMachines.list results:', results);

        results.forEach(function(result) {
            vmName = result.name;

            if (result.networkProfile && result.tags && result.tags[tag.key] && result.tags[tag.key] === tag.value) {
                result.networkProfile.networkInterfaces.forEach(function(networkInterface) {
                    if (!networkInterface.hasOwnProperty('primary') || networkInterface.primary === true) {
                        nicName = networkInterface.id.split('/')[8];
                        promises.push(getNetworkInterface(networkClient, resourceGroup, nicName));
                    }
                }.bind(this));
            }
        }.bind(this));

        q.all(promises)
        .then(function(results) {
            deferred.resolve(results);
        }.bind(this))
        .catch(function(err) {
            deferred.reject(err);
        });
    }.bind(this));

    return deferred.promise;
};

/**
 * Gets all VMs in a scale set
 *
 * @param {Object}    computeClient    - Azure compute instance
 * @param {String}    resourceGroup    - Name of the resource group the scale set is in
 * @param {String}    scaleSetName     - Name of the scale set
 *
 * @returns {Promise} Promise which will be resolved with a dictionary of VMs keyed by the instance ID
 */
var getScaleSetVms = function(computeClient, resourceGroup, scaleSetName) {
    var deferred = q.defer();
    var vms = {};

    computeClient.virtualMachineScaleSetVMs.list(resourceGroup, scaleSetName, function(err, results) {
        if (err) {
            console.log(err);
            deferred.reject(err);
        }
        else {
            logger.silly('virtualMachineScaleSetVMs.list results:', results);
            results.forEach(function(vm) {
                vms[vm.instanceId] = vm;
            });
            deferred.resolve(vms);
        }
    });

    return deferred.promise;
};

/**
 * Gets all Instance View for a VM in a Scale Set
 *
 * @param {Object}    computeClient    - Azure compute instance
 * @param {String}    resourceGroup    - Name of the resource group the scale set is in
 * @param {String}    scaleSetName     - Name of the scale set
 * @param {String}    instanceId       - Scale set instance Id
 *
 * @returns {Promise} Promise which will be resolved with a dictionary of items returned from the instance view
 */
var getScaleSetVmsInstanceView = function(computeClient, resourceGroup, scaleSetName, instanceId) {
    var deferred = q.defer();

    computeClient.virtualMachineScaleSetVMs.getInstanceView(resourceGroup, scaleSetName, instanceId, function(err, results) {
        if (err) {
            logger.error('virtualMachineScaleSetVMs.getInstanceView error:', err);
            deferred.reject(err);
        }
        else {
            results.instanceId = instanceId;
            logger.silly('virtualMachineScaleSetVMs.getInstanceView results:', results);
            deferred.resolve(results);
        }
    });

    return deferred.promise;
};

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
var getScaleSetNetworkInterfaces = function(networkClient, resourceGroup, scaleSetName) {
    var deferred = q.defer();

    networkClient.networkInterfaces.listVirtualMachineScaleSetNetworkInterfaces(resourceGroup, scaleSetName, function(err, results) {
        if (err) {
            deferred.reject(err);
        }
        else {
            logger.silly('networkInterfaces.listVirtualMachineScaleSetNetworkInterfaces result:', results);
            deferred.resolve(results);
        }
    });

    return deferred.promise;
};

var getScaleSetNetworkPrimaryInterfaces = function(networkClient, resourceGroup, scaleSetName) {
    var deferred = q.defer();
    var nic;
    var nics = [];
    var nicId;
    var vmId;

    getScaleSetNetworkInterfaces(networkClient, resourceGroup, scaleSetName)
        .then(function(results) {
            results.forEach(function(result) {
                if (result.primary === true) {
                    result.ipConfigurations.forEach(function(ipConfiguration) {
                        if (ipConfiguration.primary === true) {
                            vmId = result.id.split('/')[10];
                            nicId = resourceGroup + '-' + scaleSetName + vmId;
                            nic = {
                                id: nicId,
                                ip: {
                                    private: ipConfiguration.privateIPAddress
                                }
                            };
                            nics.push(nic);
                        }
                    }.bind(this));
                }
            }.bind(this));

            deferred.resolve(nics);
        }.bind(this));

    return deferred.promise;
};

var getNetworkInterfaces = function(networkClient, resourceGroup, tag) {
    var deferred = q.defer();
    var promises = [];

    networkClient.networkInterfaces.list(resourceGroup, function(err, results) {

        if (err) {
            deferred.reject(err);
            return;
        }

        logger.silly('networkInterfaces.list results:', results);

        results.forEach(function(result) {
            var nicName;

            nicName = result.name;

            if (result.primary === true && result.tags && result.tags[tag.key] && result.tags[tag.key] === tag.value) {
                promises.push(getNetworkInterface(networkClient, resourceGroup, nicName));
            }
        }.bind(this));

        q.all(promises)
        .then(function(results) {
            deferred.resolve(results);
        }.bind(this))
        .catch(function(err) {
            deferred.reject(err);
        });
    }.bind(this));

    return deferred.promise;
};

var getNetworkInterface = function(networkClient, resourceGroup, nicName) {
    var deferred = q.defer();
    var nic;
    var nicId;

    networkClient.networkInterfaces.get(resourceGroup, nicName, function(err, result) {
        if (err) {
            deferred.reject(err);
            return;
        }

        logger.silly('networkInterfaces.get result:', result);

        resourceGroup = result.id.split('/')[4];
        nicName = result.name;
        nicId = resourceGroup + '-' + nicName;

        result.ipConfigurations.forEach(function(ipConfiguration) {
            if (ipConfiguration.primary === true) {
                nic = {
                    id: nicId,
                    ip: {
                        private: ipConfiguration.privateIPAddress
                    }
                };

                if (ipConfiguration.publicIPAddress) {
                    getPublicIp(networkClient, resourceGroup, nicId, ipConfiguration.publicIPAddress)
                    .then(function(result) {
                        nic.ip.public = result.ip;
                        deferred.resolve(nic);
                    }.bind(this))
                    .catch(function(err) {
                        deferred.reject(err);
                    });
                }
                else {
                    deferred.resolve(nic);
                }
            }
        }.bind(this));
    }.bind(this));
    return deferred.promise;
};

var getPublicIp = function(networkClient, resourceGroup, id, publicIPAddress) {
    var deferred = q.defer();
    var publicIpName = publicIPAddress.id.split('/')[8];

    networkClient.publicIPAddresses.get(resourceGroup, publicIpName, function(err, result) {
        if (err) {
            deferred.reject(err);
            return;
        }

        deferred.resolve(
        {
            id: id,
            ip: result.ipAddress
        }
        );
    }.bind(this));
    return deferred.promise;
};

var getInstanceIdFromVms = function(vms, vmId) {
    var vm;

    // Azure VM IDs are returned with different cases from different APIs
    vmId = vmId.toLowerCase();

    for (vm in vms) {
        if (vms[vm].id.toLowerCase() === vmId) {
            return vms[vm].instanceId;
        }
    }
};

/**
 * Gets our view of the current instances
 *
 * @param {Object} storageClient - Azure storage instance
 *
 * @returns {Object} Object containing a dictionary of instances keyed by Instance IDs
 */
var getInstancesFromDb = function(storageClient) {
    var deferred = q.defer();

    storageClient.listBlobsSegmented(INSTANCES_CONTAINER, null, null, function(err, result) {
        var promises = [];
        var instanceIds = [];

        if (err) {
            deferred.reject(err);
        }
        else {
            logger.silly("listBlobsSegmented data:", result);
            result.entries.forEach(function(entry) {
                instanceIds.push(entry.name);
                promises.push(getJsonObject(storageClient, INSTANCES_CONTAINER, entry.name));
            });

            q.all(promises)
                .then(function(dbInstances) {
                    var instances = {};
                    dbInstances.forEach(function(instance, index) {
                        instances[instanceIds[index]] = instance;
                    });
                    deferred.resolve(instances);
                })
                .catch(function(err) {
                    deferred.reject(err);
                });
        }
    });

    return deferred.promise;
};

/**
 * Generic Azure storage deleteObject
 *
 * @param {Object}    storageClient    - Azure storage instance
 * @param {String[]}  idsToDelete      - Array of IDs to delete
 * @param {Object}    [options]        - Optional parameters
 * @param {Boolean}   [options.noWait] - Whether or not to wait for completion before returning. Default is to wait.
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 */
var deleteInstancesFromDb = function(storageClient, idsToDelete, options) {

    var promises = [];

    options = options || {};

    if (idsToDelete.length > 0) {
        idsToDelete.forEach(function(id) {
            promises.push(deleteObject(storageClient, INSTANCES_CONTAINER, id));
        });

        if (options.noWait) {
            q.all(promises);
            return q();
        }
        else {
            return q.all(promises);
        }
    }
    else {
        return q();
    }
};

/**
 * Creates empty containers
 *
 * @param {Object}    storageClient    - Azure storage instance
 * @param {Object[]}  containers       - Array of container names to create
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 */
var createContainers = function(storageClient, containers) {

    var promises = [];

    var createContainer = function(container) {
        var deferred = q.defer();

        storageClient.createContainerIfNotExists(container, function(err) {
            if (err) {
                logger.warn(err);
                deferred.reject(err);
            }
            else {
                deferred.resolve();
            }
        });

        return deferred.promise;
    };

    containers.forEach(function(container) {
        promises.push(createContainer(container));
    });

    return q.all(promises);
};

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
var putJsonObject = function(storageClient, container, name, data) {
    var deferred = q.defer();

    var jsonData = JSON.stringify(data);

    storageClient.createBlockBlobFromText(container, name, jsonData, function(err) {
        if (err) {
            deferred.reject(err);
        }
        else {
            deferred.resolve();
        }
    });

    return deferred.promise;
};

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
var getJsonObject = function(storageClient, container, name) {
        var deferred = q.defer();

        storageClient.getBlobToText(container, name, function(err, data) {
            if (err) {
                logger.debug('error from getBlobToText:', err);
                deferred.reject(err);
            }
            else {
                try {
                    logger.silly('getBlobToText result:', data);
                    deferred.resolve(JSON.parse(data));
                }
                catch (err) {
                    deferred.reject(err);
                }
            }
        });

        return deferred.promise;
};

var deleteObject = function(storageClient, container, name) {
    var deferred = q.defer();

    storageClient.deleteBlobIfExists(container, name, function(err) {
        if (err) {
            deferred.reject(err);
        }
        else {
            deferred.resolve();
        }
    });

    return deferred.promise;
};

module.exports = AzureAutoscaleProvider;