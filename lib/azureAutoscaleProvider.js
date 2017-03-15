/**
 * Copyright 2016, 2017 F5 Networks, Inc.
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
var azureStorage = require('azure-storage');
var AbstractAutoscaleProvider;
var BigIp;
var cloudUtil;

const BACKUP_CONTAINER = "backup";

// In production we should be installed as a node_module under f5-cloud-libs
// In test, that will not be the case, so use our dev dependency version
// of f5-cloud-libs
try {
    AbstractAutoscaleProvider = require('../../../../f5-cloud-libs').autoscaleProvider;
    BigIp = require('../../../../f5-cloud-libs').bigIp;
    cloudUtil = require('../../../../f5-cloud-libs').util;
}
catch (err) {
    AbstractAutoscaleProvider = require('f5-cloud-libs').autoscaleProvider;
    BigIp = require('f5-cloud-libs').bigIp;
    cloudUtil = require('f5-cloud-libs').util;
}

util.inherits(AzureAutoscaleProvider, AbstractAutoscaleProvider);

/**
 * Constructor.
 * @class
 * @classdesc
 * Azure cloud provider implementation.
 *
 * @param {Ojbect} [options] - Options for the instance.
 * @param {Object} [options.clOptions] - Command line options if called from a script.
 * @param {Logger} [options.logger] - Logger to use. Default no logging.
 */
function AzureAutoscaleProvider(options) {
    AzureAutoscaleProvider.super_.call(this, options);
    options = options || {};
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
 *             subscriptionId: Azure subscription ID,
 *             storageHost:    Azure storage host
 *             storageSas:     Azure storage account SAS
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

    this.bigIp = new BigIp({logger: this.logger});
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
        return cloudUtil.getDataFromUrl(providerOptions.azCredentialsUrl);
    }.bind(this))
    .then(function(data) {
        var jsonData = JSON.parse(data);
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
                this.storageClient = azureStorage.createBlobServiceWithSas(providerOptions.storageHost, providerOptions.storageSas);
                this.storageClient.createContainerIfNotExists(BACKUP_CONTAINER, {publicAccessLevel: null}, function(err) {
                    if (err) {
                        this.logger.warn(err);
                        deferred.reject(err);
                        return;
                    }
                    else {
                        deferred.resolve();
                    }
                }.bind(this));
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

                    bigIp = new BigIp({logger: this.logger});
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

        var newest = {
            lastModified: new Date(1970, 1, 1)
        };
        var currentEntryDate;
        result.entries.forEach(function(entry) {
            if (entry.name.endsWith('.ucs')) {
                currentEntryDate = new Date(entry.lastModified);
                if (entry.lastModified > newest.lastModified) {
                    newest = entry;
                }
            }
        });

        if (newest.container) {
            this.storageClient.getBlobToStream(BACKUP_CONTAINER, newest, writeStream, null, function(err) {
                if (err) {
                    this.logger.warn('getBlobToStream failed:', err);
                    deferred.reject(err);
                    return;
                }

            }.bind(this));
        }
        else {
            this.logger.debug('No UCS found in storage account');
        }
    }.bind(this));
    // look for newest
    // get it and return data

    return deferred.promise;
};

module.exports = AzureAutoscaleProvider;
