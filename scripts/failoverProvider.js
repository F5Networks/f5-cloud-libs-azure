#!/usr/bin/env node

'use strict';

const options = require('commander');
const fs = require('fs');
const q = require('q');
const msRestAzure = require('ms-rest-azure');
const NetworkManagementClient = require('azure-arm-network');
const azureStorage = require('azure-storage');
const f5CloudLibs = require('@f5devcentral/f5-cloud-libs');

const Logger = f5CloudLibs.logger;
const util = f5CloudLibs.util;

/**
 * Grab command line arguments
*/
options
    .version('1.0.0')

    .option('--log-level [type]', 'Specify the log level', 'info')
    .parse(process.argv);

const logFile = '/var/log/cloud/azure/azureFailover.log';
const loggerOptions = { logLevel: options.logLevel, fileName: logFile, console: true };
const logger = Logger.getLogger(loggerOptions);
const BigIp = f5CloudLibs.bigIp;
const bigip = new BigIp({ logger });

let uniqueLabel;
let resourceGroup;
let networkClient;
let routeFilter;
let storageAccount;
let storageKey;
let storageClient;

if (fs.existsSync('/config/cloud/.azCredentials')) {
    logger.debug('Credentials file found');
    const credentialsFile = JSON.parse(fs.readFileSync('/config/cloud/.azCredentials', 'utf8'));
    const clientId = credentialsFile.clientId;
    const secret = credentialsFile.secret;
    const subscriptionId = credentialsFile.subscriptionId;
    const tenantId = credentialsFile.tenantId;
    storageAccount = credentialsFile.storageAccount;
    storageKey = credentialsFile.storageKey;
    storageClient = azureStorage.createBlobService(
        storageAccount,
        storageKey
    );
    const credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);
    uniqueLabel = credentialsFile.uniqueLabel;
    resourceGroup = credentialsFile.resourceGroupName;
    networkClient = new NetworkManagementClient(credentials, subscriptionId);
} else {
    logger.error('Credentials file not found');
    return;
}

if (fs.existsSync('/config/cloud/managedRoutes')) {
    logger.silly('Managed routes file found');
    routeFilter =
        fs.readFileSync('/config/cloud/managedRoutes', 'utf8').replace(/(\r\n|\n|\r)/gm, '').split(',');
} else {
    routeFilter = [];
    logger.info('Managed routes file not found');
}

const FAILOVER_CONTAINER = 'failover';
const FAILOVER_FILE = 'statusdb';
const FAILOVER_STATUS_SUCCESS = 'succeeded';
const FAILOVER_STATUS_FAIL = 'failed';
const FAILOVER_STATUS_RUN = 'running';
const MAX_RUNNING_TASK_MS = 5 * 60000; // 5 minutes
let tgStats = [];
let globalSettings = [];
let virtualAddresses = [];
let selfIpsArr = [];
let recoverPreviousTask = false;
// Define base properties of failover database in storage
let failoverDbBlob = {
    status: '',
    timeStamp: '',
    desiredConfiguration: {
        nicArr: {}
    }
};

const performFailover = function () {
    const deferred = q.defer();

    putJsonObject(storageClient, FAILOVER_CONTAINER, FAILOVER_FILE, failoverDbBlob)
        .then(() => {
            return notifyStateUpdate('delete');
        })
        .then(() => {
            return bigip.init(
                'localhost',
                'svc_user',
                'file:///config/cloud/.passwd',
                {
                    passwordIsUrl: true,
                    port: '443',
                    passwordEncrypted: true
                }
            );
        })
        .then(() => {
            return Promise.all([
                bigip.list('/tm/cm/traffic-group/stats'),
                bigip.list('/tm/sys/global-settings'),
                bigip.list('/tm/net/self'),
                bigip.list('/tm/ltm/virtual-address'),
            ]);
        })
        .then((results) => {
            logger.silly('BIG-IP information successfully retrieved');
            tgStats = results[0];
            globalSettings = results[1];
            selfIpsArr = results[2];
            virtualAddresses = results[3];
            return Promise.all([
                listRouteTables(),
                listAzNics(resourceGroup),
            ]);
        })
        .then((results) => {
            logger.info('Performing failover');
            return Promise.all([
                matchRoutes(results[0], selfIpsArr, tgStats, globalSettings),
                matchNics(results[1], virtualAddresses, selfIpsArr, tgStats, globalSettings),
            ]);
        })
        .then(() => {
            logger.silly('Updating failover database in storage');
            failoverDbBlob.status = FAILOVER_STATUS_SUCCESS;
            return putJsonObject(storageClient, FAILOVER_CONTAINER, FAILOVER_FILE, failoverDbBlob);
        })
        .then(() => {
            logger.silly('Updated failover database successfully');
            deferred.resolve();
        })
        .catch((err) => {
            failoverDbBlob.status = FAILOVER_STATUS_FAIL;
            putJsonObject(storageClient, FAILOVER_CONTAINER, FAILOVER_FILE, failoverDbBlob)
                .then(() => {
                    logger.error('Error during failover:', err);
                    deferred.reject(err);
                });
        });
    return deferred.promise;
};

