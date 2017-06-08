#!/usr/bin/env node

var LogLevel = 'info';
var Logger = require('f5-cloud-libs').logger;
var logger = Logger.getLogger({logLevel: LogLevel, fileName: '/var/tmp/azureFailover.log'});

var util = require('f5-cloud-libs').util;
var fs = require('fs');

if (fs.existsSync('/config/cloud/azCredentials')) {
    var credentialsFile = JSON.parse(fs.readFileSync('/config/cloud/azCredentials', 'utf8'));
}
else {
     logger.info('Credentials file not found');
     return;
}

var subscriptionId = credentialsFile.subscriptionId;
var clientId = credentialsFile.clientId;
var tenantId = credentialsFile.tenantId;
var secret = credentialsFile.secret;
var resourceGroup = credentialsFile.resourceGroup;

var msRestAzure = require('ms-rest-azure');
var credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);

var networkManagementClient = require('azure-arm-network');
var networkClient = new networkManagementClient(credentials, subscriptionId);

if (fs.existsSync('/config/cloud/managedRoutes')) {
    var routeFilter = fs.readFileSync('/config/cloud/managedRoutes', 'utf8').replace(/(\r\n|\n|\r)/gm,"").split(',');
}
else {
    logger.info('Managed routes file not found');
}

if (fs.existsSync('/config/cloud/routeTableTag')) {
    var routeTableTags = fs.readFileSync('/config/cloud/routeTableTag', 'utf8').replace(/(\r\n|\n|\r)/gm,"").split('\n');
}
else {
    logger.info('Route table tag file not found');
}

var extIpName = '-ext-pip';
var extIpConfigName = '-ext-ipconfig';
var selfIpConfigName = '-self-ipconfig';

var BigIp;
var bigip;
BigIp = require('f5-cloud-libs').bigIp;
bigip = new BigIp({logger: logger});

bigip.init(
    'localhost',
    'admin',
    'file:///config/cloud/passwd',
    {
        passwordIsUrl: true,
        port: '443'
    }
)
.then(function() {
    Promise.all([
    listRouteTables(),
        bigip.list('/tm/net/self/self_3nic'),
    ])
    .then((results) => {
        matchRoutes(results[0], results[1].address);
    })
    .catch(err => {
        logger.info('Error: ', err);
    });
    Promise.all([
        listAzNics(resourceGroup),
        listPublicIPs(resourceGroup),
        bigip.list('/tm/net/self/self_2nic'),
    ])
    .then((results) => {
        matchNics(results[0], results[1], results[2].address);
    })
    .catch(err => {
        logger.info('Error: ', err);
    });
});

/**
 * Lists all route tables in the subscription
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
 */
function listRouteTables() {
    return new Promise(
    function (resolve, reject) {
        networkClient.routeTables.listAll(
        (error, data) => {
            if (error) {
                reject(error);
            }
            else {
                resolve(data);
            }
        });
    });
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
    function (resolve, reject) {
        networkClient.routes.beginCreateOrUpdate(routeTableGroup, routeTableName, routeName, routeParams,
        (error, data) => {
            if (error) {
                reject(error);
            }
            else {
                resolve(data);
            }
        });
    });
}

/**
 * Determines which routes to update
 *
 * @param {Object} routeTables - All of the route tables in the subscription
 * @param {String} self - The internal self IP address of this BIG-IP
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
 */
function matchRoutes(routeTables, self) {
    var fields = self.split('/');
    var selfIp = fields[0];

    var t;
    var tag;
    var routeTableGroup;
    var routeTableName;
    var routes;
    var r;
    var routeName;
    var routeParams;
    var routeArr = [];

    var retryRoutes = function(routeTableGroup, routeTableName, routeName, routeParams) {
        return new Promise (
            function(resolve, reject) {
                updateRoutes(routeTableGroup, routeTableName, routeName, routeParams)
                    .then(function(result) {
                        logger.info("Update route result: ", result);
                        resolve();
                    })
                    .catch(function(error) {
                        logger.info("Update route error: ", error);
                        if (error.response.statusCode == "429") {
                            reject();
                        }
                        else {
                            reject(error);
                        }
                    });
            });
    };

    for (t in routeTables) {
        if (routeTables[t].tags && routeTables[t].tags.f5_ha) {
            tag = routeTables[t].tags.f5_ha;

            if (routeTableTags.indexOf(tag) !== -1) {
                routeTableGroup = routeTables[t].id.split("/")[4];
                routeTableName = routeTables[t].name;
                routes = routeTables[t].routes;

                for (r in routes) {
                    if (routeFilter.indexOf(routes[r].addressPrefix) !== -1) {
                        routeName = routes[r].name;
                        routes[r].nextHopType = 'VirtualAppliance';
                        routes[r].nextHopIpAddress = selfIp;
                        routeParams = routes[r];

                        routeArr = [routeTableGroup, routeTableName, routeName, routeParams];

                        util.tryUntil(this, {maxRetries: 4, retryIntervalMs: 15000}, retryRoutes, routeArr);
                    }
                }
            }
        }
    }
}

/**
 * Lists all network interface configurations in this resource group
 *
 * @param {String} resourceGroup - Name of the resource group
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
 */
function listAzNics(resourceGroup) {
    return new Promise(
    function (resolve, reject) {
        networkClient.networkInterfaces.list(resourceGroup,
        (error, data) => {
            if (error) {
                reject(error);
            }
            else {
                resolve(data);
            }
        });
    });
}

