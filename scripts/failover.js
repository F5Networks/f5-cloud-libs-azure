#!/usr/bin/env node

/**
 * Copyright 2019 F5 Networks, Inc.
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

const parser = require('commander');
const q = require('q');
const http = require('http');
const msRestAzure = require('ms-rest-azure');
const NetworkManagementClient = require('azure-arm-network');
const azureEnvironment = require('ms-rest-azure/lib/azureEnvironment');
const f5CloudLibs = require('@f5devcentral/f5-cloud-libs');

const util = f5CloudLibs.util;
const Logger = f5CloudLibs.logger;
const BigIp = f5CloudLibs.bigIp;

// Initialize global vars
const METADATA_SERVER = '169.254.169.254';
const primaryState = 'PRIMARY';
const secondaryState = 'SECONDARY';
const associateArr = [];
const disassociateArr = [];
const optionsForTest = {};

let loggerOptions;
let logger;
let vmInstanceInfo;
let tagKey;
let tagValue;
let networkInterfaceToDissociate;
let bigIqPasswordData;
let networkInterfaceToAssociate;

(function run() {
    const runner = {
        /**
         * Runs the failover script
         * @param {String[]}    argv - The process arguments
         * @param {Object}      testOpts - Options used during testing
         * @param {Object}      testOpts.bigIp - BigIp object to use for testing
         * @param {Function}    cb - Optional cb for call when done
         */
        run(argv, testOpts, cb) {
            // Parse command line arguments
            /* eslint-disable max-len */
            parser
                .version('1.0.0')
                .option('--log-level [type]', 'Specify the log level', 'info')
                .option('--log-file [type]', 'Specify the log file location', '/var/log/cloud/azure/failover.log')
                .option('--tag-key [type]', 'Specify the key for the tag', 'f5_deployment')
                .option('--tag-value [type]', 'Specify the value of the tag', '')
                .option('--dissociate-intf [type]', 'Specify the Allocation ID of the Virtual IP address', '')
                .option('--associate-intf [type]', 'Specify the name of the network interface to associate to', '')
                .option('--password-data [type]', 'Specify admin password for Azure', '')
                .parse(argv);
            /* eslint-enable max-len */

            Object.assign(optionsForTest, testOpts);

            loggerOptions = { logLevel: parser.logLevel, fileName: parser.logFile, console: true };
            logger = optionsForTest.logger || Logger.getLogger(loggerOptions);

            tagKey = parser.tagKey;
            tagValue = parser.tagValue;
            networkInterfaceToDissociate = parser.dissociateIntf;
            bigIqPasswordData = parser.passwordData;
            networkInterfaceToAssociate = parser.associateIntf;

            let bigIp;

            try {
                q()
                    .then(() => {
                        bigIp = optionsForTest.bigIp || new BigIp({ loggerOptions });
                        return bigIp.init(
                            'localhost',
                            'admin',
                            bigIqPasswordData,
                            {
                                port: '443'
                            }
                        );
                    })
                    .then(() => {
                        return getFailoverStatus.call(this, bigIp);
                    })
                    .then((status) => {
                        logger.info(`Failover state: ${status}`);
                        if (status === primaryState) {
                            logger.info('Performing failover');
                            return failover.call(this);
                        }
                        logger.info(`No need to perform failover for ${secondaryState} device`);
                        return q();
                    })
                    .catch((error) => {
                        logger.error(`Failover failed: ${error}`);
                    })
                    .done(() => {
                        if (cb) {
                            cb();
                        }
                    });
            } catch (err) {
                if (logger) {
                    logger.error('Failover script error:', err);
                }

                if (cb) {
                    cb();
                }
            }
        }
    };

    /**
     * Determine failover state
     *
     * @return {Promise} A promise which is resolved upon PRIMARY state of the current instance is determined
     */
    function getFailoverStatus(bigIp) {
        const deferred = q.defer();
        bigIp.list('/shared/failover-state')
            .then((results) => {
                if (results !== undefined) {
                    const failoverStatus = results.nodeRole;
                    deferred.resolve(failoverStatus);
                } else {
                    const errorMessage = 'Fail to retrieve failover-status';
                    logger.error(errorMessage);
                    deferred.reject(new Error(errorMessage));
                }
            })
            .catch((err) => {
                logger.info(`Error getting failover state: ${err}`);
                deferred.reject(err);
            });
        return deferred.promise;
    }

    /**
     * Retrieve instance information of the running Virtual Machine
     *
     * @return {Promise} A promise which is resolved upon instance information is retrieved
     */
    function getInstanceVMInformation() {
        const deferred = q.defer();
        const apiVersion = '2017-12-01';

        http.get({
            host: METADATA_SERVER,
            path: `/metadata/instance?api-version=${apiVersion}`,
            headers: { Metadata: 'True' }
        }, (response) => {
            const statusCode = response.statusCode;
            if (statusCode !== 200) {
                const errorMessage = 'Fail to retrieve metadata information';
                logger.error(errorMessage);
                deferred.reject(new Error(errorMessage));
            } else {
                let body = '';
                response.on('data', (data) => {
                    body += data;
                });
                response.on('end', () => {
                    vmInstanceInfo = JSON.parse(body);
                    deferred.resolve();
                });
            }
        });
        return deferred.promise;
    }

    /**
     * Config Azure network management via Managed Identity Service
     *
     * @return {Promise} A promise which is resolved upon Azure configuration completion
     */
    function configureAzure() {
        const option = {
            resource: 'https://management.azure.com',
            msiApiVersion: '2018-02-01'
        };

        const credentials = new msRestAzure.MSIVmTokenCredentials(option);
        const environment = azureEnvironment.Azure;


        this.networkClient = optionsForTest.networkClient || new NetworkManagementClient(
            credentials,
            this.subscriptionId,
            environment.resourceManagerEndpointUrl
        );

        return q.resolve();
    }

    /**
     * Get virtual IP address based on tag
     *
     * @returns {Promise} A promise which is resolved upon tag information is retrieved
     */
    function getVirtualIPAddress() {
        const deferred = q.defer();
        this.networkClient.publicIPAddresses.list(
            vmInstanceInfo.compute.resourceGroupName, (error, ipAddresses) => {
                if (error) {
                    deferred.reject(error);
                } else {
                    const virtualPublicIP = ipAddresses.filter((ipAddr) => {
                        return ipAddr.tags[tagKey] !== undefined && ipAddr.tags[tagKey] === tagValue;
                    });
                    deferred.resolve(virtualPublicIP[0]);
                }
            }
        );
        return deferred.promise;
    }

    /**
     *  Construct parameters to move virtual public IP address
     */
    function constructNicParameters(virtualPublicIP) {
        const deferred = q.defer();

        const matchedAddress = [];
        vmInstanceInfo.network.interface.forEach((iface) => {
            iface.ipv4.ipAddress.forEach((address) => {
                if (address.publicIpAddress && address.publicIpAddress === virtualPublicIP.ipAddress) {
                    matchedAddress.push(address);
                }
            });
        });
        if (Array.isArray(matchedAddress) && (matchedAddress.length === 0)) {
            logger.info('Moving virtual Public IP address');
            // Virtual IP does not belong to current virtual machine instance, need to move it
            // Retrieve information of their network interface and our network interface
            let theirNicParams;
            let ourNicParams;
            this.networkClient.networkInterfaces.get(vmInstanceInfo.compute.resourceGroupName,
                networkInterfaceToDissociate, (theirError, theirNicData) => {
                    theirNicParams = theirNicData;
                    let objIndex = theirNicParams.ipConfigurations.findIndex(
                        (obj) => {
                            return obj.primary === false;
                        }
                    );
                    // Dissociate virtual IP address
                    delete theirNicParams.ipConfigurations[objIndex].publicIPAddress;

                    this.networkClient.networkInterfaces.get(vmInstanceInfo.compute.resourceGroupName,
                        networkInterfaceToAssociate, (ourError, ourNicData) => {
                            ourNicParams = ourNicData;
                            objIndex = ourNicParams.ipConfigurations.findIndex(
                                (obj) => {
                                    return obj.primary === false;
                                }
                            );
                            ourNicParams.ipConfigurations[objIndex].publicIPAddress = {
                                id: virtualPublicIP.id
                            };

                            disassociateArr.push(
                                [
                                    this.networkClient,
                                    vmInstanceInfo.compute.resourceGroupName,
                                    theirNicData.name,
                                    theirNicParams,
                                    'Dissociate'
                                ]
                            );
                            associateArr.push(
                                [
                                    this.networkClient,
                                    vmInstanceInfo.compute.resourceGroupName,
                                    ourNicParams.name,
                                    ourNicParams,
                                    'Associate'
                                ]
                            );
                            this.associateRequired = true;
                            deferred.resolve();
                        });
                });
        } else {
            logger.info(`${primaryState} device already has virtual IP address. ` +
                'No need to move virtual IP address.');
            deferred.resolve();
        }
        return deferred.promise;
    }

    /**
     *  Move virtual public IP address
     */
    function moveVirtualIPAddress() {
        // Helper function to move IP address
        const updateNics = function (netClient, group, nicName, nicParams, action) {
            const deferred = q.defer();
            logger.info(action, 'NIC: ', nicName);
            netClient.networkInterfaces.createOrUpdate(group, nicName, nicParams, (error, data) => {
                if (error) {
                    logger.error(action, 'NIC error: ', error);
                    deferred.reject(error);
                }
                logger.info(action, 'NIC successful: ', nicName);
                deferred.resolve(data);
            });
            return deferred.promise;
        };

        const deferred = q.defer();
        if (this.associateRequired) {
            const disassociatePromises = [];
            disassociateArr.forEach((nicData) => {
                disassociatePromises.push(
                    util.tryUntil(this, { maxRetries: 4, retryIntervalMs: 15000 }, updateNics, nicData)
                );
            });

            q.all(disassociatePromises)
                .then(() => {
                    logger.info('Dissociate  Virtual Public IP successful.');
                    const associatePromises = [];
                    associateArr.forEach((nicData) => {
                        associatePromises.push(
                            util.tryUntil(this,
                                { maxRetries: 4, retryIntervalMs: 15000 }, updateNics, nicData)
                        );
                    });
                    return q.all(associatePromises);
                })
                .then(() => {
                    logger.info('Associate  Virtual Public IP successful.');
                    deferred.resolve();
                })
                .catch((error) => {
                    logger.error('Fail to move virtual IP address. Error: ', error);
                    deferred.reject(error);
                });
        } else {
            logger.info(`${primaryState} device already has virtual IP address. Floating is not required.`);
            deferred.resolve();
        }

        return deferred.promise;
    }

    /**
     * Initialize Azure resources
     *
     * @return {Promise} A promise which is resolved upon initialization completion
     *
     */
    function init() {
        const deferred = q.defer();
        getInstanceVMInformation()
            .then(() => {
                this.subscriptionId = vmInstanceInfo.compute.subscriptionId;
                return configureAzure.call(this);
            })
            .then(() => {
                deferred.resolve();
            })
            .catch((err) => {
                logger.error(`Failed to initialize Azure configuration: ${err}`);
                deferred.reject();
            });
        return deferred.promise;
    }

    /**
      * Perform failover
      *
      */
    function failover() {
        this.associateRequired = false;
        return init.call(this)
            .then(() => {
                logger.info('Retrieving Virtual IP Address info');
                return getVirtualIPAddress.call(this);
            })
            .then((virtualIP) => {
                logger.info(`Construct NIC params to move VIP address ${virtualIP.ipAddress} if required.`);
                return constructNicParameters.call(this, virtualIP);
            })
            .then(() => {
                logger.info('Move Virtual IP address if required.');
                return moveVirtualIPAddress.call(this);
            })
            .catch((error) => {
                logger.info(`Failover failed: ${error}`);
            });
    }

    module.exports = runner;

    // If we're called from the command line, run
    // This allows for test code to call us as a module
    if (!module.parent) {
        runner.run(process.argv);
    }
}());