storageInit(storageClient)
    .then(() => {
        // Avoid the case where multiple tgactive scripts triggered
        // within a short time frame may stomp on each other
        return notifyStateUpdate('check');
    })
    .then(() => {
        return getJsonObject(storageClient, FAILOVER_CONTAINER, FAILOVER_FILE);
    })
    .then((results) => {
        failoverDbBlob = results;

        logger.debug('Failover database status:', failoverDbBlob.status);
        if (results.status === FAILOVER_STATUS_RUN || results.status === FAILOVER_STATUS_FAIL) {
            if (typeof failoverDbBlob.timeStamp !== 'undefined' && failoverDbBlob.timeStamp !== '') {
                const differenceInMs = new Date() - Date.parse(failoverDbBlob.timeStamp);
                logger.silly('differenceInMs:', differenceInMs, 'MAX_RUNNING_TASK_MS:', MAX_RUNNING_TASK_MS);
                if (differenceInMs > MAX_RUNNING_TASK_MS) {
                    logger.info('Recovering from previous task, differenceInMs:', differenceInMs);
                    recoverPreviousTask = true;
                }
            }
            // Return - except when recovering from previous incomplete or failed task
            if (!recoverPreviousTask) {
                logger.info('Already performing failover, exit');
                return q();
            }
        }

        failoverDbBlob.status = FAILOVER_STATUS_RUN;
        failoverDbBlob.timeStamp = new Date().toJSON();
        return performFailover();
    })
    .then(() => {
        logger.info('Failover finished successfully');
        notifyStateUpdate('delete');
    })
    .catch((error) => {
        logger.error('Failover failed:', error.message);
        notifyStateUpdate('delete');
    });

const retryRoutes = function (routeTableGroup, routeTableName, routeName, routeParams) {
    return new Promise(
        ((resolve, reject) => {
            logger.info('Updating route: ', routeName);
            updateRoutes(routeTableGroup, routeTableName, routeName, routeParams)
                .then(() => {
                    logger.info('Update route successful: ', routeName);
                    resolve();
                })
                .catch((error) => {
                    logger.error('Update route error: ', error);
                    // a 429 response indicates an error which is generally retryable within 15 seconds
                    if (error.response.statusCode === '429') {
                        reject();
                    } else {
                        reject(error);
                    }
                });
        })
    );
};

/**
    * Creates local notification to alert other processes that state is being updated
    *
    * @param {String} action - Action to take for local notification function
    *
    * @returns {Promise} A promise which will be resolved after state update actions taken
*/
function notifyStateUpdate(action) {
    const stateFile = '/config/cloud/failoverState';
    const stateFileContents = 'Currently updating failover state status';
    const deferred = q.defer();

    if (action === 'delete') {
        if (fs.existsSync(stateFile)) {
            fs.unlinkSync(stateFile);
        }
        deferred.resolve();
    } else if (action === 'check') {
        // Check in intervals in case previous process is not done updating state
        let ctr = 30;
        const iObj = setInterval(() => {
            if (!fs.existsSync(stateFile)) {
                fs.writeFileSync(stateFile, stateFileContents, 'utf8');
                deferred.resolve();
                clearInterval(iObj);
            } else {
                logger.silly('State file exists, retrying after sleep:', ctr);
            }
            ctr -= 1;
            if (ctr === 0) {
                deferred.reject(new Error('State file still exists after retry period expired:', stateFile));
                clearInterval(iObj);
            }
        }, 1000);
    } else {
        deferred.reject(new Error('Unknown action specified for notifyStateUpdate'));
    }
    return deferred.promise;
}

