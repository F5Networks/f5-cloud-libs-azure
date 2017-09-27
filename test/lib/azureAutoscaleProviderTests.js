/**
 * Copyright 2017 F5 Networks, Inc.
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

var q = require('q');
var azureMock;
var azureNetworkMock;
var azureStorageMock;
var azureComputeMock;
var bigIpMock;
var utilMock;
var AzureAutoscaleProvider;
var provider;

var clientId = 'myClientId';
var secret = 'mySecret';
var tenantId = 'myTenantId';
var subscriptionId = 'mySubscriptionId';
var storageAccount = 'myStorageAccount';
var storageKey = 'myStorageKey';

var ucsEntries = [];

var createBlobFromTextParams;

// Our tests cause too many event listeners. Turn off the check.
process.setMaxListeners(0);

module.exports = {
    setUp: function(callback) {
        utilMock = require('f5-cloud-libs').util;
        azureMock = require('ms-rest-azure');
        azureNetworkMock = require('azure-arm-network');
        azureStorageMock = require('azure-storage');
        azureComputeMock = require('azure-arm-compute');
        bigIpMock = require('f5-cloud-libs').bigIp;

        AzureAutoscaleProvider = require('../../lib/azureAutoscaleProvider');

        provider = new AzureAutoscaleProvider({clOptions: {user: 'foo', password: 'bar'}});

        azureStorageMock.createBlobService = function() {
            return {
                createContainerIfNotExists: function(container, cb) {
                    cb();
                }
            };
        };

        callback();
    },

    tearDown: function(callback) {
        Object.keys(require.cache).forEach(function(key) {
            delete require.cache[key];
        });
        callback();
    },

    testInit: {
        setUp: function(callback) {
            utilMock.getDataFromUrl = function() {
                return q(JSON.stringify({
                    clientId: clientId,
                    secret: secret,
                    tenantId: tenantId,
                    subscriptionId: subscriptionId,
                    storageAccount: storageAccount,
                    storageKey: storageKey
                }));
            };

            azureMock.loginWithServicePrincipalSecret = function(clientId, secret, tenantId, cb) {
                cb(null, {signRequest: function() {}});
            };

            callback();
        },

        testAzureLogin: function(test) {
            var providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar'
            };

            var receivedClientId;
            var receivedSecret;
            var receivedTenantId;

            azureMock.loginWithServicePrincipalSecret = function(clientId, secret, tenantId, cb) {
                receivedClientId = clientId;
                receivedSecret = secret;
                receivedTenantId = tenantId;
                cb(null, {signRequest: function() {}});
            };

            provider.init(providerOptions)
                .then(function() {
                    test.strictEqual(receivedClientId, clientId);
                    test.strictEqual(receivedSecret, secret);
                    test.strictEqual(receivedTenantId, tenantId);
                    test.done();
                });
        },

        testAzureLoginBadCredentialsUrl: function(test) {
            var errorMessage = 'bad url';
            utilMock.getDataFromUrl = function() {
                return q.reject(new Error(errorMessage));
            };

            test.expect(1);
            provider.init({azCredentialsUrl: 'file:///foo/bar'})
                .then(function() {
                    test.ok(false, 'Should have thrown bad url');
                })
                .catch(function(err) {
                    test.strictEqual(err.message, errorMessage);
                })
                .finally(function() {
                    test.done();
                });
        }
    },

    testGetInstanceId: {
        setUp: function(callback) {
            utilMock.getDataFromUrl = function() {
                return q({
                    compute: {
                        name: 'instance456'
                    }
                });
            };

            azureComputeMock.virtualMachineScaleSetVMs = {
                list: function(resourceGroup, scaleSetName, cb) {
                    cb(
                        null,
                        [
                            {
                                instanceId: '123',
                                provisioningState: 'Succeeded',
                                name: 'instance123'
                            },
                            {
                                instanceId: '456',
                                provisioningState: 'Succeeded',
                                name: 'instance456'
                            }
                        ]
                    );
                }
            };

            provider.computeClient = azureComputeMock;
            provider.networkClient = azureNetworkMock;

            callback();
        },

        testBasic: function(test) {
            test.expect(1);
            provider.getInstanceId()
                .then(function(instanceId) {
                    test.strictEqual(instanceId, '456');
                })
                .catch(function(err) {
                    test.ok(false, err);
                })
                .finally(function() {
                    test.done();
                });
        },

        testCached: function(test) {
            provider.instanceId = '789';
            test.expect(1);
            provider.getInstanceId()
                .then(function(instanceId) {
                    test.strictEqual(instanceId, '789');
                })
                .catch(function(err) {
                    test.ok(false, err);
                })
                .finally(function() {
                    test.done();
                });
        },

        testOurNameNotFound: function(test) {
            utilMock.getDataFromUrl = function() {
                return q({
                    compute: {
                        name: 'instance789'
                    }
                });
            };

            test.expect(1);
            provider.getInstanceId()
                .then(function() {
                    test.ok(false, 'should have thrown id not found');
                })
                .catch(function(err) {
                    test.notStrictEqual(err.message.indexOf('Unable to determine'), -1);
                })
                .finally(function() {
                    test.done();
                });
        },

        testBadMetaData: function(test) {
            utilMock.getDataFromUrl = function() {
                return q({});
            };

            test.expect(1);
            provider.getInstanceId()
                .then(function() {
                    test.ok(false, 'should have thrown id not found');
                })
                .catch(function(err) {
                    test.notStrictEqual(err.message.indexOf('Unable to determine'), -1);
                })
                .finally(function() {
                    test.done();
                });
        }
    },

    testGetInstances: {
        setUp: function(callback) {
            bigIpMock.prototype.init = function(host) {
                this.host = host;
                return q();
            };

            bigIpMock.prototype.list = function() {
                return q({
                    hostname: this.host + '_myHostname'
                });
            };

            azureComputeMock.virtualMachineScaleSetVMs = {
                list: function(resourceGroup, scaleSetName, cb) {
                    cb(
                        null,
                        [
                            {
                                instanceId: '123',
                                provisioningState: 'Succeeded',
                                id: 'instance/123'
                            },
                            {
                                instanceId: '456',
                                provisioningState: 'Succeeded',
                                id: 'instance/456'
                            }
                        ]
                    );
                }
            };

            azureNetworkMock.networkInterfaces = {
                listVirtualMachineScaleSetNetworkInterfaces: function(resourceGroup, scaleSet, cb) {
                    cb(null, {
                        '123': {
                            virtualMachine: {
                                id: 'instance/123'
                            },
                            ipConfigurations: [
                                {
                                    privateIPAddress: '5.6.7.8'
                                }
                            ]
                        },
                        '456': {
                            virtualMachine: {
                                id: 'instance/456'
                            },
                            ipConfigurations: [
                                {
                                    privateIPAddress: '7.8.9.0'
                                }
                            ]
                        }
                    });
                }
            };

            azureStorageMock.listBlobsSegmented = function(container, token, options, cb) {
                cb(null, {entries: []});
            };

            provider.computeClient = azureComputeMock;
            provider.networkClient = azureNetworkMock;
            provider.storageClient = azureStorageMock;

            callback();
        },

        testBasic: function(test) {

            test.expect(1);
            provider.getInstances()
                .then(function(instances) {
                    test.deepEqual(instances, {
                        '123': {
                            mgmtIp: '5.6.7.8',
                            privateIp: '5.6.7.8',
                            hostname: '5.6.7.8_myHostname',
                            providerVisible: true
                        },
                        '456': {
                            mgmtIp: '7.8.9.0',
                            privateIp: '7.8.9.0',
                            hostname: '7.8.9.0_myHostname',
                            providerVisible: true
                        }
                    });
                })
                .catch(function(err) {
                    test.ok(false, err);
                })
                .finally(function() {
                    test.done();
                });        },

        testInstancesInDb: function(test) {
            azureStorageMock.listBlobsSegmented = function(container, token, options, cb) {
                cb(null,
                    {
                        entries: [
                            {
                                name: "123"
                            },
                            {
                                name: "456"
                            }
                        ]
                    }
                );
            };

            azureStorageMock.getBlobToText = function(container, name, cb) {
                var instance;

                switch (name) {
                    case '123':
                        instance = {
                            isMaster: true,
                            mgmtIp: '5.6.7.8',
                            privateIp: '5.6.7.8',
                            hostname: '5.6.7.8_myHostname',
                            providerVisible: true,
                            masterStatus: {}
                        };
                        break;
                    case '456':
                    instance = {
                        isMaster: false,
                        mgmtIp: '7.8.9.0',
                        privateIp: '7.8.9.0',
                        hostname: '7.8.9.0_myHostname',
                        providerVisible: true,
                        masterStatus: {}
                    };
                    break;
                }
                cb(null, JSON.stringify(instance));
            };

            test.expect(1);
            provider.getInstances()
                .then(function(instances) {
                    test.deepEqual(instances, {
                        '123': {
                            mgmtIp: '5.6.7.8',
                            privateIp: '5.6.7.8',
                            hostname: '5.6.7.8_myHostname',
                            providerVisible: true,
                            isMaster: true,
                            masterStatus: {}
                        },
                        '456': {
                            mgmtIp: '7.8.9.0',
                            privateIp: '7.8.9.0',
                            hostname: '7.8.9.0_myHostname',
                            providerVisible: true,
                            isMaster: false,
                            masterStatus: {}
                        }
                    });
                })
                .catch(function(err) {
                    test.ok(false, err);
                })
                .finally(function() {
                    test.done();
                });
        },

        testNotProviderVisible: function(test) {
            azureComputeMock.virtualMachineScaleSetVMs = {
                list: function(resourceGroup, scaleSetName, cb) {
                    cb(
                        null,
                        [
                            {
                                instanceId: '123',
                                provisioningState: 'Failed',
                                id: 'instance/123'
                            },
                            {
                                instanceId: '456',
                                provisioningState: 'Succeeded',
                                id: 'instance/456'
                            }
                        ]
                    );
                }
            };

            test.expect(1);
            provider.getInstances()
                .then(function(instances) {
                    test.deepEqual(instances, {
                        '123': {
                            mgmtIp: '5.6.7.8',
                            privateIp: '5.6.7.8',
                            hostname: '5.6.7.8_myHostname',
                            providerVisible: false
                        },
                        '456': {
                            mgmtIp: '7.8.9.0',
                            privateIp: '7.8.9.0',
                            hostname: '7.8.9.0_myHostname',
                            providerVisible: true
                        }
                    });
                })
                .catch(function(err) {
                    test.ok(false, err);
                })
                .finally(function() {
                    test.done();
                });
        },

        testError: function(test) {
            var errorMessage = 'some error occurred';
            bigIpMock.prototype.init = function() {
                return q.reject(new Error(errorMessage));
            };

            test.expect(1);
            provider.getInstances()
                .then(function() {
                    test.ok(false, 'should have thrown');
                })
                .catch(function(err) {
                    test.strictEqual(err.message, errorMessage);
                })
                .finally(function() {
                    test.done();
                });
        }
    },

    testElectMaster: {
        testBasic: function(test) {
            var instances = {
                '123': {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: true
                },
                '456': {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: true
                }
            };

            test.expect(1);
            provider.electMaster(instances)
                .then(function(electedId) {
                    test.strictEqual(electedId, '123');
                    test.done();
                });
        },

        testLowestNotProviderVisible: function(test) {
            var instances = {
                '123': {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: false
                },
                '456': {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: true
                }
            };

            test.expect(1);
            provider.electMaster(instances)
                .then(function(electedId) {
                    test.strictEqual(electedId, '456');
                    test.done();
                });
        },

        testNoProviderVisible: function(test) {
            var instances = {
                '123': {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: false
                },
                '456': {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: false
                }
            };

            test.expect(1);
            provider.electMaster(instances)
                .then(function() {
                    test.ok(false, 'should have thrown no instances');
                })
                .catch(function(err) {
                    test.strictEqual(err.message, 'No possible master found');
                })
                .finally(function() {
                    test.done();
                });
        },

        testNoInstances: function(test) {
            var instances = [];

            test.expect(1);
            provider.electMaster(instances)
                .then(function() {
                    test.ok(false, 'should have thrown no instances');
                })
                .catch(function(err) {
                    test.strictEqual(err.message, 'No instances');
                })
                .finally(function() {
                    test.done();
                });
        }
    },

    testGetMasterCredentials: function(test) {
        var user = 'roger';
        var password = 'dodger';

        bigIpMock.user = user;
        bigIpMock.password = password;
        provider.bigIp = bigIpMock;

        test.expect(1);
        provider.getMasterCredentials()
            .then(function(credentials) {
                test.deepEqual(credentials, {
                    username: user,
                    password: password
                });
                test.done();
            });
    },

    testIsValidMaster: {
        setUp: function(callback) {
            bigIpMock.init = function() {
                return q();
            };

            bigIpMock.prototype.list = function() {
                return q(
                    {
                        hostname: 'foo'
                    }
                );
            };

            callback();
        },

        testValid: function(test) {
            var instanceId = '123';
            var instances = {
                '123': {
                    hostname: 'foo',
                    privateIp: '1.2.3.4'
                }
            };

            test.expect(1);
            provider.isValidMaster(instanceId, instances)
                .then(function(isValid) {
                    test.strictEqual(isValid, true);
                })
                .catch(function(err) {
                    test.ok(false, err);
                })
                .finally(function() {
                    test.done();
                });
        },

        testNotValid: function(test) {
            var instanceId = '123';
            var instances = {
                '123': {
                    hostname: 'bar',
                    privateIp: '1.2.3.4'
                }
            };

            test.expect(1);
            provider.isValidMaster(instanceId, instances)
                .then(function(isValid) {
                    test.strictEqual(isValid, false);
                })
                .catch(function(err) {
                    test.ok(false, err);
                })
                .finally(function() {
                    test.done();
                });
        }
    },

    testGetStoredUcs: {
        setUp: function(callback) {
            provider.storageClient = {
                listBlobsSegmented: function(container, foo, bar, cb) {
                    cb(null, {
                        entries: ucsEntries
                    });
                },

                createReadStream: function(container, name) {
                    return {
                        name: name
                    };
                }
            };

            callback();
        },

        testBasic: function(test) {
            ucsEntries = [
                {
                    name: 'my.ucs',
                    lastModified: 'Thu, 16 Mar 2017 18:08:54 GMT'
                }
            ];

            provider.getStoredUcs()
                .then(function(ucsData) {
                    test.strictEqual(ucsData.name, 'my.ucs');
                    test.done();
                });
        },

        testGetsLatest: function(test) {
            ucsEntries = [
                {
                    name: 'old.ucs',
                    lastModified: 'Thu, 16 Mar 2017 18:08:54 GMT'
                },
                {
                    name: 'new.ucs',
                    lastModified: 'Thu, 17 Mar 2017 18:08:54 GMT'
                }
            ];

            provider.getStoredUcs()
                .then(function(ucsData) {
                    test.strictEqual(ucsData.name, 'new.ucs');
                    test.done();
                });
        },

        testNoUcsFiles: function(test) {
            ucsEntries = [];
            provider.getStoredUcs()
                .then(function(ucsData) {
                    test.strictEqual(ucsData, undefined);
                    test.done();
                });
        },

        testListBlobsSegmentedError: function(test) {
            var errorMessage = 'foobar';
            provider.storageClient.listBlobsSegmented = function(container, foo, bar, cb) {
                cb(new Error(errorMessage));
            };

            test.expect(1);
            provider.getStoredUcs()
                .then(function() {
                    test.ok(false, 'listBlobsSegmented should have thrown');
                })
                .catch(function(err) {
                    test.strictEqual(err.message, errorMessage);
                })
                .finally(function() {
                    test.done();
                });
        }
    },

    testPutInstance: {
        setUp: function(callback) {
            azureStorageMock.createBlockBlobFromText = function(container, name, data, cb) {
                createBlobFromTextParams = {
                    container: container,
                    name: name,
                    data: data
                };
                cb();
            };
            createBlobFromTextParams = undefined;

            provider.storageClient = azureStorageMock;

            callback();
        },

        testBasic: function(test) {
            var instanceId = '123';
            var instance = {
                foo: 'bar'
            };

            test.expect(3);
            provider.putInstance(instanceId, instance)
                .then(function() {
                    var putData = JSON.parse(createBlobFromTextParams.data);
                    test.strictEqual(createBlobFromTextParams.name, instanceId);
                    test.strictEqual(putData.foo, instance.foo);
                    test.notStrictEqual(putData.lastUpdate, undefined);
                })
                .catch(function(err) {
                    test.ok(false, err);
                })
                .finally(function() {
                    test.done();
                });
        }
    }
};
