#!/bin/bash

# Parse the command line arguments
while [[ $# -gt 1 ]]; do
    case "$1" in
        --resourceGroup)
            resource_group=$2
            shift 2;;
        --vmssName)
            vmss_name=$2
            shift 2;;
        --userName)
            user=$2
            shift 2;;
        --password)
            passwd_file=$2
            shift 2;;
        --azureSecretFile)
            azure_secret_file=$2
            shift 2;;
        --managementPort)
            mgmt_port=$2
            shift 2;;
        --ntpServer)
            ntp_server=$2
            shift 2;;
        --timeZone)
            time_zone=$2
            shift 2;;
        --wafScriptArgs)
            waf_script_args=$2
            shift 2;;
        --bigIqLicenseHost)
            big_iq_lic_host=$2
            shift 2;;
        --bigIqLicenseUsername)
            big_iq_lic_user=$2
            shift 2;;
        --bigIqLicensePassword)
            big_iq_lic_pwd_file=$2
            shift 2;;
        --bigIqLicensePool)
            big_iq_lic_pool=$2
            shift 2;;
        --bigIpExtMgmtAddress)
            big_ip_ext_mgmt_addr=$2
            shift 2;;
        --bigIpExtMgmtPort)
            big_ip_ext_mgmt_port=$2
            shift 2;;
        --)
            shift
            break;;
    esac
done

block_sync=""
prov_asm=""
# Check if deploying LTM+ASM
if [[ ! -z $waf_script_args ]]; then
    echo "Deploying as LTM+ASM: $waf_script_args"
    prov_asm="--module asm:nominal"
    block_sync="--block-sync"
else
    echo "Deploying as LTM Only"
fi

dfl_mgmt_port=$(tmsh list sys httpd ssl-port | grep ssl-port | sed 's/ssl-port //;s/ //g')
self_ip=$(tmsh list net self self_1nic address | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
instance=$(curl http://169.254.169.254/metadata/v1/InstanceInfo --interface internal --silent --retry 5 | jq .ID | sed 's/_//;s/\"//g')

# Add check/loop for self_ip in case BIG-IP is not finished provisioning 1 NIC
count=0
while [ $count -lt 10 ]; do
    if [[ -z $self_ip ]]; then
        sleep 5
        self_ip=$(tmsh list net self self_1nic address | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
    fi
    count=$(( $count + 1 ))
done
echo "SELF IP CHOSEN: $self_ip"
# Add check/loop in case metadata service does not respond right away
count=0
while [ $count -lt 5 ]; do
    if [[ -z $instance ]]; then
        sleep 5
        echo "Attempting to contact the metadata service: $count"
        instance=$(curl http://169.254.169.254/metadata/v1/InstanceInfo --interface internal --silent --retry 5 | jq .ID | sed 's/_//;s/\"//g')
    fi
    count=$(( $count + 1 ))
done
echo "INSTANCE NAME CHOSEN: $instance"

# Check if PAYG or BYOL (via BIG-IQ)
if [[ ! -z $big_iq_lic_host ]]; then
    echo "Licensing via BIG-IQ: $big_iq_lic_host"
    # License via BIG-IQ
    if [[ $big_ip_ext_mgmt_port == *"via-api"* ]]; then
        ## Have to go get MGMT port ourselves based on instance we are on ##
        # Add Instance ID to file as node provider expects it to be there
        instance_id=$(echo $instance | grep -E -o "_.{0,3}" | sed 's/_//;s/\"//g')
        jq -c .instanceId=$instance_id /config/cloud/azCredentials > tmp.$$.json && mv tmp.$$.json /config/cloud/azCredentials
        # Make Azure Rest API call to get frontend port
        ext_port_via_api=$(/usr/bin/f5-rest-node --use-strict /config/cloud/azure/node_modules/f5-cloud-libs/node_modules/f5-cloud-libs-azure/scripts/scaleSetProvider.js)
        big_ip_ext_mgmt_port=$(echo $ext_port_via_api | grep 'Port Selected: ' | awk -F 'Selected: ' '{print $2}')
    fi
    echo "BIG-IP via BIG-IQ Info... IP: $big_ip_ext_mgmt_addr Port: $big_ip_ext_mgmt_port"
    f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/f5-cloud-libs --log-level debug --onboard "--output /var/log/onboard.log --log-level debug --host $self_ip --port $dfl_mgmt_port --ssl-port $mgmt_port -u $user --password-url file://$passwd_file --hostname $instance.azuresecurity.com --license-pool --big-iq-host $big_iq_lic_host --big-iq-user $big_iq_lic_user --big-iq-password-uri file://$big_iq_lic_pwd_file --license-pool-name $big_iq_lic_pool --big-ip-mgmt-address $big_ip_ext_mgmt_addr --big-ip-mgmt-port $big_ip_ext_mgmt_port --ntp $ntp_server --tz $time_zone --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal $prov_asm--module afm:none --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/autoscale.log --log-level debug --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --cloud azure --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action join --device-group Sync $block_sync"
else
    # Assume PAYG and licensing is already handled
    echo "Licensing via PAYG, already completed"
    f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/f5-cloud-libs --log-level debug --onboard "--output /var/log/onboard.log --log-level debug --host $self_ip --port $dfl_mgmt_port --ssl-port $mgmt_port -u $user --password-url file://$passwd_file --hostname $instance.azuresecurity.com --ntp $ntp_server --tz $time_zone --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 --module ltm:nominal $prov_asm --module afm:none --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/autoscale.log --log-level debug --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --cloud azure --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action join --device-group Sync $block_sync"
fi

if [ -f /config/cloud/master ]; then
    echo 'SELF-SELECTED as Master ... Initiating Autoscale Cluster'
    # UCS Loaded?
    ucs_loaded=$(cat /config/cloud/master | jq .ucsLoaded)
    echo "UCS Loaded: $ucs_loaded"

    # If Deploying LTM+ASM run some additional commands
    if [[ ! -z $waf_script_args ]]; then
        # Deploy the WAF Application if master and ucs loaded equals false
        if $ucs_loaded; then
            echo "NOTE: We are not deploying any WAF applications as a UCS was loaded, and it takes precedence."
        else
            /usr/bin/f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/f5-cloud-libs --script " --output /var/log/deployScript.log --log-level debug --file /config/cloud/deploy_waf.sh --cl-args '$waf_script_args' --signal DEPLOY_SCRIPT_DONE "
        fi
        # Unblock the cluster sync
        f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/autoscale.js --output /var/log/autoscale.log --log-level debug --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --cloud azure --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action unblock-sync
    fi
fi

# Create iCall, first check if it already exists
icall_handler_name="ClusterUpdateHandler"
tmsh list sys icall handler | grep $icall_handler_name
if [[ $? != 0 ]]; then
    tmsh create sys icall script ClusterUpdate definition { exec f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/f5-cloud-libs --log-level debug --autoscale "--cloud azure --log-level debug --output /var/log/azure-autoscale.log --host localhost --port $mgmt_port --user $user --password-url file://$passwd_file --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action update --device-group Sync" }
    tmsh create sys icall handler periodic /Common/$icall_handler_name { first-occurrence now interval 300 script /Common/ClusterUpdate }
    tmsh save /sys config
else
    echo "Appears the $icall_handler_name icall already exists!"
fi

if [[ $? == 0 ]]; then
    echo "AUTOSCALE INIT SUCCESS"
else
    echo "AUTOSCALE INIT FAIL"
    exit 1
fi
exit

