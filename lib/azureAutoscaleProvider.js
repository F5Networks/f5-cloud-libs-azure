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

    this.logger.silly('providerOptions:', providerOptions);

    this.scaleSet = providerOptions.scaleSet;
    this.resourceGroup = providerOptions.resourceGroup;

    this.bigIp = new BigIp({loggerOptions: this.loggerOptions});
    this.bigIp.init(
        'localhost',
        this.clOptions.user,
        this.clOptions.password || this.clOptions.passwordUrl,
            {
                port: this.clOptions.port,
                passwordIsUrl: typeof this.clOptions.passwordUrl !== 'undefined'
            }
    )
    .then(function() {
        if (providerOptions.azCredentialsUrl) {
            return cloudUtil.getDataFromUrl(providerOptions.azCredentialsUrl);
        }
    })
    .then(function(data) {
        var jsonData;

        if (providerOptions.azCredentialsUrl) {
            jsonData = JSON.parse(data);
        }
        else {
            jsonData = providerOptions;
        }

        msRestAzure.loginWithServicePrincipalSecret(
            jsonData.clientId,
            jsonData.secret,
            jsonData.tenantId,
            function(err, credentials) {
                if (err) {
                    deferred.reject(err);
                    return;
                }
                this.networkClient = new NetworkManagementClient(credentials, jsonData.subscriptionId);
                this.computeClient = new ComputeManagementClient(credentials, jsonData.subscriptionId);
                if (jsonData.storageAccount && jsonData.storageKey) {
                    this.storageClient = azureStorage.createBlobService(jsonData.storageAccount, jsonData.storageKey);
                    this.storageClient.createContainerIfNotExists(BACKUP_CONTAINER, function(err) {
                        if (err) {
                            this.logger.warn(err);
                            deferred.reject(err);
                            return;
                        }
                        else {
                            deferred.resolve();
                        }
                    }.bind(this));
                }
                else {
                    deferred.resolve();
                }
            }.bind(this));
        }.bind(this))
    .catch(function(err) {
        deferred.reject(err);
    });

    return deferred.promise;
};

