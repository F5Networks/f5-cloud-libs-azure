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
const assert = require('assert');

describe('failover tests', () => {
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

    beforeEach(() => {
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
    });

    afterEach(() => {
        Object.keys(require.cache).forEach((key) => {
            delete require.cache[key];
        });
    });

    describe('args tests', () => {
        it('bigip init test', (done) => {
            failover.run(argv, testOptions, () => {
                assert.strictEqual(functionsCalled.bigIp.init[1], 'admin');
                assert.strictEqual(functionsCalled.bigIp.init[2], 'file:///.bigiq_pass');
                assert.deepEqual(functionsCalled.bigIp.init[3], { port: '443' });
                done();
            });
        });
    });

    describe('get failover status tests', () => {
        beforeEach(() => {
            logger = LoggerMock.getLogger();
            logger.info = (message) => {
                loggedMessages.push(message);
            };
            logger.error = () => { };
            testOptions.logger = logger;

            argv = ['node', 'failover', '--log-level', 'info', '--tag-value', 'service1', '--dissociate-intf',
                dissociateIntf, '--associate-intf', associateIntf, '--password-data', 'file:///.bigiq_pass'];
        });

        it('is secondary test', (done) => {
            bigIpMock.list = function list() {
                return q({ nodeRole: 'SECONDARY' });
            };
            failover.run(argv, testOptions, () => {
                assert.notStrictEqual(loggedMessages.pop().indexOf('SECONDARY'), -1);
                assert.strictEqual(loggedMessages.pop().indexOf('PRIMARY'), -1);
                done();
            });
        });

        it('is primary test', (done) => {
            bigIpMock.list = function list() {
                return q({ nodeRole: 'PRIMARY' });
            };
            let messageString = '';
            logger.info = (message) => {
                messageString = `${messageString}-${message}`;
            };
            failover.run(argv, testOptions, () => {
                assert.notStrictEqual(messageString.indexOf('PRIMARY'), -1);
                assert.strictEqual(messageString.indexOf('SECONDARY'), -1);
                done();
            });
        });
    });

    describe('azure tests', () => {
        beforeEach(() => {
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
        });

        it('get vm information and configure azure test', (done) => {
            azureNetworkMock.publicIPAddresses.list = function list(resourceGroup, cb) {
                cb(new Error('not implemented'), 'error');
            };

            failover.run(argv, testOptions, () => {
                // test getInstanceVMInformation
                assert.deepEqual(functionsCalled.http.get.headers, { Metadata: 'True' });
                assert.notStrictEqual(functionsCalled.http.get.path.indexOf('/metadata/instance'), -1);
                // Test configureAzure
                assert.strictEqual(failover.subscriptionId, ourSubscription);
                done();
            });
        });

        it('get virtual ip address already assigned test', (done) => {
            failover.run(argv, testOptions, () => {
                assert.strictEqual(failover.associateRequired, false);
                assert.deepEqual(functionsCalled.azure.publicIPAddresses.list, ['my-rg']);
                done();
            });
        });

        it('construct nic parameters test', (done) => {
            instanceMetadata.network.interface[1].ipv4.ipAddress[0].publicIpAddress = '77.88.99.00';
            failover.run(argv, testOptions, () => {
                assert.strictEqual(failover.associateRequired, true);
                assert.deepEqual(functionsCalled.azure.networkInterfaces.get, [dissociateIntf, associateIntf]);
                done();
            });
        });

        it('move virtual address test', (done) => {
            functionsCalled.azure.networkInterfaces.createOrUpdate = [];
            instanceMetadata.network.interface[1].ipv4.ipAddress[0].publicIpAddress = '77.88.99.00';
            failover.run(argv, testOptions, () => {
                assert.strictEqual(failover.associateRequired, true);
                assert.deepEqual(
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
                assert.deepEqual(
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
                done();
            });
        });
    });
});
