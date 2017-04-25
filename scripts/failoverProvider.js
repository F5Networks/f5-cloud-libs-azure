#!/usr/bin/env node

var fs = require('fs');
var credentialsFile = JSON.parse(fs.readFileSync('/config/cloud/azCredentials', 'utf8'));

var subscriptionId = credentialsFile.subscriptionId;
var clientId = credentialsFile.clientId;
var tenantId = credentialsFile.tenantId;
var secret = credentialsFile.secret;
var resourceGroup = credentialsFile.resourceGroup;

var msRestAzure = require('ms-rest-azure');
var credentials = new msRestAzure.ApplicationTokenCredentials(clientId, tenantId, secret);

var networkManagementClient = require('azure-arm-network');
var networkClient = new networkManagementClient(credentials, subscriptionId);

var Logger = require('/config/cloud/node_modules/f5-cloud-libs/lib/logger');
var logger = Logger.getLogger({logLevel: 'debug', fileName: '/var/tmp/azureFailover.log'});

//I want to use bigIp.js here instead, but I still don't quite get how to do it
var iControl = require('icontrol');

//will I need the BIG-IP admin password using bigIp.js?
var bigip = new iControl({
     host: 'localhost',
     proto: 'https',
     port: 8443,
     strict: false,
     debug: false
});

var routeFilter = fs.readFileSync('/config/cloud/managedRoutes', 'utf8').replace(/(\r\n|\n|\r)/gm,"").split(',');
var routeTableTags = fs.readFileSync('/config/cloud/routeTableTag', 'utf8').replace(/(\r\n|\n|\r)/gm,"").split('\n');

var extIpName = '-ext-pip';
var extIpConfigName = '-ext-ipconfig';
var selfIpConfigName = '-self-ipconfig';

//update routes
function listRouteTablesPromisified() {
     return new Promise(
     function (resolve, reject) {
          networkClient.routeTables.listAll(
          (error, data) => {
               if (error) {
                    reject(error);
                    } else {
                    resolve(data);
               }
          });
     });
}

function listIntNicPromisified() {
     return new Promise(
     function (resolve, reject) {
          bigip.list('/net/self/self_3nic',
          (error, data) => {
               if (error) {
                    reject(error);
                    } else {
                    resolve(data);
               }
          });
     });
}

function updateRoutesPromisified(routeTableGroup, routeTableName, routeName, routeParams) {
     return new Promise(
     function (resolve, reject) {
          networkClient.routes.beginCreateOrUpdate(routeTableGroup, routeTableName, routeName, routeParams,
          (error, data) => {
               if (error) {
                    reject(error);
                    } else {
                    resolve(data);
               }
          });
     });
}

function matchRoutes(routeTables, self) {     
     var self = self.address;
     var fields = self.split('/');
     var selfIp = fields[0];    
     
     for ( var t in routeTables ) {
          if ( routeTables[t].tags && routeTables[t].tags.f5_ha ) {
               var tag = routeTables[t].tags.f5_ha;
               
               if ( routeTableTags.indexOf(tag) !== -1 ) {
                    var routeTableGroup = routeTables[t].id.split("/")[4];
                    var routeTableName = routeTables[t].name;
                    var routes = routeTables[t].routes
                    
                    for ( var r in routes ) {
                         if ( routeFilter.indexOf(routes[r].addressPrefix) !== -1 ) {                    
                              var routeName = routes[r].name;                    
                              routes[r].nextHopType = 'VirtualAppliance';
                              routes[r].nextHopIpAddress = selfIp;
                              var routeParams = routes[r];
                              
                              //do this for each route that needs updating
                              //if the HTTP response error.statusCode is 429 for updating each route, want to retry every 15 seconds for 4 retries
                              updateRoutesPromisified(routeTableGroup, routeTableName, routeName, routeParams)
                              .then(function (result) {
                                   logger.debug("Update route result: ", result);
                              })
                              .catch(function (error) {
                                   logger.debug('Error: ', error);
                              });
                         }
                    }
               }
          } 
     }
}

Promise.all([
     listRouteTablesPromisified(),
     listIntNicPromisified(),
])
.then((results) => {
     matchRoutes(results[0], results[1]);
})
.catch(err => {
     logger.debug('Error: ', err);
});

//update NICs
function listAzNicsPromisified(resourceGroup) {
     return new Promise(
     function (resolve, reject) {
          networkClient.networkInterfaces.list(resourceGroup,
          (error, data) => {
               if (error) {
                    reject(error);
                    } else {
                    resolve(data);
               }
          });
     });
}

function listPublicIPsPromisified(resourceGroup) {
     return new Promise(
     function (resolve, reject) {
          networkClient.publicIPAddresses.list(resourceGroup,
          (error, data) => {
               if (error) {
                    reject(error);
                    } else {
                    resolve(data);
               }
          });
     });
}

function listExtNicPromisified() {
     return new Promise(
     function (resolve, reject) {
          bigip.list('/net/self/self_2nic',
          (error, data) => {
               if (error) {
                    reject(error);
                    } else {
                    resolve(data);
               }
          });
     });
}