/**
* Gets the instance ID of this instance
*
* @returns {Promise} A promise which will be resolved with the instance ID of this instance
*                    or rejected if an error occurs;
*/
AzureAutoscaleProvider.prototype.getInstanceId = function() {
    var deferred = q.defer();
    var selfIp;

    if (!this.instanceId) {
        // Get our self ip
        this.bigIp.list('/tm/net/self')
        .then(function(response) {
            var instanceId;
            var instance;
            var i;

            this.logger.debug(response);

            selfIp = response[0].address.split('/')[0];

            // Get network info to match up w/ our self ip
            this.networkClient.networkInterfaces.listVirtualMachineScaleSetNetworkInterfaces(this.resourceGroup, this.scaleSet, function(err, result) {
                if (err) {
                    deferred.reject(err);
                    return;
                }
                for (instanceId in result) {
                    instance = result[instanceId];
                    for (i = 0; i < instance.ipConfigurations.length; ++i) {
                        if (selfIp === instance.ipConfigurations[i].privateIPAddress) {
                            this.instanceId = instanceId;
                            deferred.resolve(this.instanceId);
                            return;
                        }
                    }
                }

                // If our ip was not found, reject
                deferred.reject(new Error('Our self IP was not found in the list from Azure'));
            }.bind(this));
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
*                   }
*/
AzureAutoscaleProvider.prototype.getInstances = function() {
    var deferred = q.defer();
    var instances = {};
    var bigIps = [];
    var initPromises = [];
    var hostnamePromises = [];
    var bigIp;
    var bigIpPassword;
    var i;

    this.networkClient.networkInterfaces.listVirtualMachineScaleSetNetworkInterfaces(this.resourceGroup, this.scaleSet, function(err, result) {
        var instanceId;
        var privateIp;

        if (err) {
            deferred.reject(err);
            return;
        }

        // get the password for these instances
        (this.clOptions.password ? q(this.clOptions.password) : cloudUtil.getDataFromUrl(this.clOptions.passwordUrl))
        .then(function(data) {
            bigIpPassword = data;

            for (instanceId in result) {
                privateIp = result[instanceId].ipConfigurations[0].privateIPAddress;
                instances[instanceId] = {
                    mgmtIp: privateIp,
                    privateIp:privateIp
                };

                bigIp = new BigIp({loggerOptions: this.loggerOptions});
                bigIp.azureInstanceId = instanceId;
                bigIps.push(bigIp);
                initPromises.push(bigIp.init(
                privateIp,
                this.clOptions.user,
                bigIpPassword,
                {
                    port: this.clOptions.port
                }
                ));
            }

            return q.all(initPromises);
        }.bind(this))
        .then(function() {
            for (i = 0; i < bigIps.length; ++i) {
                hostnamePromises.push(bigIps[i].list('/tm/sys/global-settings'));
            }

            return q.all(hostnamePromises);
        })
        .then(function(responses) {
            for (i = 0; i < responses.length; ++i) {
                instances[bigIps[i].azureInstanceId].hostname = responses[i].hostname;
            }
            deferred.resolve(instances);
        })
        .catch(function(err) {
            deferred.reject(err);
        });

    }.bind(this));

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

    promises.push(listNetworkInterfaces(this.networkClient, this.resourceGroup, tag));
    promises.push(listVmScaleSets(this.computeClient, this.networkClient, this.resourceGroup, tag));

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

    promises.push(listVms(this.computeClient, this.networkClient, this.resourceGroup, tag));
    promises.push(listVmScaleSets(this.computeClient, this.networkClient, this.resourceGroup, tag));

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

    if (instanceIds.length === 0) {
        return q.reject(new Error('No instances'));
    }

    instanceIds.forEach(function(instanceId) {
        if (instanceId < masterId) {
            masterId = instanceId;
        }
    });

    return q(masterId);
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

var listVmScaleSets = function(computeClient, networkClient, resourceGroup, tag) {
    var deferred = q.defer();
    var promises = [];

    computeClient.virtualMachineScaleSets.list(resourceGroup, function(err, results) {
        var scaleSetName;

        if (err) {
            deferred.reject(err);
            return;
        }

        results.forEach(function(result) {
            if (result.tags && result.tags[tag.key] && result.tags[tag.key] === tag.value) {
                scaleSetName = result.name;
                promises.push(getScaleSetNetworkInterfaces(networkClient, resourceGroup, scaleSetName));
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

var listNetworkInterfaces = function(networkClient, resourceGroup, tag) {
    var deferred = q.defer();
    var promises = [];

    networkClient.networkInterfaces.list(resourceGroup, function(err, results) {

        if (err) {
            deferred.reject(err);
            return;
        }

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

var listVms = function(computeClient, networkClient, resourceGroup, tag) {
    var deferred = q.defer();
    var vmName;
    var nicName;
    var promises = [];

    computeClient.virtualMachines.list(resourceGroup, function(err, results) {

        if (err) {
            deferred.reject(err);
            return;
        }

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

var getScaleSetNetworkInterfaces = function(networkClient, resourceGroup, scaleSetName) {
    var deferred = q.defer();
    var nic;
    var nics = [];
    var nicId;
    var vmId;

    networkClient.networkInterfaces.listVirtualMachineScaleSetNetworkInterfaces(resourceGroup, scaleSetName, function(err, results) {
        if (err) {
            deferred.reject(err);
            return;
        }

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

var getNetworkInterface = function(networkClient, resourceGroup, nicName) {
    var deferred = q.defer();
    var nic;
    var nicId;

    networkClient.networkInterfaces.get(resourceGroup, nicName, function(err, result) {
        if (err) {
            deferred.reject(err);
            return;
        }

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

module.exports = AzureAutoscaleProvider;