#!/bin/bash
while getopts d:m:a:o::r:v:u:p:s: option
do case "$option" in
#        d) deployment=$OPTARG;;
#        m) mode=$OPTARG;;
#        a) addr=$OPTARG;;
#        o) port=$OPTARG;;
        r) resource_group=$OPTARG;;
#        v) vmss_name=$OPTARG;;
        u) user=$OPTARG;;
        p) passwd_file=$OPTARG;;
        s) azure_secret_file=$OPTARG;;
    esac
done

CREDENTIALS_FILE=/config/cloud/credentials

/usr/bin/install -m 400 /dev/null $CREDENTIALS_FILE

selfip=$(tmsh list net self self_1nic address | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
# lastoctet=`echo $selfip | cut -d . -f 4`
# instance=`expr $lastoctet - 4`

f5-rest-node /config/cloud/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --log-level debug --onboard "--output /var/log/onboard.log --log-level debug --host $selfip -u admin --password-url file://$passwd_file --hostname $vmss_name$instance.azuresecurity.com --set-password admin:$passwd --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal --module asm:none --module afm:none --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/autoscale.log --log-level debug --host $selfip -u admin --password-url $passwd_file --cloud azure --provider-options credentialsUrl:$azure_secret_file --cluster-action join --device-group Sync"

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
