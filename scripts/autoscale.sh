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
        --usageAnalytics)
            usage_analytics=$2
            shift 2;;
        --wafScriptArgs)
            waf_script_args=$2
            shift 2;;
        --appInsightsKey)
            app_insights_key=$2
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
mod_prov="ltm:nominal"
# Check if deploying LTM+ASM
if [[ ! -z $waf_script_args ]]; then
    echo "Deploying as LTM+ASM: $waf_script_args"
    mod_prov="ltm:nominal --module asm:nominal"
    block_sync="--block-sync"
else
    echo "Deploying as LTM Only"
fi

dfl_mgmt_port=$(tmsh list sys httpd ssl-port | grep ssl-port | sed 's/ssl-port //;s/ //g')
self_ip=$(tmsh list net self self_1nic address | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
instance=$(curl -H Metadata:true http://169.254.169.254/metadata/instance?api-version=2017-04-02 --interface internal --silent --retry 3 | jq .compute.name --raw-output)

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

# Add missing metadata route on mgmt plane if v13.x
if tmsh show sys version | grep '13\.'; then
    dfl_gw=$(tmsh list net route default | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
    # Just in case default route does not exist yet continue to wait for it to be created
    count=0
    while [ $count -lt 10 ]; do
        if [[ -z $dfl_gw ]]; then
            sleep 5
            dfl_gw=$(tmsh list net route default | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
        fi
        count=$(( $count + 1 ))
    done
    echo "Default Route: $dfl_gw"
    route add 169.254.169.254 gw $dfl_gw internal
fi

# Add check/loop in case metadata service does not respond right away
count=0
while [ $count -lt 5 ]; do
    if [[ -z $instance ]]; then
        sleep 5
        echo "Attempting to contact the metadata service: $count"
        instance=$(curl -H Metadata:true http://169.254.169.254/metadata/instance?api-version=2017-04-02 --silent --retry 3 | jq .compute.name --raw-output)
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
        jq -c .instanceId=$instance_id $azure_secret_file > tmp.$$.json && mv tmp.$$.json $azure_secret_file
        # Make Azure Rest API call to get frontend port
        ext_port_via_api=$(/usr/bin/f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/node_modules/f5-cloud-libs-azure/scripts/scaleSetProvider.js)
        big_ip_ext_mgmt_port=$(echo $ext_port_via_api | grep 'Port Selected: ' | awk -F 'Selected: ' '{print $2}')
    fi
    echo "BIG-IP via BIG-IQ Info... IP: $big_ip_ext_mgmt_addr Port: $big_ip_ext_mgmt_port"
    f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/f5-cloud-libs --log-level debug --onboard "--output /var/log/onboard.log --log-level debug --host $self_ip --port $dfl_mgmt_port --ssl-port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --hostname $instance.azuresecurity.com --license-pool --big-iq-host $big_iq_lic_host --big-iq-user $big_iq_lic_user --big-iq-password-uri file://$big_iq_lic_pwd_file --license-pool-name $big_iq_lic_pool --big-ip-mgmt-address $big_ip_ext_mgmt_addr --big-ip-mgmt-port $big_ip_ext_mgmt_port --ntp $ntp_server --tz $time_zone --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 $usage_analytics --module $mod_prov --module afm:none --no-reboot --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/autoscale.log --log-level debug --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --cloud azure --license-pool --big-iq-host $big_iq_lic_host --big-iq-user $big_iq_lic_user --big-iq-password-uri file://$big_iq_lic_pwd_file --license-pool-name $big_iq_lic_pool --big-ip-mgmt-address $big_ip_ext_mgmt_addr --big-ip-mgmt-port $big_ip_ext_mgmt_port --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action join --device-group Sync $block_sync"
else
    # Assume PAYG and licensing is already handled
    echo "Licensing via PAYG, already completed"
    f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/f5-cloud-libs --log-level debug --onboard "--output /var/log/onboard.log --log-level debug --host $self_ip --port $dfl_mgmt_port --ssl-port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --hostname $instance.azuresecurity.com --ntp $ntp_server --tz $time_zone --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 $usage_analytics --module $mod_prov --module afm:none --no-reboot --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/autoscale.log --log-level debug --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --cloud azure --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action join --device-group Sync $block_sync"
fi

if [ -f /config/cloud/master ]; then
    echo 'SELF-SELECTED as Master ... Initiating Autoscale Cluster'
    # Check if UCS is loaded
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
        f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/autoscale.js --output /var/log/autoscale.log --log-level debug --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --cloud azure --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action unblock-sync
    fi
fi

# Create Cluster Update iCall, first check if it already exists
icall_handler_name="ClusterUpdateHandler"
tmsh list sys icall handler | grep $icall_handler_name
if [[ $? != 0 ]]; then
    if [[ ! -z $big_iq_lic_host ]]; then
        tmsh create sys icall script ClusterUpdate definition { exec f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/f5-cloud-libs --log-level debug --autoscale "--cloud azure --log-level debug --output /var/log/azure-autoscale.log --host localhost --port $mgmt_port --user $user --password-url file://$passwd_file --password-encrypted --license-pool --big-iq-host $big_iq_lic_host --big-iq-user $big_iq_lic_user --big-iq-password-uri file://$big_iq_lic_pwd_file --license-pool-name $big_iq_lic_pool --big-ip-mgmt-address $big_ip_ext_mgmt_addr --big-ip-mgmt-port $big_ip_ext_mgmt_port --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action update --device-group Sync" }
    else
        tmsh create sys icall script ClusterUpdate definition { exec f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/f5-cloud-libs --log-level debug --autoscale "--cloud azure --log-level debug --output /var/log/azure-autoscale.log --host localhost --port $mgmt_port --user $user --password-url file://$passwd_file --password-encrypted --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,resourceGroup:$resource_group --cluster-action update --device-group Sync" }
    fi
    tmsh create sys icall handler periodic /Common/$icall_handler_name { first-occurrence now interval 120 script /Common/ClusterUpdate }
    tmsh save /sys config
else
    echo "Appears the $icall_handler_name icall already exists!"
fi

# Create iCall to run Application Insights Provider code if so chosen in the template
if [[ ! -z $app_insights_key ]]; then
    icall_handler_name="MetricsCollectorHandler"
    tmsh list sys icall handler | grep $icall_handler_name
    if [[ $? != 0 ]]; then
        tmsh create sys icall script MetricsCollector definition { exec f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/node_modules/f5-cloud-libs-azure/scripts/appInsightsProvider.js --key $app_insights_key --log-level info }
        tmsh create sys icall handler periodic /Common/$icall_handler_name { first-occurrence now interval 60 script /Common/MetricsCollector }
        # Check to determine when the custom Application Insights metric just created (possibly)
        # is available for consumption by VM Scale sets
        if [ -f /config/cloud/master ]; then
            api_key_create=$(/usr/bin/f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/node_modules/f5-cloud-libs-azure/scripts/appInsightsApiKeyProvider.js --key-operation create)
            api_key=$(echo "$api_key_create" | grep 'API Key: ' | awk -F 'Key: ' '{print $2}')
            api_key_id=$(echo "$api_key_create" | grep 'API Key ID: ' | awk -F 'ID: ' '{print $2}')
            app_insights_id=$(echo "$api_key_create" | grep 'App Insights ID: ' | awk -F 'ID: ' '{print $2}')
            # Check if metric exists in a while loop (will continue at expiration of ctr * while loop)
            metric='F5_TMM_CPU'
            ctr=0
            while [ $ctr -lt 30 ]; do
                metric_check=$(curl --silent "https://api.applicationinsights.io/beta/apps/$app_insights_id/metrics/customMetrics%2F$metric" -H "x-api-key: $api_key")
                echo "DEBUG -- CTR: $ctr Response: $metric_check"
                if [[ `echo $metric_check | jq '.value'` == *"null"* ]]; then
                    # Keep trying
                    ctr=$(($ctr+1))
                    sleep 10
                else
                    # Metric Exists
                    echo "Metric Created: $metric Metric Check Response: $metric_check"
                    # Delete API Key
                    echo "Deleting API Key: $api_key_id"
                    /usr/bin/f5-rest-node /config/cloud/azure/node_modules/f5-cloud-libs/node_modules/f5-cloud-libs-azure/scripts/appInsightsApiKeyProvider.js --key-operation delete --key-id $api_key_id
                    break
                fi
            done
        fi
    else
        echo "Appears the $icall_handler_name icall already exists!"
    fi
fi

# Save TMSH Configuration
tmsh save /sys config

if [[ $? == 0 ]]; then
    echo "AUTOSCALE INIT SUCCESS"
else
    echo "AUTOSCALE INIT FAIL"
    exit 1
fi

exit