function matchNics(nics, pips, self) {
     var self = self.address;
     var fields = self.split('/');
     var selfIp = fields[0];    
     
     for ( var i in nics ) {
          var ipConfigurations = nics[i].ipConfigurations;          
          for ( var p in ipConfigurations ) {
               if ( ipConfigurations[p].privateIPAddress === selfIp ) {
                    var myNicName = nics[i].name;
                    var myNicConfig = nics[i];
               }
               if ( ipConfigurations[p].privateIPAddress !== selfIp && ipConfigurations[p].id.includes(selfIpConfigName) ) {
                    var theirNicName = nics[i].name;
                    var theirNicConfig = nics[i];
               }
          }
     }
     
     var orphanedPipsArr = [];
     
     for ( var p in pips ) {
          if ( pips[p].tags.f5_privateIp && pips[p].tags.f5_extSubnetId && pips[p].name.includes(extIpName) ) {
               var pip = {};
               pip.id = pips[p].id;               
               var pipName = pips[p].name;
               var name = pipName.replace(extIpName, extIpConfigName);
               var pipPrivate = pips[p].tags.f5_privateIp;               
               var subnet = {};
               subnet.id = pips[p].tags.f5_extSubnetId;
               
               if ( !pips[p].ipConfiguration ) {                
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
     
     var ourLocation = myNicConfig.location;     
     var theirNicArr = [];
     var myNicArr = [];
     
     for ( var c in theirNicConfig.ipConfigurations ) {          
          var theirName = theirNicConfig.ipConfigurations[c].name;
          var theirPrivateIpMethod = theirNicConfig.ipConfigurations[c].privateIPAllocationMethod;
          var theirPrivateIp = theirNicConfig.ipConfigurations[c].privateIPAddress;
          var theirPrimary = theirNicConfig.ipConfigurations[c].primary;
          var theirSubnetId = theirNicConfig.ipConfigurations[c].subnet;
          var theirPublicIpId = theirNicConfig.ipConfigurations[c].publicIPAddress; 
          theirNicArr.push({
               'name': theirName, 
               'privateIPAllocationMethod': theirPrivateIpMethod,
               'privateIPAddress': theirPrivateIp, 
               'primary': theirPrimary, 
               'publicIPAddress': theirPublicIpId,
               'subnet': theirSubnetId
          });   
     }
     
     for ( var c in myNicConfig.ipConfigurations ) {         
          var myName = myNicConfig.ipConfigurations[c].name;
          var myPrivateIpMethod = myNicConfig.ipConfigurations[c].privateIPAllocationMethod;
          var myPrivateIp = myNicConfig.ipConfigurations[c].privateIPAddress;
          var myPrimary = myNicConfig.ipConfigurations[c].primary;
          var mySubnetId = myNicConfig.ipConfigurations[c].subnet;
          var myPublicIpId = myNicConfig.ipConfigurations[c].publicIPAddress; 
          myNicArr.push({
               'name': myName, 
               'privateIPAllocationMethod': myPrivateIpMethod,
               'privateIPAddress': myPrivateIp, 
               'primary': myPrimary, 
               'publicIPAddress': myPublicIpId,
               'subnet': mySubnetId
          });    
     }
     
     for ( var i=theirNicArr.length-1; i>=0; i-- ) {
          if ( theirNicArr[i].name.includes(extIpConfigName) ) {           
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
     
     for ( var i=orphanedPipsArr.length-1; i>=0; i-- ) {          
          myNicArr.push({
               'name': orphanedPipsArr[i].name, 
               'privateIPAllocationMethod': orphanedPipsArr[i].privateIPAllocationMethod, 
               'privateIPAddress': orphanedPipsArr[i].privateIPAddress, 
               'primary': orphanedPipsArr[i].primary, 
               'publicIPAddress': orphanedPipsArr[i].publicIPAddress,
               'subnet': orphanedPipsArr[i].subnet
          }); 
     }
     
     var theirNicParams = { location: ourLocation, ipConfigurations:theirNicArr };    
     var myNicParams = { location: ourLocation, ipConfigurations:myNicArr };
     
     //if the HTTP response error.statusCode is 429 for associate or disassociate, want to retry every 15 seconds for 4 retries
     //is this the right way to nest my function calls?
     disassociateNicsPromisified(resourceGroup, theirNicName, theirNicParams)
     .then(function (result) {
          associateNicsPromisified(resourceGroup, myNicName, myNicParams);
     })
     .then(function (result) {
          logger.debug("Associate NICs result: ", result);
     })
     .catch(function (error) {
          logger.debug('Error: ', error);
     });
}

function disassociateNicsPromisified(resourceGroup, theirNicName, theirNicParams) {
     return new Promise(
     function (resolve, reject) {
          networkClient.networkInterfaces.createOrUpdate(resourceGroup, theirNicName, theirNicParams,
          (error, data) => {
               if (error) {
                    reject(error);
                    } else {
                    resolve(data);
               }
          });
     });
}

function associateNicsPromisified(resourceGroup, myNicName, myNicParams) {
     return new Promise(
     function (resolve, reject) {
          networkClient.networkInterfaces.createOrUpdate(resourceGroup, myNicName, myNicParams,
          (error, data) => {
               if (error) {
                    reject(error);
                    } else {
                    resolve(data);
               }
          });
     });
}

Promise.all([
     listAzNicsPromisified(resourceGroup),
     listPublicIPsPromisified(resourceGroup),
     listExtNicPromisified(),
])
.then((results) => {
     matchNics(results[0], results[1], results[2]);
})
.catch(err => {
     logger.debug('Error: ', err);
});