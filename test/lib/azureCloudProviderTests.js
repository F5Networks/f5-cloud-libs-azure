/**
 * Copyright 2017-2018 F5 Networks, Inc.
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

const assert = require('assert');

process.env.NODE_PATH = `${__dirname}/../../../`;
require('module').Module._initPaths(); // eslint-disable-line no-underscore-dangle

const q = require('q');

describe('onboard tests', () => {
    const clientId = 'myClientId';
    const secret = 'mySecret';
    const tenantId = 'myTenantId';
    const subscriptionId = 'mySubscriptionId';
    const storageAccount = 'myStorageAccount';
    const storageKey = 'myStorageKey';

    let ucsEntries = [];

    let authnMock;
    let icontrolMock;
    let azureMock;
    let azureNetworkMock;
    let azureStorageMock;
    let azureComputeMock;
    let bigIpMock;
    let utilMock;
    let localCryptoUtilMock;
    let AzureCloudProvider;
    let AutoscaleInstance;
    let provider;
    let createBlobFromTextParams;
    let virtualMachineScaleSetUpdateParams;

    let getBlobToTextParams;

    let receivedClientId;
    let receivedSecret;
    let receivedTenantId;
    let receivedAzureEnvironment;

    let azureLocation;
    let deleteBlobIfExistsCalled = false;
    // Our tests cause too many event listeners. Turn off the check.
    process.setMaxListeners(0);

    beforeEach(() => {
        /* eslint-disable import/no-extraneous-dependencies, import/no-unresolved, global-require */
        utilMock = require('@f5devcentral/f5-cloud-libs').util;
        localCryptoUtilMock = require('@f5devcentral/f5-cloud-libs').localCryptoUtil;
        azureMock = require('ms-rest-azure');
        azureNetworkMock = require('azure-arm-network');
        azureStorageMock = require('azure-storage');
        azureComputeMock = require('azure-arm-compute');
        bigIpMock = require('@f5devcentral/f5-cloud-libs').bigIp;
        authnMock = require('@f5devcentral/f5-cloud-libs').authn;
        icontrolMock = require('@f5devcentral/f5-cloud-libs').iControl;

        AzureCloudProvider = require('../../lib/azureCloudProvider');
        AutoscaleInstance = require('@f5devcentral/f5-cloud-libs').autoscaleInstance;
        /* eslint-enable import/no-extraneous-dependencies, import/no-unresolved, global-require */

        utilMock.getProduct = function getProduct() {
            return q('BIG-IP');
        };

        provider = new AzureCloudProvider({ clOptions: { user: 'foo', password: 'bar' } });
        provider.resourceGroup = 'my resource group';

        azureStorageMock.createBlobService = function createBlobService() {
            return {
                createContainerIfNotExists(container, cb) {
                    cb();
                }
            };
        };
    });

    afterEach(() => {
        Object.keys(require.cache).forEach((key) => {
            delete require.cache[key];
        });
    });

    describe('init tests', () => {
        beforeEach(() => {
            const credentialsBlob = {
                clientId,
                secret,
                tenantId,
                subscriptionId,
                storageAccount,
                storageKey
            };

            azureLocation = 'westus';

            utilMock.getDataFromUrl = function getDataFromUrl(url) {
                if (url.indexOf('http://169.254.169.254') !== -1) {
                    return q({
                        compute: {
                            location: azureLocation
                        }
                    });
                }
                return q(JSON.stringify(credentialsBlob));
            };

            localCryptoUtilMock.symmetricDecryptPassword = function symmetricDecryptPassword() {
                return q(JSON.stringify(credentialsBlob));
            };

            azureMock.loginWithServicePrincipalSecret = function loginWithServicePrincipalSecret(
                aClientId,
                aSecret,
                aTenantId,
                options,
                cb
            ) {
                receivedClientId = aClientId;
                receivedSecret = aSecret;
                receivedTenantId = aTenantId;
                receivedAzureEnvironment = options.environment;
                cb(null, { signRequest() { } });
            };
        });

        it('azure login test', (done) => {
            const providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar'
            };

            provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(receivedClientId, clientId);
                    assert.strictEqual(receivedSecret, secret);
                    assert.strictEqual(receivedTenantId, tenantId);
                    done();
                });
        });

        it('azure gov test', (done) => {
            azureLocation = 'USGovArizona';

            const providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar'
            };

            provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(receivedClientId, clientId);
                    assert.strictEqual(receivedSecret, secret);
                    assert.strictEqual(receivedTenantId, tenantId);
                    assert.strictEqual(receivedAzureEnvironment.name, 'AzureUSGovernment');
                    done();
                });
        });

        it('provider options azure gov login test', (done) => {
            const providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar',
                environment: 'AzureUSGovernment'
            };

            provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(receivedClientId, clientId);
                    assert.strictEqual(receivedSecret, secret);
                    assert.strictEqual(receivedTenantId, tenantId);
                    assert.strictEqual(receivedAzureEnvironment.name, 'AzureUSGovernment');
                    done();
                });
        });

        it('azure login encrypted test', (done) => {
            const providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar',
                azCredentialsEncrypted: true
            };

            provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(receivedClientId, clientId);
                    assert.strictEqual(receivedSecret, secret);
                    assert.strictEqual(receivedTenantId, tenantId);
                    done();
                });
        });

        it('azure login bad credentials url test', (done) => {
            const errorMessage = 'bad url';
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q.reject(new Error(errorMessage));
            };

            provider.init({ azCredentialsUrl: 'file:///foo/bar' })
                .then(() => {
                    assert.ok(false, 'Should have thrown bad url');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, errorMessage);
                })
                .finally(() => {
                    done();
                });
        });
    });
    
    describe('get instance id tests', () => {
        beforeEach(() => {
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q({
                    compute: {
                        name: 'instance456'
                    }
                });
            };

            azureComputeMock.virtualMachineScaleSetVMs = {
                list(resourceGroup, scaleSetName, options, cb) {
                    cb(
                        null,
                        [
                            {
                                instanceId: '123',
                                provisioningState: 'Succeeded',
                                name: 'instance123',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            },
                            {
                                instanceId: '456',
                                provisioningState: 'Succeeded',
                                name: 'instance456',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            }
                        ]
                    );
                }
            };

            provider.computeClient = azureComputeMock;
            provider.networkClient = azureNetworkMock;
            provider.scaleSet = 'my scale set';
            provider.resourceGroup = 'my resource group';
        });

        it('basic test', (done) => {
            provider.getInstanceId()
                .then((instanceId) => {
                    assert.strictEqual(instanceId, '456');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('cached test', (done) => {
            provider.instanceId = '789';
            provider.getInstanceId()
                .then((instanceId) => {
                    assert.strictEqual(instanceId, '789');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('static test', (done) => {
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q({
                    compute: {
                        name: 'instance888',
                        vmId: '888'
                    }
                });
            };

            provider.clOptions.static = true;

            provider.getInstanceId()
                .then((instanceId) => {
                    assert.strictEqual(instanceId, '888');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('out name not found test', (done) => {
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q({
                    compute: {
                        name: 'instance789'
                    }
                });
            };

            provider.getInstanceId()
                .then(() => {
                    assert.ok(false, 'should have thrown id not found');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('Unable to determine'), -1);
                })
                .finally(() => {
                    done();
                });
        });

        it('bad metadata test', (done) => {
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q({});
            };

            provider.getInstanceId()
                .then(() => {
                    assert.ok(false, 'should have thrown id not found');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('not found in metadata'), -1);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('delete stored ucs tests', () => {
        beforeEach(() => {
            provider.storageClient = {
                deleteBlobIfExists: function(c,n, cb) {
                    deleteBlobIfExistsCalled = true;
                    cb(null, 'Success');
                },
                BACKUP_CONTAINER: 'backup'
            };
        });

        it('exists test', (done) => {
            provider.deleteStoredUcs('foo.ucs')
                .then(() => {
                    assert.ok(true);
                    assert.ok(deleteBlobIfExistsCalled);
                })
                .catch((err) => {
                    assert.ok(false, err.message);
                })
                .finally(() => {
                    deleteBlobIfExistsCalled = false;
                    done();
                });
        });
    });

    describe('get instances tests', () => {
        beforeEach(() => {
            bigIpMock.prototype.init = function init(host) {
                this.host = host;
                return q();
            };

            bigIpMock.prototype.list = function list() {
                return q({
                    hostname: `${this.host}_myHostname`
                });
            };

            azureComputeMock.virtualMachineScaleSetVMs = {
                list(resourceGroup, scaleSetName, options, cb) {
                    cb(
                        null,
                        [
                            {
                                instanceId: '123',
                                provisioningState: 'Succeeded',
                                id: 'instance/123',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            },
                            {
                                instanceId: '456',
                                provisioningState: 'Succeeded',
                                id: 'instance/456',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            }
                        ]
                    );
                }
            };

            azureNetworkMock.networkInterfaces = {
                listVirtualMachineScaleSetNetworkInterfaces(resourceGroup, scaleSet, cb) {
                    cb(null, {
                        123: {
                            virtualMachine: {
                                id: 'instance/123'
                            },
                            ipConfigurations: [
                                {
                                    privateIPAddress: '5.6.7.8',
                                    publicIPAddress: {
                                        id: 'one/two/three/four/five/six/seven/ipName'
                                    }
                                }
                            ]
                        },
                        456: {
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

            azureNetworkMock.publicIPAddresses = {
                get(resourceGroup, publicIpName, cb) {
                    cb(null, {
                        ipAddress: '123.456.789.1'
                    });
                }
            };

            azureStorageMock.listBlobsSegmented = function listBlobsSegmented(container, token, options, cb) {
                cb(null, { entries: [] });
            };

            provider.computeClient = azureComputeMock;
            provider.networkClient = azureNetworkMock;
            provider.storageClient = azureStorageMock;
            provider.scaleSet = 'my scale set';
            provider.resourceGroup = 'my resource group';
        });

        it('basic test', (done) => {
            provider.getInstances()
                .then((instances) => {
                    assert.strictEqual(instances['123'].mgmtIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].privateIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].publicIp, '123.456.789.1');
                    assert.strictEqual(instances['123'].hostname, '5.6.7.8_myHostname');
                    assert.strictEqual(instances['123'].providerVisible, true);
                    assert.strictEqual(instances['123'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['123'].isPrimary, false);
                    assert.strictEqual(instances['123'].external, false);
                    assert.strictEqual(instances['123'].lastBackup, new Date(1970, 1, 1).getTime());
                    assert.strictEqual(instances['123'].versionOk, true);

                    assert.strictEqual(instances['456'].mgmtIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].privateIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].hostname, '7.8.9.0_myHostname');
                    assert.strictEqual(instances['456'].providerVisible, true);
                    assert.strictEqual(instances['456'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['456'].isPrimary, false);
                    assert.strictEqual(instances['456'].external, false);
                    assert.strictEqual(instances['456'].lastBackup, new Date(1970, 1, 1).getTime());
                    assert.strictEqual(instances['456'].versionOk, true);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('instances in db test', (done) => {
            azureStorageMock.listBlobsSegmented = function listBlobsSegmented(container, token, options, cb) {
                cb(null,
                    {
                        entries: [
                            {
                                name: '123'
                            },
                            {
                                name: '456'
                            }
                        ]
                    });
            };

            azureStorageMock.getBlobToText = function getBlobToText(container, name, cb) {
                let instance;

                switch (name) {
                case '123':
                    instance = {
                        isPrimary: true,
                        mgmtIp: '5.6.7.8',
                        privateIp: '5.6.7.8',
                        publicIp: '123.456.789.1',
                        hostname: '5.6.7.8_myHostname',
                        providerVisible: true,
                        primaryStatus: {}
                    };
                    break;
                case '456':
                    instance = {
                        isPrimary: false,
                        mgmtIp: '7.8.9.0',
                        privateIp: '7.8.9.0',
                        hostname: '7.8.9.0_myHostname',
                        providerVisible: true,
                        primaryStatus: {}
                    };
                    break;
                default:
                    instance = {};
                }
                cb(null, JSON.stringify(instance));
            };

            provider.getInstances()
                .then((instances) => {
                    assert.deepEqual(instances, {
                        123: {
                            mgmtIp: '5.6.7.8',
                            privateIp: '5.6.7.8',
                            publicIp: '123.456.789.1',
                            hostname: '5.6.7.8_myHostname',
                            providerVisible: true,
                            isPrimary: true,
                            primaryStatus: {}
                        },
                        456: {
                            mgmtIp: '7.8.9.0',
                            privateIp: '7.8.9.0',
                            hostname: '7.8.9.0_myHostname',
                            providerVisible: true,
                            isPrimary: false,
                            primaryStatus: {}
                        }
                    });
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('Not Provider Visible Provisioning State test', (done) => {
            azureComputeMock.virtualMachineScaleSetVMs = {
                list(resourceGroup, scaleSetName, options, cb) {
                    cb(
                        null,
                        [
                            {
                                instanceId: '123',
                                provisioningState: 'Failed',
                                id: 'instance/123',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            },
                            {
                                instanceId: '456',
                                provisioningState: 'Succeeded',
                                id: 'instance/456',
                                instanceView: {
                                    instanceId: '456',
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            }
                        ]
                    );
                }
            };

            provider.getInstances()
                .then((instances) => {
                    assert.strictEqual(instances['123'].mgmtIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].privateIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].publicIp, '123.456.789.1');
                    assert.strictEqual(instances['123'].hostname, '5.6.7.8_myHostname');
                    assert.strictEqual(instances['123'].providerVisible, false);
                    assert.strictEqual(instances['123'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['123'].isPrimary, false);
                    assert.strictEqual(instances['123'].external, false);
                    assert.strictEqual(instances['123'].versionOk, true);

                    assert.strictEqual(instances['456'].mgmtIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].privateIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].hostname, '7.8.9.0_myHostname');
                    assert.strictEqual(instances['456'].providerVisible, true);
                    assert.strictEqual(instances['456'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['456'].isPrimary, false);
                    assert.strictEqual(instances['456'].external, false);
                    assert.strictEqual(instances['456'].versionOk, true);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('Not Provider Visible Power State test', (done) => {
            azureComputeMock.virtualMachineScaleSetVMs = {
                list(resourceGroup, scaleSetName, options, cb) {
                    cb(
                        null,
                        [
                            {
                                instanceId: '123',
                                provisioningState: 'Succeeded',
                                id: 'instance/123',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            },
                            {
                                instanceId: '456',
                                provisioningState: 'Succeeded',
                                id: 'instance/456',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'powerstate/deallocated',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            }
                        ]
                    );
                }
            };

            provider.getInstances()
                .then((instances) => {
                    assert.strictEqual(instances['123'].mgmtIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].privateIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].publicIp, '123.456.789.1');
                    assert.strictEqual(instances['123'].hostname, '5.6.7.8_myHostname');
                    assert.strictEqual(instances['123'].providerVisible, true);
                    assert.strictEqual(instances['123'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['123'].isPrimary, false);
                    assert.strictEqual(instances['123'].external, false);
                    assert.strictEqual(instances['123'].versionOk, true);

                    assert.strictEqual(instances['456'].mgmtIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].privateIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].hostname, '7.8.9.0_myHostname');
                    assert.strictEqual(instances['456'].providerVisible, false);
                    assert.strictEqual(instances['456'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['456'].isPrimary, false);
                    assert.strictEqual(instances['456'].external, false);
                    assert.strictEqual(instances['456'].versionOk, true);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('Not Provider Visible Power State Function Error test', (done) => {
            azureComputeMock.virtualMachineScaleSetVMs = {
                list(resourceGroup, scaleSetName, options, cb) {
                    cb(
                        null,
                        [
                            {
                                instanceId: '123',
                                provisioningState: 'Succeeded',
                                id: 'instance/123',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            },
                            {
                                instanceId: '456',
                                provisioningState: 'Succeeded',
                                id: 'instance/456',
                                instanceView: {
                                    statuses: [
                                        {
                                            code: 'ProvisioningState/succeeded',
                                            level: 'Info',
                                            displayStatus: 'Ready',
                                            message: 'Guest Agent is running',
                                            time: '2020-02-03T19:17:07.000Z'
                                        }
                                    ]
                                }
                            }
                        ]
                    );
                }
            };

            provider.getInstances()
                .then((instances) => {
                    assert.strictEqual(instances['123'].mgmtIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].privateIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].publicIp, '123.456.789.1');
                    assert.strictEqual(instances['123'].hostname, '5.6.7.8_myHostname');
                    assert.strictEqual(instances['123'].providerVisible, true);
                    assert.strictEqual(instances['123'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['123'].isPrimary, false);
                    assert.strictEqual(instances['123'].external, false);
                    assert.strictEqual(instances['123'].versionOk, true);

                    assert.strictEqual(instances['456'].mgmtIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].privateIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].hostname, '7.8.9.0_myHostname');
                    assert.strictEqual(instances['456'].providerVisible, true);
                    assert.strictEqual(instances['456'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['456'].isPrimary, false);
                    assert.strictEqual(instances['456'].external, false);
                    assert.strictEqual(instances['456'].versionOk, true);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('External tag test', (done) => {
            const externalTag = {
                key: 'foo',
                value: 'bar'
            };

            const interfaceName = 'myInterface';
            const resourceGroupName = 'myResourceGroup';

            azureComputeMock.virtualMachines = {
                list(resourceGroup, cb) {
                    cb(
                        null,
                        [
                            {
                                name: 'vm888',
                                networkProfile: {
                                    networkInterfaces: [
                                        {
                                            // eslint-disable-next-line max-len
                                            id: '/subscriptions/foofoo/resourceGroups/barbar01/providers/Microsoft.Network/networkInterfaces/barbar01-mgmt0',
                                            properties: {
                                                primary: true
                                            }
                                        }
                                    ]
                                },
                                tags: {
                                    foo: externalTag.value
                                }
                            }
                        ]
                    );
                },
            };

            azureComputeMock.virtualMachineScaleSets = {
                list(resourceGroup, cb) {
                    cb(null, []);
                }
            };

            azureNetworkMock.networkInterfaces.get = function get(resourceGroup, nicName, cb) {
                cb(
                    null,
                    {
                        id: `networkInterface1/one/two/three/${resourceGroupName}/five`,
                        name: interfaceName,
                        ipConfigurations: [
                            {
                                primary: true,
                                privateIPAddress: '10.11.12.13'
                            }
                        ]
                    }
                );
            };

            provider.getInstances({ externalTag })
                .then((instances) => {
                    assert.strictEqual(instances['123'].mgmtIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].privateIp, '5.6.7.8');
                    assert.strictEqual(instances['123'].publicIp, '123.456.789.1');
                    assert.strictEqual(instances['123'].hostname, '5.6.7.8_myHostname');
                    assert.strictEqual(instances['123'].providerVisible, true);
                    assert.strictEqual(instances['123'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['123'].isPrimary, false);
                    assert.strictEqual(instances['123'].external, false);
                    assert.strictEqual(instances['123'].versionOk, true);

                    assert.strictEqual(instances['456'].mgmtIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].privateIp, '7.8.9.0');
                    assert.strictEqual(instances['456'].hostname, '7.8.9.0_myHostname');
                    assert.strictEqual(instances['456'].providerVisible, true);
                    assert.strictEqual(instances['456'].status, AutoscaleInstance.INSTANCE_STATUS_OK);
                    assert.strictEqual(instances['456'].isPrimary, false);
                    assert.strictEqual(instances['456'].external, false);
                    assert.strictEqual(instances['456'].versionOk, true);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('error test', (done) => {
            const errorMessage = 'some error occurred';
            bigIpMock.prototype.init = function init() {
                return q.reject(new Error(errorMessage));
            };

            provider.getInstances()
                .then(() => {
                    assert.ok(false, 'should have thrown');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, errorMessage);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('get nodes by resource id tests', () => {
        beforeEach(() => {
            azureNetworkMock.networkInterfaces = {
                listVirtualMachineScaleSetNetworkInterfaces(resourceGroup, scaleSet, cb) {
                    cb(null, [
                        {
                            id: '/subscriptions/mySubId/resourceGroups/myResourceGroup/providers/Microsoft.Compute/virtualMachineScaleSets/myScaleSetName/virtualMachines/3/networkInterfaces/nic1',
                            virtualMachine: {
                                id: 'instance/123'
                            },
                            ipConfigurations: [
                                {
                                    privateIPAddress: '5.6.7.8',
                                    primary: true
                                }
                            ],
                            primary: true
                        },
                        {
                            virtualMachine: {
                                id: 'instance/456'
                            },
                            ipConfigurations: [
                                {
                                    privateIPAddress: '7.8.9.0'
                                }
                            ]
                        }
                    ]);
                }
            };

            provider.computeClient = azureComputeMock;
            provider.networkClient = azureNetworkMock;
            provider.scaleSet = 'my scale set';
            provider.resourceGroup = 'my resource group';
        });

        it('basic test', (done) => {
            provider.getNodesByResourceId('resourceId', 'scaleSet')
                .then((instances) => {
                    assert.strictEqual(instances.length, 1);
                    assert.strictEqual(instances[0].ip.private, '5.6.7.8');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('bad resource type test', (done) => {
            provider.getNodesByResourceId('resourceId', 'resourceType')
                .then(() => {
                    assert.ok(false, 'should have thrown');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('supported'), -1);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('elect primary tests', () => {
        it('basic test', (done) => {
            const instances = {
                123: {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: true,
                    versionOk: true
                },
                456: {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: true,
                    versionOk: true
                }
            };

            provider.electPrimary(instances)
                .then((electedId) => {
                    assert.strictEqual(electedId, '123');
                    done();
                });
        });

        it('lowest not provider visible test', (done) => {
            const instances = {
                123: {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: false,
                    versionOk: true
                },
                456: {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: true,
                    versionOk: true
                }
            };

            provider.electPrimary(instances)
                .then((electedId) => {
                    assert.strictEqual(electedId, '456');
                    done();
                });
        });

        it('no provider visible test', (done) => {
            const instances = {
                123: {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: false,
                    versionOk: true
                },
                456: {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: false,
                    versionOk: true
                }
            };

            provider.electPrimary(instances)
                .then(() => {
                    assert.ok(false, 'should have thrown no instances');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, 'No possible primary found');
                })
                .finally(() => {
                    done();
                });
        });

        it('lowest not version test', (done) => {
            const instances = {
                123: {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: true,
                    versionOk: false
                },
                456: {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: true,
                    versionOk: true
                }
            };

            provider.electPrimary(instances)
                .then((electedId) => {
                    assert.strictEqual(electedId, '456');
                    done();
                });
        });

        it('external instances test', (done) => {
            const instances = {
                123: {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: true,
                    versionOk: true
                },
                456: {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: true,
                    versionOk: true
                },
                999: {
                    mgmtIp: '10.11.12.13',
                    privateIp: '10.11.12.13',
                    hostname: '10.11.12.13_myHostname',
                    providerVisible: true,
                    external: true,
                    versionOk: true
                },
                888: {
                    mgmtIp: '13.14.15.16',
                    privateIp: '13.14.15.16',
                    hostname: '13.14.15.16_myHostname',
                    providerVisible: true,
                    external: true,
                    versionOk: true
                }
            };

            provider.electPrimary(instances)
                .then((electedId) => {
                    assert.strictEqual(electedId, '999');
                    done();
                });
        });

        it('no instances test', (done) => {
            const instances = [];

            provider.electPrimary(instances)
                .then(() => {
                    assert.ok(false, 'should have thrown no instances');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, 'No instances');
                })
                .finally(() => {
                    done();
                });
        });
    });

    it('get primary credentials test', (done) => {
        const user = 'roger';
        const password = 'dodger';

        bigIpMock.isInitialized = true;
        bigIpMock.user = user;
        bigIpMock.password = password;
        provider.bigIp = bigIpMock;

        provider.getPrimaryCredentials()
            .then((credentials) => {
                assert.deepEqual(credentials, {
                    password,
                    username: user
                });
                done();
            });
    }).timeout(5000);

    describe('is valid primary tests', () => {
        beforeEach(() => {
            bigIpMock.init = function init() {
                return q();
            };

            bigIpMock.prototype.list = function list() {
                return q(
                    {
                        hostname: 'foo'
                    }
                );
            };

            bigIpMock.prototype.ready = function ready() {
                return q();
            };

            authnMock.authenticate = function authenticate(host, user, password) {
                icontrolMock.password = password;
                return q.resolve(icontrolMock);
            };
        });

        it('valid test', (done) => {
            const instanceId = '123';
            const instances = {
                123: {
                    hostname: 'foo',
                    privateIp: '1.2.3.4'
                }
            };

            provider.isValidPrimary(instanceId, instances)
                .then((isValid) => {
                    assert.strictEqual(isValid, true);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('not valid test', (done) => {
            const instanceId = '123';
            const instances = {
                123: {
                    hostname: 'bar',
                    privateIp: '1.2.3.4'
                }
            };

            provider.isValidPrimary(instanceId, instances)
                .then((isValid) => {
                    assert.strictEqual(isValid, false);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('tag primary tests', () => {
        beforeEach(() => {
            azureComputeMock.virtualMachineScaleSets = {
                get(resourceGroup, scaleSetName, options, cb) {
                    cb(null,
                        {
                            tags: {
                                application: 'APP',
                                cost: 'COST',
                                'resourceGroupName-primary': '10.0.1.4'
                            }
                        });
                },
                update(resourceGroup, scaleSet, params, options, cb) {
                    virtualMachineScaleSetUpdateParams = {
                        resourceGroup,
                        scaleSet,
                        params,
                        options
                    };
                    cb();
                }
            };

            provider.computeClient = azureComputeMock;
            provider.networkClient = azureNetworkMock;
            provider.scaleSet = 'scaleSetName';
            provider.resourceGroup = 'resourceGroupName';
        });

        it('tag primary instance test', (done) => {
            const primaryIid = '456';
            const instances = {
                123: {
                    mgmtIp: '5.6.7.8',
                    privateIp: '5.6.7.8',
                    hostname: '5.6.7.8_myHostname',
                    providerVisible: true,
                    versionOk: true
                },
                456: {
                    mgmtIp: '7.8.9.0',
                    privateIp: '7.8.9.0',
                    hostname: '7.8.9.0_myHostname',
                    providerVisible: true,
                    versionOk: true
                }
            };

            provider.tagPrimaryInstance(primaryIid, instances)
                .then(() => {
                    assert.strictEqual(
                        virtualMachineScaleSetUpdateParams.params.tags['resourceGroupName-primary'],
                        instances[primaryIid].privateIp
                    );
                    assert.strictEqual(virtualMachineScaleSetUpdateParams.params.tags.application, 'APP');
                    assert.strictEqual(virtualMachineScaleSetUpdateParams.resourceGroup, 'resourceGroupName');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('get stored ucs tests', () => {
        beforeEach(() => {
            provider.storageClient = {
                listBlobsSegmented(container, foo, bar, cb) {
                    cb(null, {
                        entries: ucsEntries
                    });
                },

                createReadStream(container, name) {
                    return { name };
                }
            };
        });

        it('basic test', (done) => {
            ucsEntries = [
                {
                    name: 'my.ucs',
                    lastModified: 'Thu, 16 Mar 2017 18:08:54 GMT'
                }
            ];

            provider.getStoredUcs()
                .then((ucsData) => {
                    assert.strictEqual(ucsData.name, 'my.ucs');
                    done();
                });
        });

        it('gets latest test', (done) => {
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
                .then((ucsData) => {
                    assert.strictEqual(ucsData.name, 'new.ucs');
                    done();
                });
        });

        it('no ucs files test', (done) => {
            ucsEntries = [];
            provider.getStoredUcs()
                .then((ucsData) => {
                    assert.strictEqual(ucsData, undefined);
                    done();
                });
        });

        it('List Blobs Segmented Error test', (done) => {
            const errorMessage = 'foobar';
            provider.storageClient.listBlobsSegmented = function listBlobsSegmented(container, foo, bar, cb) {
                cb(new Error(errorMessage));
            };

            provider.getStoredUcs()
                .then(() => {
                    assert.ok(false, 'listBlobsSegmented should have thrown');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, errorMessage);
                })
                .finally(() => {
                    done();
                });
        });
    });
    
    describe('put instance tests', () => {
        beforeEach(() => {
            azureStorageMock.createBlockBlobFromText = function createBlockBlobFromText(
                container,
                name,
                data,
                cb
            ) {
                createBlobFromTextParams = {
                    container,
                    name,
                    data
                };
                cb();
            };
            createBlobFromTextParams = undefined;

            provider.storageClient = azureStorageMock;
        });

        it('basic test', (done) => {
            const instanceId = '123';
            const instance = {
                foo: 'bar'
            };

            provider.putInstance(instanceId, instance)
                .then(() => {
                    const putData = JSON.parse(createBlobFromTextParams.data);
                    assert.strictEqual(createBlobFromTextParams.name, instanceId);
                    assert.strictEqual(putData.foo, instance.foo);
                    assert.notStrictEqual(putData.lastUpdate, undefined);
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });
    });

    describe('get data from uri tests', () => {
        beforeEach(() => {
            azureStorageMock.getBlobToText = function getBlobToText(container, blob, cb) {
                getBlobToTextParams = {
                    container,
                    blob
                };
                cb(null, 'AzureBlobData');
            };

            provider.storageClient = azureStorageMock;

            getBlobToTextParams = undefined;
        });

        it('basic test', (done) => {
            provider.getDataFromUri('https://account.blob.core.windows.net/myStuff/myFile')
                .then((data) => {
                    assert.strictEqual(getBlobToTextParams.container, 'myStuff');
                    assert.strictEqual(getBlobToTextParams.blob, 'myFile');
                    assert.strictEqual(data, 'AzureBlobData');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('complex key test', (done) => {
            provider.getDataFromUri('https://account.blob.core.windows.net/myStuff/myFolder/myFile')
                .then((data) => {
                    assert.strictEqual(getBlobToTextParams.container, 'myStuff');
                    assert.strictEqual(getBlobToTextParams.blob, 'myFolder/myFile');
                    assert.strictEqual(data, 'AzureBlobData');
                })
                .catch((err) => {
                    assert.ok(false, err);
                })
                .finally(() => {
                    done();
                });
        });

        it('invalid uri test', (done) => {
            provider.getDataFromUri('myStuff/myFolder/myFile')
                .then(() => {
                    assert.ok(false, 'Should have thrown invalid URI');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('Invalid URI'), -1);
                })
                .finally(() => {
                    done();
                });
        });

        it('invalid blob path test', (done) => {
            provider.getDataFromUri('https://account.blob.core.windows.net/myStuff')
                .then(() => {
                    assert.ok(false, 'Should have thrown invalid URI');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('Invalid URI'), -1);
                })
                .finally(() => {
                    done();
                });
        });
    });
});