/**
    * Updates specified Azure user defined routes
    *
    * @param {String} routeTableGroup - Name of the route table resource group
    * @param {String} routeTableName - Name of the route table
    * @param {String} routeName - Name of the route to update
    * @param {Array} routeParams - New route parameters
    *
    * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function updateRoutes(routeTableGroup, routeTableName, routeName, routeParams) {
    return new Promise(
        ((resolve, reject) => {
            networkClient.routes.beginCreateOrUpdate(routeTableGroup, routeTableName, routeName, routeParams,
                (error, data) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(data);
                    }
                });
        })
    );
}

/**
    * Lists all route tables in the subscription
    *
    * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function listRouteTables() {
    return new Promise(
        ((resolve, reject) => {
            networkClient.routeTables.listAll(
                (error, data) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(data);
                    }
                }
            );
        })
    );
}

/**
    * Returns an array of routes
    *
    * @param {Object} mySelfIp - Our self IP
    *
    * @param {Array} routeTables - The Azure route tables
    *
    * @param {Array} myTrafficGroupsArr - Our going-active traffic groups
    *
*/
function getRoutes(mySelfIp, routeTables, myTrafficGroupsArr) {
    routeTables.forEach((routeTable) => {
        if (routeTable.tags && routeTable.tags.f5_tg
            && routeTable.tags.f5_ha
            && mySelfIp.name.includes(routeTable.tags.f5_ha)) {
            // get the tag for each route table that has one
            const tgTag = routeTable.tags.f5_tg;

            for (let t = myTrafficGroupsArr.length - 1; t >= 0; t--) {
                if (myTrafficGroupsArr[t].trafficGroup.includes(tgTag)) {
                    // set the resource group, name, and routes for each
                    // route table with a tag that matches our self IP
                    const routeTableGroup = routeTable.id.split('/')[4];
                    const routeTableName = routeTable.name;
                    const routes = routeTable.routes;

                    sendRoutes(routes, routeTableGroup, routeTableName, mySelfIp);
                }
            }
        }
    });
}

/**
    * Returns an array of routes
    *
    * @param {Array} routes - The Azure routes
    *
    * @param {String} routeTableGroup - The Azure route table resource group
    *
    * @param {String} routeTableName - The Azure route table name
    *
*/
function sendRoutes(routes, routeTableGroup, routeTableName, mySelfIp) {
    routes.forEach(function routeFunction(route) {
        if (routeFilter.indexOf(route.addressPrefix) !== -1) {
            // if route matches our file,
            // update its next hop
            const myRoute = route;
            const routeName = myRoute.name;
            myRoute.nextHopType = 'VirtualAppliance';
            myRoute.nextHopIpAddress = mySelfIp.address;
            const routeParams = myRoute;

            const routeArr = [routeTableGroup, routeTableName, routeName, routeParams];

            util.tryUntil(this, { maxRetries: 4, retryIntervalMs: 15000 },
                retryRoutes, routeArr);
        }
    });
}

/**
    * Determines which routes to update
    *
    * @param {Object} routeTables - All of the route tables in the subscription
    * @param {String} self - The internal self IP address of this BIG-IP
    *
*/
function matchRoutes(routeTables, selfIps, tgs, global) {
    const entries = tgs.entries;
    const hostname = global.hostname;
    let s;

    const mySelfIpArr = [];
    const myTrafficGroupsArr = [];

    selfIps.forEach((self) => {
        mySelfIpArr.push({
            name: self.name,
            address: self.address.split('/')[0]
        });
    });

    Object.keys(entries).forEach((key) => {
        if (entries[key].nestedStats.entries.deviceName.description.includes(hostname)
        && entries[key].nestedStats.entries.failoverState.description === 'active') {
            myTrafficGroupsArr.push({
                trafficGroup: entries[key].nestedStats.entries.trafficGroup.description
            });
        }
    });

    for (s = mySelfIpArr.length - 1; s >= 0; s--) {
        getRoutes(mySelfIpArr[s], routeTables, myTrafficGroupsArr);
    }
}

