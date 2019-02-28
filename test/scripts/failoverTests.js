/**
 * Copyright 2019 F5 Networks, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const q = require('q');

let azureNetworkMock;

let bigIpMock;
let LoggerMock;
let httpMock;

const loggedMessages = [];
const ourSubscription = '1234-4567';
const dissociateIntf = 'test-int0';
const associateIntf = 'test-int1';

let failover;
let logger;
let instanceMetadata;

const functionsCalled = {
    bigIp: {},
    azure: {
        publicIPAddresses: {
            list: []
        },
        networkInterfaces: {
            get: [],
            createOrUpdate: []
        }
    },
    http: {},
};
const testOptions = {};
let argv;

// Our tests cause too many event listeners. Turn off the check.
process.setMaxListeners(0);

module.exports = {
    setUp(callback) {
        /* eslint-disable global-require */
        azureNetworkMock = require('azure-arm-network');
        httpMock = require('http');

        bigIpMock = require('@f5devcentral/f5-cloud-libs').bigIp;
        LoggerMock = require('@f5devcentral/f5-cloud-libs').logger;

        failover = require('../../scripts/failover');
        /* eslint-enable global-require */

        bigIpMock = {
            init() {
                functionsCalled.bigIp.init = arguments;
                return q();
            },
            list() {
                functionsCalled.bigIp.list = arguments;
                return q();
            }
        };

        httpMock.get = function get(optionsOrPath, cb) {
            // Force function to reject
            cb({ statusCode: 400 });
        };

        testOptions.bigIp = bigIpMock;

        argv = ['node', 'failover', '--log-level', 'none', '--tag-value', 'service1', '--dissociate-intf',
            dissociateIntf, '--associate-intf', associateIntf, '--password-data', 'file:///.bigiq_pass'];

        callback();
    },

    tearDown(callback) {
        Object.keys(require.cache).forEach((key) => {
            delete require.cache[key];
        });
        callback();
    },

    testArgs: {
        testBigIpInit(test) {
            failover.run(argv, testOptions, () => {
                test.expect(3);
                test.strictEqual(functionsCalled.bigIp.init[1], 'admin');
                test.strictEqual(functionsCalled.bigIp.init[2], 'file:///.bigiq_pass');
                test.deepEqual(functionsCalled.bigIp.init[3], { port: '443' });
                test.done();
            });
        }
    },

    testgetFailoverStatus: {
        setUp(callback) {
            logger = LoggerMock.getLogger();
            logger.info = (message) => {
                loggedMessages.push(message);
            };
            logger.error = () => { };
            testOptions.logger = logger;

            argv = ['node', 'failover', '--log-level', 'info', '--tag-value', 'service1', '--dissociate-intf',
                dissociateIntf, '--associate-intf', associateIntf, '--password-data', 'file:///.bigiq_pass'];

            callback();
        },

        testIsSecondary(test) {
            bigIpMock.list = function list() {
                return q({ nodeRole: 'SECONDARY' });
            };
            failover.run(argv, testOptions, () => {
                test.expect(2);
                test.notStrictEqual(loggedMessages.pop().indexOf('SECONDARY'), -1);
                test.strictEqual(loggedMessages.pop().indexOf('PRIMARY'), -1);
                test.done();
            });
        },

        testIsPrimary(test) {
            bigIpMock.list = function list() {
                return q({ nodeRole: 'PRIMARY' });
            };
            let messageString = '';
            logger.info = (message) => {
                messageString = `${messageString}-${message}`;
            };
            failover.run(argv, testOptions, () => {
                test.expect(2);
                test.notStrictEqual(messageString.indexOf('PRIMARY'), -1);
                test.strictEqual(messageString.indexOf('SECONDARY'), -1);
                test.done();
            });
        }
    },

    testAzure: {
        setUp(callback) {
            bigIpMock.list = function list() {
                return q({ nodeRole: 'PRIMARY' });
            };

            instanceMetadata = {
                compute: {
                    subscriptionId: ourSubscription,
                    resourceGroupName: 'my-rg'
                },
                network: {
                    interface: [
                        {
                            ipv4: {
                                ipAddress: [
                                    {
                                        privateIpAddress: '10.0.1.7',
                                        publicIpAddress: '56.78.90.12'
                                    }
                                ]
                            },
                            ipv6: {
                                ipAddress: []
                            }
                        },
                        {
                            ipv4: {
                                ipAddress: [
                                    {
                                        privateIpAddress: '10.0.2.8',
                                        publicIpAddress: '22.33.44.55'
                                    },
                                    {
                                        privateIpAddress: '10.0.2.9',
                                        publicIpAddress: '23.34.45.56'
                                    }
                                ]
                            },
                            ipv6: {
                                ipAddress: []
                            }
                        }
                    ]
                }
            };

            httpMock.get = function get(optionsOrPath, cb) {
                if (optionsOrPath && optionsOrPath.path.indexOf('/metadata/instance?api-version') > -1) {
                    functionsCalled.http.get = {
                        headers: optionsOrPath.headers,
                        path: optionsOrPath.path
                    };

                    cb({
                        statusCode: 200,
                        on(event, onCb) {
                            if (event === 'data') {
                                onCb(JSON.stringify(instanceMetadata));
                            }
                            if (event === 'end') {
                                onCb();
                            }
                        },
                    });
                }
            };

            azureNetworkMock.publicIPAddresses = {
                list(resourceGroup, cb) {
                    functionsCalled.azure.publicIPAddresses.list.push(resourceGroup);
                    cb(null, [
                        {
                            id: '/publicIPAddresses/self-pip0',
                            tags: {
                                application: 'app1',
                                environment: 'staging'
                            },
                            ipAddress: '11.22.33.44'
                        },
                        {
                            id: `/publicIPAddresses/${associateIntf}`,
                            tags: {
                                f5_deployment: 'service1',
                                application: 'app1',
                                environment: 'staging'
                            },
                            ipAddress: '22.33.44.55'
                        },
                        {
                            id: '/publicIPAddresses/self-pip1',
                            tags: {
                                application: 'app1',
                                environment: 'staging'
                            },
                            ipAddress: '33.44.55.66'
                        }
                    ]);
                }
            };

            azureNetworkMock.networkInterfaces = {
                createOrUpdate(resourceGroup, interfaceName, params, cb) {
                    functionsCalled.azure.networkInterfaces.createOrUpdate[interfaceName] = params;
                    cb(null, 'success');
                },
                get(resourceGroup, networkInterface, cb) {
                    functionsCalled.azure.networkInterfaces.get.push(networkInterface);

                    if (networkInterface === dissociateIntf) {
                        cb(null, {
                            ipConfigurations:
                                [
                                    {
                                        primary: true,
                                        publicIPAddress: '11.22.33.44'
                                    },
                                    {
                                        primary: false,
                                        publicIPAddress: '99.88.77.66'
                                    }
                                ],
                            name: networkInterface
                        });
                    } else if (networkInterface === associateIntf) {
                        cb(null, {
                            ipConfigurations:
                                [
                                    {
                                        primary: true,
                                        publicIPAddress: '11.22.33.44'
                                    },
                                    {
                                        primary: false,
                                        publicIPAddress: '88.77.66.55'
                                    }
                                ],
                            name: networkInterface
                        });
                    }
                }
            };

            testOptions.networkClient = azureNetworkMock;

            callback();
        },

        testGetVmInformationAndConfigureAzure(test) {
            azureNetworkMock.publicIPAddresses.list = function list(resourceGroup, cb) {
                cb(new Error('not implemented'), 'error');
            };

            failover.run(argv, testOptions, () => {
                test.expect(3);
                // test getInstanceVMInformation
                test.deepEqual(functionsCalled.http.get.headers, { Metadata: 'True' });
                test.notStrictEqual(functionsCalled.http.get.path.indexOf('/metadata/instance'), -1);
                // Test configureAzure
                test.strictEqual(failover.subscriptionId, ourSubscription);
                test.done();
            });
        },

        testGetVirtualIPAddressAlreadyAssigned(test) {
            failover.run(argv, testOptions, () => {
                test.expect(2);
                test.strictEqual(failover.associateRequired, false);
                test.deepEqual(functionsCalled.azure.publicIPAddresses.list, ['my-rg']);
                test.done();
            });
        },

        testConstructNicParameters(test) {
            instanceMetadata.network.interface[1].ipv4.ipAddress[0].publicIpAddress = '77.88.99.00';
            failover.run(argv, testOptions, () => {
                test.expect(2);
                test.strictEqual(failover.associateRequired, true);
                test.deepEqual(functionsCalled.azure.networkInterfaces.get, [dissociateIntf, associateIntf]);
                test.done();
            });
        },

        testMoveVirtualAddress(test) {
            functionsCalled.azure.networkInterfaces.createOrUpdate = [];
            instanceMetadata.network.interface[1].ipv4.ipAddress[0].publicIpAddress = '77.88.99.00';
            failover.run(argv, testOptions, () => {
                test.expect(3);
                test.strictEqual(failover.associateRequired, true);
                test.deepEqual(
                    functionsCalled.azure.networkInterfaces.createOrUpdate[dissociateIntf].ipConfigurations,
                    [
                        {
                            primary: true,
                            publicIPAddress: '11.22.33.44'
                        },
                        {
                            primary: false
                        }
                    ]
                );
                test.deepEqual(
                    functionsCalled.azure.networkInterfaces.createOrUpdate[associateIntf].ipConfigurations,
                    [
                        {
                            primary: true,
                            publicIPAddress: '11.22.33.44'
                        },
                        {
                            primary: false,
                            publicIPAddress: { id: '/publicIPAddresses/test-int1' }
                        }
                    ]
                );
                test.done();
            });
        }
    }
};
