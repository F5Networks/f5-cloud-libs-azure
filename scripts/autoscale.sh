#!/bin/bash
while getopts r:v:u:p:s: option
do case "$option" in
        r) resource_group=$OPTARG;;
        v) vmss_name=$OPTARG;;
        u) user=$OPTARG;;
        p) passwd_file=$OPTARG;;
        s) azure_secret_file=$OPTARG;;
    esac
done

selfip=$(tmsh list net self self_1nic address | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
port="8443"
instance=`curl http://169.254.169.254/metadata/v1/InstanceInfo --silent --retry 5 | jq .ID | sed 's/_//;s/\"//g'`

f5-rest-node /config/cloud/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/node_modules/f5-cloud-libs --log-level debug --onboard "--output /var/log/onboard.log --log-level debug --host $selfip --port $port -u $user --password-url file://$passwd_file --hostname $instance.azuresecurity.com --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal --module asm:none --module afm:none --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/autoscale.log --log-level debug --host $selfip --port $port -u $user --password-url file://$passwd_file --cloud azure --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action join --device-group Sync"

if [ -f /config/cloud/master ]; then
    echo 'SELF-SELECTED as Master ... Initiating Autoscale Cluster'
    tmsh create sys icall script ClusterUpdate definition { exec f5-rest-node /config/cloud/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/node_modules/f5-cloud-libs --log-level debug --autoscale "--cloud azure --log-level debug --output /var/log/azure-autoscale.log --host $selfip --port $port --user $user --password-url file://$passwd_file --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action update --device-group Sync" }
    tmsh create sys icall handler periodic /Common/ClusterUpdateHandler { first-occurrence now interval 300 script /Common/ClusterUpdate }
    tmsh save /sys config
fi

if [[ $? == 0 ]]; then
    echo "SUCCESS"
else
    echo "FAIL"
    exit 1
fi

exit
