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

describe('azureCloudProvider', () => {
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
    let loginWithManagedIdentityCalled;

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

            loginWithManagedIdentityCalled = false;
            azureMock.MSIVmTokenCredentials = function MSIVmTokenCredentials() {
                loginWithManagedIdentityCalled = true;
            };
        });

        it('azure credentials login test', () => {
            const providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar'
            };

            return provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(receivedClientId, clientId);
                    assert.strictEqual(receivedSecret, secret);
                    assert.strictEqual(receivedTenantId, tenantId);
                });
        });

        it('azure managed identity login test', () => {
            const providerOptions = {
                resourceGroup: 'myResourceGroup',
                useManagedIdentity: true
            };

            return provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(loginWithManagedIdentityCalled, true);
                });
        });

        it('azure gov test', () => {
            azureLocation = 'USGovArizona';

            const providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar'
            };

            return provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(receivedClientId, clientId);
                    assert.strictEqual(receivedSecret, secret);
                    assert.strictEqual(receivedTenantId, tenantId);
                    assert.strictEqual(receivedAzureEnvironment.name, 'AzureUSGovernment');
                });
        });

        it('provider options azure gov login test', () => {
            const providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar',
                environment: 'AzureUSGovernment'
            };

            return provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(receivedClientId, clientId);
                    assert.strictEqual(receivedSecret, secret);
                    assert.strictEqual(receivedTenantId, tenantId);
                    assert.strictEqual(receivedAzureEnvironment.name, 'AzureUSGovernment');
                });
        });

        it('azure login encrypted test', () => {
            const providerOptions = {
                scaleSet: 'myScaleSet',
                resourceGroup: 'myResourceGroup',
                azCredentialsUrl: 'file:///foo/bar',
                azCredentialsEncrypted: true
            };

            return provider.init(providerOptions)
                .then(() => {
                    assert.strictEqual(receivedClientId, clientId);
                    assert.strictEqual(receivedSecret, secret);
                    assert.strictEqual(receivedTenantId, tenantId);
                });
        });

        it('azure login bad credentials url test', () => {
            const errorMessage = 'bad url';
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q.reject(new Error(errorMessage));
            };

            return provider.init({ azCredentialsUrl: 'file:///foo/bar' })
                .then(() => {
                    assert.ok(false, 'Should have thrown bad url');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, errorMessage);
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

        it('basic test', () => {
            return provider.getInstanceId()
                .then((instanceId) => {
                    assert.strictEqual(instanceId, '456');
                });
        });

        it('cached test', () => {
            provider.instanceId = '789';
            return provider.getInstanceId()
                .then((instanceId) => {
                    assert.strictEqual(instanceId, '789');
                });
        });

        it('static test', () => {
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q({
                    compute: {
                        name: 'instance888',
                        vmId: '888'
                    }
                });
            };

            provider.clOptions.static = true;

            return provider.getInstanceId()
                .then((instanceId) => {
                    assert.strictEqual(instanceId, '888');
                });
        });

        it('out name not found test', () => {
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q({
                    compute: {
                        name: 'instance789'
                    }
                });
            };

            return provider.getInstanceId()
                .then(() => {
                    assert.ok(false, 'should have thrown id not found');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('Unable to determine'), -1);
                });
        });

        it('bad metadata test', () => {
            utilMock.getDataFromUrl = function getDataFromUrl() {
                return q({});
            };

            return provider.getInstanceId()
                .then(() => {
                    assert.ok(false, 'should have thrown id not found');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('not found in metadata'), -1);
                });
        });
    });

    describe('delete stored ucs tests', () => {
        beforeEach(() => {
            provider.storageClient = {
                deleteBlobIfExists(c, n, cb) {
                    deleteBlobIfExistsCalled = true;
                    cb(null, 'Success');
                },
                BACKUP_CONTAINER: 'backup'
            };
        });

        it('exists test', () => {
            return provider.deleteStoredUcs('foo.ucs')
                .then(() => {
                    assert.ok(true);
                    assert.ok(deleteBlobIfExistsCalled);
                })
                .finally(() => {
                    deleteBlobIfExistsCalled = false;
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

        it('basic test', () => {
            return provider.getInstances()
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
                });
        });

        it('instances in db test', () => {
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

            return provider.getInstances()
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
                });
        });

        it('Not Provider Visible Provisioning State test', () => {
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

            return provider.getInstances()
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
                });
        });

        it('Not Provider Visible Power State test', () => {
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

            return provider.getInstances()
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
                });
        });

        it('Not Provider Visible Power State Function Error test', () => {
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

            return provider.getInstances()
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
                });
        });

        it('External tag test', () => {
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

            return provider.getInstances({ externalTag })
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
                });
        });

        it('error test', () => {
            const errorMessage = 'some error occurred';
            bigIpMock.prototype.init = function init() {
                return q.reject(new Error(errorMessage));
            };

            return provider.getInstances()
                .then(() => {
                    assert.ok(false, 'should have thrown');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, errorMessage);
                });
        });
    });

    describe('get nodes by resource id tests', () => {
        beforeEach(() => {
            azureNetworkMock.networkInterfaces = {
                listVirtualMachineScaleSetNetworkInterfaces(resourceGroup, scaleSet, cb) {
                    cb(null, [
                        {
                            // eslint-disable-next-line max-len
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

        it('basic test', () => {
            return provider.getNodesByResourceId('resourceId', 'scaleSet')
                .then((instances) => {
                    assert.strictEqual(instances.length, 1);
                    assert.strictEqual(instances[0].ip.private, '5.6.7.8');
                });
        });

        it('bad resource type test', () => {
            return provider.getNodesByResourceId('resourceId', 'resourceType')
                .then(() => {
                    assert.ok(false, 'should have thrown');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('supported'), -1);
                });
        });
    });

    describe('elect primary tests', () => {
        it('basic test', () => {
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

            return provider.electPrimary(instances)
                .then((electedId) => {
                    assert.strictEqual(electedId, '123');
                });
        });

        it('lowest not provider visible test', () => {
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

            return provider.electPrimary(instances)
                .then((electedId) => {
                    assert.strictEqual(electedId, '456');
                });
        });

        it('no provider visible test', () => {
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

            return provider.electPrimary(instances)
                .then(() => {
                    assert.ok(false, 'should have thrown no instances');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, 'No possible primary found');
                });
        });

        it('lowest not version test', () => {
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

            return provider.electPrimary(instances)
                .then((electedId) => {
                    assert.strictEqual(electedId, '456');
                });
        });

        it('external instances test', () => {
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

            return provider.electPrimary(instances)
                .then((electedId) => {
                    assert.strictEqual(electedId, '999');
                });
        });

        it('no instances test', () => {
            const instances = [];

            return provider.electPrimary(instances)
                .then(() => {
                    assert.ok(false, 'should have thrown no instances');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, 'No instances');
                });
        });
    });

    it('get primary credentials test', () => {
        const user = 'roger';
        const password = 'dodger';

        bigIpMock.isInitialized = true;
        bigIpMock.user = user;
        bigIpMock.password = password;
        provider.bigIp = bigIpMock;

        return provider.getPrimaryCredentials()
            .then((credentials) => {
                assert.deepEqual(credentials, {
                    password,
                    username: user
                });
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

        it('valid test', () => {
            const instanceId = '123';
            const instances = {
                123: {
                    hostname: 'foo',
                    privateIp: '1.2.3.4'
                }
            };

            return provider.isValidPrimary(instanceId, instances)
                .then((isValid) => {
                    assert.strictEqual(isValid, true);
                });
        });

        it('not valid test', () => {
            const instanceId = '123';
            const instances = {
                123: {
                    hostname: 'bar',
                    privateIp: '1.2.3.4'
                }
            };

            return provider.isValidPrimary(instanceId, instances)
                .then((isValid) => {
                    assert.strictEqual(isValid, false);
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

        it('tag primary instance test', () => {
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

            return provider.tagPrimaryInstance(primaryIid, instances)
                .then(() => {
                    assert.strictEqual(
                        virtualMachineScaleSetUpdateParams.params.tags['resourceGroupName-primary'],
                        instances[primaryIid].privateIp
                    );
                    assert.strictEqual(virtualMachineScaleSetUpdateParams.params.tags.application, 'APP');
                    assert.strictEqual(virtualMachineScaleSetUpdateParams.resourceGroup, 'resourceGroupName');
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

        it('basic test', () => {
            ucsEntries = [
                {
                    name: 'my.ucs',
                    lastModified: 'Thu, 16 Mar 2017 18:08:54 GMT'
                }
            ];

            return provider.getStoredUcs()
                .then((ucsData) => {
                    assert.strictEqual(ucsData.name, 'my.ucs');
                });
        });

        it('gets latest test', () => {
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

            return provider.getStoredUcs()
                .then((ucsData) => {
                    assert.strictEqual(ucsData.name, 'new.ucs');
                });
        });

        it('no ucs files test', () => {
            ucsEntries = [];
            return provider.getStoredUcs()
                .then((ucsData) => {
                    assert.strictEqual(ucsData, undefined);
                });
        });

        it('List Blobs Segmented Error test', () => {
            const errorMessage = 'foobar';
            provider.storageClient.listBlobsSegmented = function listBlobsSegmented(container, foo, bar, cb) {
                cb(new Error(errorMessage));
            };

            return provider.getStoredUcs()
                .then(() => {
                    assert.ok(false, 'listBlobsSegmented should have thrown');
                })
                .catch((err) => {
                    assert.strictEqual(err.message, errorMessage);
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

        it('basic test', () => {
            const instanceId = '123';
            const instance = {
                foo: 'bar'
            };

            return provider.putInstance(instanceId, instance)
                .then(() => {
                    const putData = JSON.parse(createBlobFromTextParams.data);
                    assert.strictEqual(createBlobFromTextParams.name, instanceId);
                    assert.strictEqual(putData.foo, instance.foo);
                    assert.notStrictEqual(putData.lastUpdate, undefined);
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

        it('basic test', () => {
            return provider.getDataFromUri('https://account.blob.core.windows.net/myStuff/myFile')
                .then((data) => {
                    assert.strictEqual(getBlobToTextParams.container, 'myStuff');
                    assert.strictEqual(getBlobToTextParams.blob, 'myFile');
                    assert.strictEqual(data, 'AzureBlobData');
                });
        });

        it('complex key test', () => {
            return provider.getDataFromUri('https://account.blob.core.windows.net/myStuff/myFolder/myFile')
                .then((data) => {
                    assert.strictEqual(getBlobToTextParams.container, 'myStuff');
                    assert.strictEqual(getBlobToTextParams.blob, 'myFolder/myFile');
                    assert.strictEqual(data, 'AzureBlobData');
                });
        });

        it('invalid uri test', () => {
            return provider.getDataFromUri('myStuff/myFolder/myFile')
                .then(() => {
                    assert.ok(false, 'Should have thrown invalid URI');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('Invalid URI'), -1);
                });
        });

        it('invalid blob path test', () => {
            return provider.getDataFromUri('https://account.blob.core.windows.net/myStuff')
                .then(() => {
                    assert.ok(false, 'Should have thrown invalid URI');
                })
                .catch((err) => {
                    assert.notStrictEqual(err.message.indexOf('Invalid URI'), -1);
                });
        });
    });
});