/**
 * Lists all public IP addresses in this resource group
 *
 * @param {String} resourceGroup - Name of the resource group
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
*/
function listPublicIPs(resourceGroup) {
    return new Promise(
    function (resolve, reject) {
        networkClient.publicIPAddresses.list(resourceGroup,
        (error, data) => {
            if (error) {
                reject(error);
            }
            else {
                resolve(data);
            }
        });
    });
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
        subnet: ipConfig.subnet
    };
}

/**
 * Determines which IP configurations to move to and from network interfaces
 *
 * @param {Object} nics - The network interface configurations
 * @param {Object} pips - The public IP address configurations
 * @param {String} self - The external self IP address of this BIG-IP
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
 */
function matchNics(nics, pips, self) {
    var fields = self.split('/');
    var selfIp = fields[0];

    var i;
    var ipConfigurations;
    var p;
    var myNicName;
    var myNicConfig;
    var theirNicName;
    var theirNicConfig;

    var orphanedPipsArr = [];
    var pip;
    var pipName;
    var name;
    var pipPrivate;
    var subnet;

    var c;
    var theirNicArr = [];
    var myNicArr = [];

    var ourLocation;
    var theirNicParams;
    var myNicParams;

    for (i in nics) {
        ipConfigurations = nics[i].ipConfigurations;
        for (p in ipConfigurations) {
            if (ipConfigurations[p].privateIPAddress === selfIp) {
                myNicName = nics[i].name;
                myNicConfig = nics[i];
            }
            else if (ipConfigurations[p].privateIPAddress !== selfIp && ipConfigurations[p].id.includes(selfIpConfigName)) {
                theirNicName = nics[i].name;
                theirNicConfig = nics[i];
            }
        }
    }

    for (p in pips) {
        if (pips[p].tags && pips[p].tags.f5_privateIp && pips[p].tags.f5_extSubnetId && pips[p].name.includes(extIpName)) {
            pip = {};
            pip.id = pips[p].id;
            pipName = pips[p].name;
            name = pipName.replace(extIpName, extIpConfigName);
            pipPrivate = pips[p].tags.f5_privateIp;
            subnet = {};
            subnet.id = pips[p].tags.f5_extSubnetId;

            if (!pips[p].ipConfiguration) {
                orphanedPipsArr.push({
                    'name': name,
                    'privateIPAllocationMethod': 'Static',
                    'privateIPAddress': pipPrivate,
                    'primary': false,
                    'publicIPAddress': pip,
                    'subnet': subnet
                });
            }
        }
    }

    for (c in theirNicConfig.ipConfigurations) {
        theirNicArr.push(getNicConfig(theirNicConfig.ipConfigurations[c]));
    }

    for (c in myNicConfig.ipConfigurations) {
        myNicArr.push(getNicConfig(myNicConfig.ipConfigurations[c]));
    }

    for (i=theirNicArr.length-1; i>=0; i--) {
        if (theirNicArr[i].name.includes(extIpConfigName)) {
            myNicArr.push({
                'name': theirNicArr[i].name,
                'privateIPAllocationMethod': theirNicArr[i].privateIPAllocationMethod,
                'privateIPAddress': theirNicArr[i].privateIPAddress,
                'primary': theirNicArr[i].primary,
                'publicIPAddress': theirNicArr[i].publicIPAddress,
                'subnet': theirNicArr[i].subnet
            });
            theirNicArr.splice(i, 1);
        }
    }

    for (i=orphanedPipsArr.length-1; i>=0; i--) {
      myNicArr.push({
           'name': orphanedPipsArr[i].name,
           'privateIPAllocationMethod': orphanedPipsArr[i].privateIPAllocationMethod,
           'privateIPAddress': orphanedPipsArr[i].privateIPAddress,
           'primary': orphanedPipsArr[i].primary,
           'publicIPAddress': orphanedPipsArr[i].publicIPAddress,
           'subnet': orphanedPipsArr[i].subnet
      });
    }

    ourLocation = myNicConfig.location;
    theirNicParams = { location: ourLocation, ipConfigurations:theirNicArr };
    myNicParams = { location: ourLocation, ipConfigurations:myNicArr };

    disassociateNics(resourceGroup, theirNicName, theirNicParams)
    .then(function (result) {
        logger.info("Disassociate NICs result: ", result);
        associateNics(resourceGroup, myNicName, myNicParams);
    })
    .then(function (result) {
        logger.info("Associate NICs result: ", result);
    })
    .catch(function (error) {
        logger.info('Error: ', error);
    });
}

/**
 * Removes specified IP configurations from the remote network interface
 *
 * @param {String} resourceGroup - Name of the resource group
 * @param {String} theirNicName - Name of the network interface to update
 * @param {Array} theirNicParams - Network interface parameters
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
 */
function disassociateNics(resourceGroup, theirNicName, theirNicParams) {
    return new Promise(
        function (resolve, reject) {
            networkClient.networkInterfaces.createOrUpdate(resourceGroup, theirNicName, theirNicParams,
            (error, data) => {
                if (error) {
                    reject(error);
                }
                else {
                    resolve(data);
                }
            });
        });
}

/**
 * Adds specified IP configurations to the local network interface
 *
 * @param {String} resourceGroup - Name of the resource group
 * @param {String} myNicName - Name of the network interface to update
 * @param {Array} myNicParams - Network interface parameters
 *
 * @returns {Promise} A promise which can be resolved with a non-error response from Azure REST API
 */
function associateNics(resourceGroup, myNicName, myNicParams) {
    return new Promise(
    function (resolve, reject) {
        networkClient.networkInterfaces.createOrUpdate(resourceGroup, myNicName, myNicParams,
        (error, data) => {
            if (error) {
                reject(error);
            }
            else {
                resolve(data);
            }
        });
    });
}