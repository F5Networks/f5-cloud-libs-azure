#!/bin/bash
while getopts i:r:n:v:u:p:s: option
do case "$option" in
#        d) deployment=$OPTARG;;
#        m) mode=$OPTARG;;
#        a) addr=$OPTARG;;
#        o) port=$OPTARG;;
        i) instance=$OPTARG;;
        r) resource_group=$OPTARG;;
        n) subscription_id=$OPTARG;;
        v) vmss_name=$OPTARG;;
        u) user=$OPTARG;;
        p) passwd_file=$OPTARG;;
        s) azure_secret_file=$OPTARG;;
    esac
done

selfip=$(tmsh list net self self_1nic address | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
# lastoctet=`echo $selfip | cut -d . -f 4`
# instance=`expr $lastoctet - 4`

echo instance $instance
echo resource_group $resource_group
echo subscription_id $subscription_id
echo vmss_name $vmss_name
echo user $user
echo passwd_file $passwd_file
echo azure_secret_file $azure_secret_file

f5-rest-node /config/cloud/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/node_modules/f5-cloud-libs --log-level debug --onboard "--output /var/log/onboard.log --log-level debug --host --port 8443 $selfip -u $user --password-url $passwd_file --hostname $vmss_name$instance.azuresecurity.com --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal --module asm:none --module afm:none --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/autoscale.log --log-level debug --host $selfip --port 8443 -u $user --password-url $passwd_file --cloud azure --provider-options credentialsUrl:$azure_secret_file,resourceGroup:$resource_group,subscriptionId:$subscription_id --cluster-action join --device-group Sync"

# if [[ $instance == 0 ]]; then
#      if [[ -n $mode ]]; then
#           exec f5-rest-node /var/lib/waagent/custom-script/download/0/runScripts.js --log-level debug --tag $cloudlibs_tag --onboard "--output /var/log/onboard.log --log-level debug --host $selfip -u admin -p $passwd --hostname $vmss_name$instance.azuresecurity.com --set-password admin:$passwd --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal --module asm:none --module afm:none --signal ONBOARD_DONE" --cluster "--wait-for ONBOARD_DONE --output /var/log/clusterGroup.log --log-level debug --host $selfip -u admin -p $passwd --create-group --device-group Sync --sync-type sync-failover --device $vmss_name$instance.azuresecurity.com --auto-sync --save-on-auto-sync --signal CLUSTER_GROUP_DONE" --script "--wait-for CLUSTER_GROUP_DONE --output /var/log/runScript.log --log-level debug --url http://cdn-prod-ore-f5.s3-website-us-west-2.amazonaws.com/product/blackbox/staging/azure/deploy_ha.sh --cl-args '-m $mode -d $deployment -n $addr -h $port -u $user -p $passwd' --signal SCRIPT_DONE" --cluster "--wait-for SCRIPT_DONE --output /var/log/clusterSync.log --log-level debug --host $selfip -u admin -p $passwd --config-sync-ip $selfip"
#      else
#           exec f5-rest-node /var/lib/waagent/custom-script/download/0/runScripts.js --log-level debug --tag $cloudlibs_tag --onboard "--output /var/log/onboard.log --log-level debug --host $selfip -u admin -p $passwd --hostname $vmss_name$instance.azuresecurity.com --set-password admin:$passwd --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal --module asm:none --module afm:none --signal ONBOARD_DONE" --cluster "--wait-for ONBOARD_DONE --output /var/log/clusterGroup.log --log-level debug --host $selfip -u admin -p $passwd --config-sync-ip $selfip --create-group --device-group Sync --sync-type sync-failover --device $vmss_name$instance.azuresecurity.com --auto-sync --save-on-auto-sync"
#      fi
# else
#      exec f5-rest-node /var/lib/waagent/custom-script/download/0/runScripts.js --log-level debug --tag $cloudlibs_tag --onboard "--output /var/log/onboard.log --log-level debug --host $selfip -u admin -p $passwd --hostname $vmss_name$instance.azuresecurity.com --set-password admin:$passwd --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal --module asm:none --module afm:none --signal ONBOARD_DONE" --cluster "--wait-for ONBOARD_DONE --output /var/log/cluster.log --log-level debug --host $selfip -u admin -p $passwd --config-sync-ip $selfip --join-group --device-group Sync --sync --remote-host 10.0.0.4 --remote-user admin --remote-password $passwd"
# fi

if [[ $? == 0 ]]; then
    echo "SUCCESS"
else
    echo "FAIL"
    exit 1
fi

exit
