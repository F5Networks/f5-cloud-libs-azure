#!/bin/bash

ARGS=`getopt -o r:v:u:p:s:m: --long resourceGroup:,vmssName:,userName:,password:,azureSecretFile:,managementPort: -n $0 -- "$@"`
eval set -- "$ARGS"
# Parse the command line arguments
while true; do
    case "$1" in
        -r|--resourceGroup)
            resource_group=$2
            shift 2;;
        -v|--vmssName)
            vmss_name=$2
            shift 2;;
        -u|--userName)
            user=$2
            shift 2;;
        -p|--password)
            passwd_file=$2
            shift 2;;
        -s|--azureSecretFile)
            azure_secret_file=$2
            shift 2;;
        -m|--managementPort)
            mgmt_port=$2
            shift 2;;
        --)
            shift
            break;;
    esac
done

dfl_mgmt_port=`tmsh list sys httpd ssl-port | grep ssl-port | sed 's/ssl-port //;s/ //g'`
selfip=$(tmsh list net self self_1nic address | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
instance=`curl http://169.254.169.254/metadata/v1/InstanceInfo --silent --retry 5 | jq .ID | sed 's/_//;s/\"//g'`

f5-rest-node /config/cloud/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/node_modules/f5-cloud-libs --log-level debug --onboard "--output /var/log/onboard.log --log-level debug --host $selfip --port $dfl_mgmt_port --ssl-port $mgmt_port -u $user --password-url file://$passwd_file --hostname $instance.azuresecurity.com --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal --module asm:none --module afm:none --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/autoscale.log --log-level debug --host $selfip --port $mgmt_port -u $user --password-url file://$passwd_file --cloud azure --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action join --device-group Sync"

if [ -f /config/cloud/master ]; then
    echo 'SELF-SELECTED as Master ... Initiating Autoscale Cluster'
    # UCS Loaded?
    ucs_loaded=`cat /config/cloud/master | jq .ucsLoaded`
    echo "UCS Loaded: $ucs_loaded"

    tmsh create sys icall script ClusterUpdate definition { exec f5-rest-node /config/cloud/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/node_modules/f5-cloud-libs --log-level debug --autoscale "--cloud azure --log-level debug --output /var/log/azure-autoscale.log --host $selfip --port $mgmt_port --user $user --password-url file://$passwd_file --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action update --device-group Sync" }
    tmsh create sys icall handler periodic /Common/ClusterUpdateHandler { first-occurrence now interval 300 script /Common/ClusterUpdate }
    tmsh save /sys config
fi

if [[ $? == 0 ]]; then
    echo "AUTOSCALE INIT SUCCESS"
else
    echo "AUOTSCALE INIT FAIL"
    exit 1
fi

exit