/**
    * Lists all network interface configurations in this resource group
    *
    * @param {String} resourceGroup - Name of the resource group
    *
    * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function listAzNics() {
    return new Promise(
        ((resolve, reject) => {
            networkClient.networkInterfaces.list(resourceGroup,
                (error, data) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(data);
                    }
                });
        })
    );
}

/**
    * Returns a network interface IP configuration
    *
    * @param {Object} ipConfig - The full Azure IP configuration
    *
    * @returns {Array} An array of IP configuration parameters
*/
function getNicConfig(ipConfig) {
    return {
        name: ipConfig.name,
        privateIPAllocationMethod: ipConfig.privateIPAllocationMethod,
        privateIPAddress: ipConfig.privateIPAddress,
        primary: ipConfig.primary,
        publicIPAddress: ipConfig.publicIPAddress,
        subnet: ipConfig.subnet,
        loadBalancerBackendAddressPools: ipConfig.loadBalancerBackendAddressPools
    };
}

/**
    * Returns an array of IP configurations
    *
    * @param {Object} ipConfigurations - The Azure NIC IP configurations
    *
    * @returns {Array} An array of IP configurations
*/
function getIpConfigs(ipConfigurations) {
    const nicArr = [];
    ipConfigurations.forEach((ipConfiguration) => {
        nicArr.push(getNicConfig(ipConfiguration));
    });
    return nicArr;
}

