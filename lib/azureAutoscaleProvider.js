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
var ComputeManagementClient = require('azure-arm-compute');
var NetworkManagementClient = require('azure-arm-network');

var AbstractAutoscaleProvider;
var cloudUtil;

// In production we should be installed as a node_module under f5-cloud-libs
// In test, that will not be the case, so use our dev dependency version
// of f5-cloud-libs
try {
    AbstractAutoscaleProvider = require('../../../../f5-cloud-libs').autoscaleProvider;
    cloudUtil = require('../../../../f5-cloud-libs').util;
}
catch (err) {
    AbstractAutoscaleProvider = require('f5-cloud-libs').autoscaleProvider;
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
 * @param {Object} providerOptions                 - Provider specific options.
 * @param {String} providerOptions.credentialsUrl  - URL to file or location with credentials
 *     File/location should contain JSON object with the following:
 *         {
 *             clientId:       Azure client ID
 *             tenantId:       Azure tenant ID
 *             secret:         Azure secret
 *         }
 * @param {String} providerOptions.subscriptionId  - Subscription ID.
 * @param {String} providerOptions.resourceGroup   - Resoource group name.
 * @param {String} providerOptions.scaleSet        - Scale set name.
 *
 * @returns {Promise} A promise which will be resolved when init is complete.
 */
AzureAutoscaleProvider.prototype.init = function(providerOptions) {
    var deferred = q.defer();
    this.scaleSet = providerOptions.scaleSet;
    cloudUtil.getDataFromUrl(providerOptions.credentialsUrl)
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
                    this.computeClient = new ComputeManagementClient(credentials, providerOptions.subscriptionId);
                    this.networkClient = new NetworkManagementClient(credentials, providerOptions.subscriptionId);
                    this.resourceGroup = providerOptions.resourceGroup;
                    deferred.resolve();
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
    this.computeClient.virtualMachineScaleSets.getInstanceView(this.resourceGroup, this.scaleSet, function(err, result) {
        if (err) {
            deferred.reject(err);
            return;
        }
        deferred.resolve(result);
    });

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
    throw new Error("Unimplemented abstract method AutoscaleProvider.getInstances");
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
    throw new Error("Unimplemented abstract method AutoscaleProvider.electMaster", instances);
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
 * @abstract
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
AzureAutoscaleProvider.prototype.getMasterCredentials = function(mgmtIp, mgmtPort) {
    throw new Error("Unimplemented abstract method AutoscaleProvider.getMasterCredentials", mgmtIp, mgmtPort);
};

/**
 * Called to store master credentials
 *
 * When joining a cluster we need the username and password for the
 * master instance. This method is called to tell us that we are
 * the master and we should store our credentials if we need to store
 * them for later retrieval in getMasterCredentials.
 *
 * @returns {Promise} A promise which will be resolved when the operation
 *                    is complete
 */
AzureAutoscaleProvider.prototype.putMasterCredentials = function() {
    this.logger.debug("No override for AutoscaleProvider.putMasterCredentials");
    return q(true);
};

/**
 * Elects a new master instance from the available instances
 *
 * @abstract
 *
 * @param {Object} instances - Dictionary of instances as returned by getInstances
 *
 * @returns {Promise} A promise which will be resolved with a boolean indicating
 *                    wether or not the given instanceId is a valid master.
 */
AzureAutoscaleProvider.prototype.isValidMaster = function(instanceId) {
    this.logger.debug("No override for AutoscaleProvider.isValidMaster", instanceId);
    return q(true);
};

/**
 * Called when a master has been elected
 *
 * In some cloud environments, information about the master needs to be
 * stored in persistent storage. Override this method if implementing
 * such a cloud provider.
 *
 * @param {String} instanceId - Instance ID to validate as a valid master.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
AzureAutoscaleProvider.prototype.masterElected = function(instanceId) {
    this.logger.debug("No override for AutoscaleProvider.masterElected", instanceId);
    return q();
};

/**
 * Saves instance info
 *
 * When joining a cluster we need the username and password for the
 * master instance.
 *
 * @param {Object} Instance information as returned by getInstances.
 *
 * @returns {Promise} A promise which will be resolved with instance info.
 */
AzureAutoscaleProvider.prototype.putInstance = function(instance) {
    this.logger.debug("No override for AutoscaleProvider.putInstance", instance);
    return q();
};

/**
 * Turns on instance protection for the given instance ID
 *
 * @param {String} mgmtIp - Management IP of master
 * @param {String} port - Managemtn port of master
 *
 * @param {String} [instanceId] - Instance ID of instnace to protect. Default instance ID of self.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
AzureAutoscaleProvider.prototype.setInstanceProtection = function(instanceId) {
    this.logger.debug("No override for AutoscaleProvider.setInstanceProtection", instanceId);
    return q();
};

/**
 * Called to get check for and retrieve a stored UCS file
 *
 * @param {String} [instanceId] - Instance ID of instnace to un-protect. Default instance ID of self.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
AzureAutoscaleProvider.prototype.unsetInstanceProtection = function(instanceId) {
    this.logger.debug("No override for AutoscaleProvider.unsetInstanceProtection", instanceId);
    return q();
};

module.exports = AzureAutoscaleProvider;