#!/usr/bin/env node
/*jshint loopfunc:true */

var LogLevel = 'info';
var Logger = require('f5-cloud-libs').logger;
var logger = Logger.getLogger({logLevel: LogLevel, fileName: '/var/tmp/azureFailover.log'});

var util = require('f5-cloud-libs').util;
var fs = require('fs');

if (fs.existsSync('/config/cloud/.azCredentials')) {
    var credentialsFile = JSON.parse(fs.readFileSync('/config/cloud/.azCredentials', 'utf8'));
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
    var routeFilter = [];
    logger.info('Managed routes file not found');
}

if (fs.existsSync('/config/cloud/routeTableTag')) {
    var routeTableTags = fs.readFileSync('/config/cloud/routeTableTag', 'utf8').replace(/(\r\n|\n|\r)/gm,"").split('\n');
}
else {
    var routeTableTags = [];
    logger.info('Route table tag file not found');
}

var extIpName = '-ext-pip';
var extIpConfigName = '-ext-ipconfig';
var selfIpConfigName = '-self-ipconfig';

var BigIp;
var bigip;
BigIp = require('f5-cloud-libs').bigIp;
bigip = new BigIp({logger: logger});

var tgStats = [];
var globalSettings = [];

bigip.init(
    'localhost',
    'admin',
    'file:///config/cloud/.passwd',
    {
        passwordIsUrl: true,
        port: '443'
    }
)
.then(function() {
    Promise.all([
        bigip.list('/tm/cm/traffic-group/stats'),
        bigip.list('/tm/sys/global-settings'),
    ])
    .then((results) => {
        tgStats = results[0];
        globalSettings = results[1];
        Promise.all([
            listRouteTables(),
            bigip.list('/tm/net/self/self_3nic'),
        ])
        .then((results) => {
            matchRoutes(results[0], results[1].address, tgStats, globalSettings);
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
            matchNics(results[0], results[1], results[2].address, tgStats, globalSettings);
        })
        .catch(err => {
            logger.info('Error in failover: ', err);
        });
    })
    .catch(err => {
        logger.info('Error getting device information: ', err);
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
*/
function matchRoutes(routeTables, self, tgs, global) {
    var hostname = global.hostname;
    var entries = tgs.entries;
    var key;

    for (key in entries) {
        if (entries[key].nestedStats.entries.deviceName.description.includes(hostname) && entries[key].nestedStats.entries.trafficGroup.description.includes("traffic-group-1") && entries[key].nestedStats.entries.failoverState.description == "active") {
            var fields = self.split('/');
            var selfIp = fields[0];

            var tag;
            var routeTableGroup;
            var routeTableName;
            var routes;
            var routeName;
            var routeParams;
            var routeArr = [];

            var retryRoutes = function(routeTableGroup, routeTableName, routeName, routeParams) {
                return new Promise (
                function(resolve, reject) {
                    updateRoutes(routeTableGroup, routeTableName, routeName, routeParams)
                    .then(function() {
                        logger.info("Update route successful.");
                        resolve();
                    })
                    .catch(function(error) {
                        logger.info("Update route error: ", error);
                        //a 429 response indicates an error which is generally retryable within 15 seconds
                        if (error.response.statusCode == "429") {
                            reject();
                        }
                        else {
                            reject(error);
                        }
                    });
                });
            };

            routeTables.forEach(function(routeTable) {
                if (routeTable.tags && routeTable.tags.f5_ha) {
                    tag = routeTable.tags.f5_ha;

                    if (routeTableTags.indexOf(tag) !== -1) {
                        routeTableGroup = routeTable.id.split("/")[4];
                        routeTableName = routeTable.name;
                        routes = routeTable.routes;

                        routes.forEach(function(route) {
                            if (routeFilter.indexOf(route.addressPrefix) !== -1) {
                                routeName = route.name;
                                route.nextHopType = 'VirtualAppliance';
                                route.nextHopIpAddress = selfIp;
                                routeParams = route;

                                routeArr = [routeTableGroup, routeTableName, routeName, routeParams];

                                util.tryUntil(this, {maxRetries: 4, retryIntervalMs: 15000}, retryRoutes, routeArr);
                            }
                        });
                    }
                }
            });
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
function matchNics(nics, pips, self, tgs, global) {
    var hostname = global.hostname;
    var entries = tgs.entries;
    var key;
    var myTrafficGroupsArr = [];

    for (key in entries) {
        if ( entries[key].nestedStats.entries.deviceName.description.includes(hostname) && entries[key].nestedStats.entries.failoverState.description == "active" ) {
            myTrafficGroupsArr.push({
                'trafficGroup': entries[key].nestedStats.entries.trafficGroup.description
            });
        }
    }

    var i;
    var t;

    var fields = self.split('/');
    var selfIp = fields[0];

    var ipConfigurations;

    var theirNicName;
    var theirNicConfig;
    var theirNicParams;

    var myNicName;
    var myNicConfig;
    var myNicParams;

    var orphanedPipsArr = [];
    var trafficGroupPipArr = [];

    var pipConfig;
    var pipName;
    var name;
    var pipPrivate;
    var subnet;
    var pipTrafficGroup;

    var theirNicArr = [];
    var myNicArr = [];

    var ourLocation;
    var theirNsg;
    var myNsg;

    var associateArr = [];
    var disassociateArr = [];

    var retryDissassociateNics = function(resourceGroup, theirNicName, theirNicParams) {
        return new Promise (
        function(resolve, reject) {
            disassociateNics(resourceGroup, theirNicName, theirNicParams)
            .then(function() {
                resolve();
            })
            .catch(function(error) {
                logger.info("Disassociate NICs error: ", error);
                if (error.response.statusCode == "200") {
                    resolve();
                }
                else {
                    reject(error);
                }
            });
        });
    };

    var retryAssociateNics = function(resourceGroup, myNicName, myNicParams) {
        return new Promise (
        function(resolve, reject) {
            associateNics(resourceGroup, myNicName, myNicParams)
            .then(function() {
                resolve();
            })
            .catch(function(error) {
                logger.info("Associate NICs error: ", error);
                if (error.response.statusCode == "200") {
                    resolve();
                }
                else {
                    reject(error);
                }
            });
        });
    };

    nics.forEach(function(nic) {
        ipConfigurations = nic.ipConfigurations;
        ipConfigurations.forEach(function(ipConfiguration) {
            if (ipConfiguration.privateIPAddress === selfIp) {
                myNicName = nic.name;
                myNicConfig = nic;
            }
            else if (ipConfiguration.privateIPAddress !== selfIp && ipConfiguration.id.includes(selfIpConfigName)) {
                theirNicName = nic.name;
                theirNicConfig = nic;
            }
        });
    });

    if ( !myNicName || !myNicConfig || !theirNicName || !theirNicConfig ) {
        logger.info("Could not determine network interfaces.");
    }

    pips.forEach(function(pip) {
        if (pip.tags && pip.tags.f5_privateIp && pip.tags.f5_extSubnetId && pip.tags.f5_tg && pip.name.includes(extIpName)) {
            pipConfig = {};
            pipConfig.id = pip.id;
            pipName = pip.name;
            name = pipName.replace(extIpName, extIpConfigName);
            pipPrivate = pip.tags.f5_privateIp;
            subnet = {};
            subnet.id = pip.tags.f5_extSubnetId;

            pipTrafficGroup = pip.tags.f5_tg;

            myTrafficGroupsArr.forEach(function(tgmember) {
                if (tgmember.trafficGroup.includes(pipTrafficGroup)) {
                    if (!pip.ipConfiguration) {
                        orphanedPipsArr.push({
                            'name': name,
                            'privateIPAllocationMethod': 'Static',
                            'privateIPAddress': pipPrivate,
                            'primary': false,
                            'publicIPAddress': pipConfig,
                            'subnet': subnet
                        });
                    }
                    else {
                        trafficGroupPipArr.push({
                            'publicIPAddress': pipConfig
                        });
                    }
                }
            });
        }
    });

    theirNicConfig.ipConfigurations.forEach(function(ipConfiguration) {
        theirNicArr.push(getNicConfig(ipConfiguration));
    });

    myNicConfig.ipConfigurations.forEach(function(ipConfiguration) {
        myNicArr.push(getNicConfig(ipConfiguration));
    });

    for (i=theirNicArr.length-1; i>=0; i--) {
        if (theirNicArr[i].name.includes(extIpConfigName)) {
            for (t=trafficGroupPipArr.length-1; t>=0; t--) {
                if (trafficGroupPipArr[t].publicIPAddress.id.includes(theirNicArr[i].publicIPAddress.id)) {
                    myNicArr.push(getNicConfig(theirNicArr[i]));
                    theirNicArr.splice(i, 1);
                    break;
                }
            }
        }
    }

    for (i=orphanedPipsArr.length-1; i>=0; i--) {
        myNicArr.push(getNicConfig(orphanedPipsArr[i]));
    }

    ourLocation = myNicConfig.location;
    theirNsg = theirNicConfig.networkSecurityGroup;
    myNsg = myNicConfig.networkSecurityGroup;

    theirNicParams = { location: ourLocation, ipConfigurations:theirNicArr, networkSecurityGroup: theirNsg };
    myNicParams = { location: ourLocation, ipConfigurations:myNicArr, networkSecurityGroup: myNsg };

    disassociateArr = [resourceGroup, theirNicName, theirNicParams];
    associateArr = [resourceGroup, myNicName, myNicParams];

    util.tryUntil(this, {maxRetries: 4, retryIntervalMs: 15000}, retryDissassociateNics, disassociateArr)
    .then(function () {
        logger.info("Disassociate NICs successful.");
        return util.tryUntil(this, {maxRetries: 4, retryIntervalMs: 15000}, retryAssociateNics, associateArr);
    })
    .then(function () {
        logger.info("Associate NICs successful.");
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