/**
    * Determines which IP configurations to move to and from network interfaces
    *
    * @param {Object} nics    - The network interface configurations
    * @param {Object} vs      - The virtual server configurations
    * @param {String} selfIps - The external self IP address of this BIG-IP
    * @param {String} tgs     - The traffic group stats
    * @param {String} global     - The global settings of this BIG-IP
    *
    * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function matchNics(nics, vs, selfIps, tgs, global) {
    let h;
    let i;
    let p;
    let qp;
    let s;
    let t;
    let address;
    const entries = tgs.entries;
    const hostname = global.hostname;
    let ipConfigurations;

    let myNsg;
    let myIpForwarding;
    let myTags;
    let ourLocation;

    let theirNsg;
    let theirTags;
    let theirIpForwarding;
    let virtualAddressTrafficGroup;

    let associateArr = [];
    let disassociateArr = [];
    let myNicArr = [];
    const myNicsArr = [];
    const mySelfIpArr = [];
    const myTrafficGroupsArr = [];
    let theirNicArr = [];
    const theirNicsArr = [];
    const trafficGroupIpArr = [];

    const updateNics = function (group, nicName, nicParams, action) {
        return new Promise(
            ((resolve, reject) => {
                logger.info(action, 'NIC: ', nicName);
                networkClient.networkInterfaces.createOrUpdate(group, nicName, nicParams,
                    (error, data) => {
                        if (error) {
                            logger.error(action, 'NIC error: ', error);
                            reject(error);
                        } else {
                            logger.info(action, 'NIC successful: ', nicName);
                            resolve(data);
                        }
                    });
            })
        );
    };

    const retrier = function (fnToTry, nicArr) {
        return new Promise(
            function retryFunc(resolve, reject) {
                util.tryUntil(this, { maxRetries: 4, retryIntervalMs: 15000 }, fnToTry, nicArr)
                    .then(() => {
                        resolve();
                    })
                    .catch((error) => {
                        logger.error('Error: ', error);
                        reject(error);
                    });
            }
        );
    };

    selfIps.forEach((self) => {
        mySelfIpArr.push({
            address: self.address.split('/')[0]
        });
    });

    Object.keys(entries).forEach((key) => {
        if (entries[key].nestedStats.entries.deviceName.description.includes(hostname)
        && entries[key].nestedStats.entries.failoverState.description === 'active') {
            myTrafficGroupsArr.push({
                trafficGroup: entries[key].nestedStats.entries.trafficGroup.description
            });
        }
    });

    if (!vs.length) {
        logger.error('No virtual addresses exist, create them prior to failover.');
    } else {
        vs.forEach((virtualAddress) => {
            address = virtualAddress.address;
            virtualAddressTrafficGroup = virtualAddress.trafficGroup;

            myTrafficGroupsArr.forEach((tgmember) => {
                if (tgmember.trafficGroup.includes(virtualAddressTrafficGroup)) {
                    trafficGroupIpArr.push({
                        address
                    });
                }
            });
        });
    }

    nics.forEach((nic) => {
        if (nic.name.toLowerCase().includes(uniqueLabel.toLowerCase())
        && nic.provisioningState === 'Succeeded') {
            ipConfigurations = nic.ipConfigurations;
            ipConfigurations.forEach((ipConfiguration) => {
                mySelfIpArr.forEach((selfIp) => {
                    if (ipConfiguration.privateIPAddress === selfIp.address) {
                        if (myNicsArr.indexOf(nic) === -1) {
                            myNicsArr.push({
                                nic
                            });
                        }
                    }
                });
                trafficGroupIpArr.forEach((trafficGroupIp) => {
                    if (ipConfiguration.privateIPAddress === trafficGroupIp.address) {
                        if (theirNicsArr.indexOf(nic) === -1) {
                            theirNicsArr.push({
                                nic
                            });
                        }
                    }
                });
            });
        }
    });

    for (p = myNicsArr.length - 1; p >= 0; p--) {
        for (qp = theirNicsArr.length - 1; qp >= 0; qp--) {
            if (myNicsArr[p].nic.id === theirNicsArr[qp].nic.id) {
                theirNicsArr.splice(qp, 1);
                break;
            }
        }
    }

    if (!myNicsArr || !theirNicsArr) {
        logger.error('Could not determine network interfaces.');
    }

    for (s = myNicsArr.length - 1; s >= 0; s--) {
        for (h = theirNicsArr.length - 1; h >= 0; h--) {
            if (theirNicsArr[h].nic.name !== myNicsArr[s].nic.name
                && theirNicsArr[h].nic.name.slice(0, -1) === myNicsArr[s].nic.name.slice(0, -1)) {
                myNicArr = [];
                theirNicArr = [];
                ourLocation = myNicsArr[s].nic.location;
                theirNsg = theirNicsArr[h].nic.networkSecurityGroup;
                myNsg = myNicsArr[s].nic.networkSecurityGroup;
                theirIpForwarding = theirNicsArr[h].nic.enableIPForwarding;
                myIpForwarding = myNicsArr[s].nic.enableIPForwarding;
                theirTags = theirNicsArr[h].nic.tags;
                myTags = myNicsArr[s].nic.tags;

                myNicArr = getIpConfigs(myNicsArr[s].nic.ipConfigurations);
                theirNicArr = getIpConfigs(theirNicsArr[h].nic.ipConfigurations);

                for (i = theirNicArr.length - 1; i >= 0; i--) {
                    for (t = trafficGroupIpArr.length - 1; t >= 0; t--) {
                        if (trafficGroupIpArr[t].address.includes(theirNicArr[i].privateIPAddress)) {
                            myNicArr.push(getNicConfig(theirNicArr[i]));
                            theirNicArr.splice(i, 1);
                            break;
                        }
                    }
                }

                const theirNicParams = {
                    location: ourLocation,
                    ipConfigurations: theirNicArr,
                    networkSecurityGroup: theirNsg,
                    tags: theirTags,
                    enableIPForwarding: theirIpForwarding
                };
                const myNicParams = {
                    location: ourLocation,
                    ipConfigurations: myNicArr,
                    networkSecurityGroup: myNsg,
                    tags: myTags,
                    enableIPForwarding: myIpForwarding
                };

                disassociateArr.push([resourceGroup, theirNicsArr[h].nic.name, theirNicParams,
                    'Disassociate']);
                associateArr.push([resourceGroup, myNicsArr[s].nic.name, myNicParams,
                    'Associate']);

                break;
            }
        }
    }

    if (recoverPreviousTask) {
        // Replace current configuration with previous desired configuration from failover database
        disassociateArr = failoverDbBlob.desiredConfiguration.nicArr.disassociateArr;
        associateArr = failoverDbBlob.desiredConfiguration.nicArr.associateArr;
    }
    // Update failover database with desired configuration prior to updating NICs
    if (disassociateArr.length && associateArr.length) {
        failoverDbBlob.desiredConfiguration.nicArr = {};
        failoverDbBlob.desiredConfiguration.nicArr.disassociateArr = disassociateArr;
        failoverDbBlob.desiredConfiguration.nicArr.associateArr = associateArr;
    }

    const associateDeferred = q.defer();
    putJsonObject(storageClient, FAILOVER_CONTAINER, FAILOVER_FILE, failoverDbBlob)
        .then(() => {
            const disassociatePromises = disassociateArr.map(retrier.bind(null, updateNics));
            return Promise.all(disassociatePromises);
        })
        .then(() => {
            logger.info('Disassociate NICs successful.');
            const associatePromises = associateArr.map(retrier.bind(null, updateNics));
            return Promise.all(associatePromises);
        })
        .then(() => {
            logger.info('Associate NICs successful.');
            associateDeferred.resolve();
        })
        .catch((error) => {
            logger.error('Error: ', error);
            associateDeferred.reject(error);
        });
    return associateDeferred.promise;
}

/**
 * Initialize storage
 *
 * @param {Object}  sClient - Azure storage client.
 *
 * @returns {Promise} A promise which will be resolved when storage init is complete.
 */
function storageInit(sClient) {
    const deferred = q.defer();

    createContainers(sClient, [FAILOVER_CONTAINER])
        .then(() => {
            return checkJsonObject(storageClient, FAILOVER_CONTAINER, FAILOVER_FILE);
        })
        .then((results) => {
            if (results.exists) {
                // blob exists, continue
                deferred.resolve();
            } else {
                putJsonObject(storageClient, FAILOVER_CONTAINER, FAILOVER_FILE, failoverDbBlob)
                    .then(() => {
                        deferred.resolve();
                    });
            }
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
}

/**
 * Creates empty containers
 *
 * @param {Object}    sClient    - Azure storage instance
 * @param {Object[]}  containers - Array of container names to create
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 */
function createContainers(sClient, containers) {
    const promises = [];

    const createContainer = function (container) {
        const deferred = q.defer();

        sClient.createContainerIfNotExists(container, (err) => {
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
 * Checks if a JSON object exists in Azure storage
 *
 * @param {Object}    sClient   - Azure storage instance
 * @param {String}    container - Name of the container in which to store the Object
 * @param {String}    name      - Name to store the object as
 * @param {Object}    data      - Object to store
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 *                    or rejected if an error occurs.
 */
function checkJsonObject(sClient, container, name) {
    const deferred = q.defer();

    sClient.doesBlobExist(container, name, (err, data) => {
        if (err) {
            deferred.reject(err);
        } else {
            logger.silly('checkJsonObject result:', data);
            deferred.resolve(data);
        }
    });

    return deferred.promise;
}

/**
 * Gets a JSON object from Azure storage
 *
 * @param {Object}    sClient    - Azure storage instance
 * @param {String}    container  - Name of the container in which to store the Object
 * @param {String}    name       - Name to store the object as
 *
 * @returns {Promise} Promise which will be resolved with the object
 *                    or rejected if an error occurs.
 */
function getJsonObject(sClient, container, name) {
    const deferred = q.defer();

    sClient.getBlobToText(container, name, (err, data) => {
        if (err) {
            logger.error('error from getBlobToText:', err);
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

/**
 * Stores a JSON object in Azure storage
 *
 * @param {Object}    sClient   - Azure storage instance
 * @param {String}    container - Name of the container in which to store the Object
 * @param {String}    name      - Name to store the object as
 * @param {Object}    data      - Object to store
 *
 * @returns {Promise} Promise which will be resolved when the operation completes
 *                    or rejected if an error occurs.
 */
function putJsonObject(sClient, container, name, data) {
    logger.silly('putJsonObject data:', data);
    const deferred = q.defer();
    const jsonData = JSON.stringify(data);

    sClient.createBlockBlobFromText(container, name, jsonData, (err) => {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve();
        }
    });

    return deferred.promise;
}
