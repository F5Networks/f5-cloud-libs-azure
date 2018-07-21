#!/bin/bash

# Parse the command line arguments
log_level=info
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
        --bigIqAddress)
            big_iq_address=$2
            shift 2;;
        --bigIqUsername)
            big_iq_user=$2
            shift 2;;
        --bigIqPassword)
            big_iq_password=$2
            shift 2;;
        --bigIqLicensePoolName)
            big_iq_lic_pool_name=$2
            shift 2;;
        --bigIqExtraLicenseOptions)
            big_iq_extra_lic_options=$2
            shift 2;;
        --bigIpExtMgmtAddress)
            big_ip_ext_mgmt_addr=$2
            shift 2;;
        --bigIpExtMgmtPort)
            big_ip_ext_mgmt_port=$2
            shift 2;;
        --dnsOptions)
            dns_options=$2
            shift 2;;
        --static)
            static="--static"
            shift;;
        --externalTag)
            external_tag="--external-tag $2"
            shift 2;;
        --natBase)
            nat_base="--nat-base $2"
            shift 2;;
        --backupUcs)
            backup_ucs=$2
            shift 2;;
        --logLevel)
            log_level=$2
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
# Check if deploying DNS options
if [[ ! -z $dns_options ]]; then
    echo "Deploying with DNS options: $dns_options"
fi

dfl_mgmt_port=$(tmsh list sys httpd ssl-port | grep ssl-port | sed 's/ssl-port //;s/ //g')
self_ip=$(tmsh list net self self_1nic address | grep -o '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')
instance=$(curl -H Metadata:true http://169.254.169.254/metadata/instance?api-version=2017-04-02 --interface internal --silent --retry 3 | jq .compute.name --raw-output)

# Add check/loop for self_ip in case BIG-IP is not finished provisioning 1 NIC
count=0
while [ $count -lt 15 ]; do
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
while [ $count -lt 10 ]; do
    if [[ -z $instance ]]; then
        sleep 5
        echo "Attempting to contact the metadata service: $count"
        instance=$(curl -H Metadata:true http://169.254.169.254/metadata/instance?api-version=2017-04-02 --silent --retry 3 | jq .compute.name --raw-output)
    fi
    count=$(( $count + 1 ))
done
echo "INSTANCE NAME CHOSEN: $instance"

# Execute Application Insights Provider early to allow custom metrics to begin appearing
if [[ ! -z $app_insights_key ]]; then
    /usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs-azure/scripts/appInsightsProvider.js --key $app_insights_key --mgmt-port $dfl_mgmt_port --log-level info
fi

# Check if PAYG or BYOL (via BIG-IQ)
if [[ ! -z $big_iq_address ]]; then
    echo "Licensing via BIG-IQ: $big_iq_address"
    instance_id=$(echo $instance | grep -E -o "_.{0,3}" | sed 's/_//;s/\"//g')
    # License via BIG-IQ
    if [[ $big_ip_ext_mgmt_port == *"via-api"* ]]; then
        ## Have to go get MGMT port from inbound nat rules on ALB ##
        via_api=$(/usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs-azure/scripts/scaleSetProvider.js --instance-id $instance_id $nat_base)
        big_ip_ext_mgmt_port=$(echo $via_api | awk -F 'instanceInfo: ' '{print $2}' | jq .port --raw-output)
    fi
    if [[ $big_ip_ext_mgmt_addr == *"via-api"* ]]; then
        ## Have to go get MGMT Public IP from VMSS ##
        via_api=$(/usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs-azure/scripts/scaleSetProvider.js --instance-id $instance_id $nat_base)
        big_ip_ext_mgmt_addr=$(echo $via_api | awk -F 'instanceInfo: ' '{print $2}' | jq .publicIp --raw-output)
    fi
    echo "BIG-IP via BIG-IQ Info... IP: $big_ip_ext_mgmt_addr Port: $big_ip_ext_mgmt_port"
    /usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs --log-level $log_level --onboard "--output /var/log/cloud/azure/onboard.log --log-level $log_level --cloud azure --host $self_ip --port $dfl_mgmt_port --ssl-port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --hostname $instance.azuresecurity.com --license-pool --big-iq-host $big_iq_address --big-iq-user $big_iq_user --big-iq-password-uri file://$big_iq_password --big-iq-password-encrypted --license-pool-name $big_iq_lic_pool_name $big_iq_extra_lic_options --big-ip-mgmt-address $big_ip_ext_mgmt_addr --big-ip-mgmt-port $big_ip_ext_mgmt_port --ntp $ntp_server --tz $time_zone --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 $usage_analytics --module $mod_prov --module afm:none --no-reboot --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/cloud/azure/autoscale.log --log-level $log_level --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --cloud azure --license-pool --big-iq-host $big_iq_address --big-iq-user $big_iq_user --big-iq-password-uri file://$big_iq_password --big-iq-password-encrypted --license-pool-name $big_iq_lic_pool_name --big-ip-mgmt-address $big_ip_ext_mgmt_addr --big-ip-mgmt-port $big_ip_ext_mgmt_port $static $external_tag --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,azCredentialsEncrypted:true,resourceGroup:$resource_group --cluster-action join --device-group Sync $block_sync $dns_options"
else
    # Assume PAYG and licensing is already handled
    echo "Licensing via PAYG, already completed"
    /usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs --log-level $log_level --onboard "--output /var/log/cloud/azure/onboard.log --log-level $log_level --host $self_ip --port $dfl_mgmt_port --ssl-port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --hostname $instance.azuresecurity.com --ntp $ntp_server --tz $time_zone --db provision.1nicautoconfig:disable --db tmm.maxremoteloglength:2048 $usage_analytics --module $mod_prov --module afm:none --no-reboot --signal ONBOARD_DONE" --autoscale "--wait-for ONBOARD_DONE --output /var/log/cloud/azure/autoscale.log --log-level $log_level --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted --cloud azure $static $external_tag --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,azCredentialsEncrypted:true,resourceGroup:$resource_group --cluster-action join --device-group Sync $block_sync $dns_options"
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
            /usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs --script " --output /var/log/cloud/azure/deployScript.log --log-level $log_level --file /config/cloud/deploy_waf.sh --cl-args '$waf_script_args' --signal DEPLOY_SCRIPT_DONE "
        fi
        # Unblock the cluster sync
        /usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs/scripts/autoscale.js --output /var/log/cloud/azure/autoscale.log --log-level $log_level --host $self_ip --port $mgmt_port -u $user --password-url file://$passwd_file --password-encrypted $static $external_tag --cloud azure --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,azCredentialsEncrypted:true,resourceGroup:$resource_group --cluster-action unblock-sync
    fi
fi

# Create cluster update iCall and script
script_loc="/config/cloud/clusterUpdateScript.sh"
if [[ ! -z $big_iq_address ]]; then
    echo "/usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs --log-level $log_level --autoscale \"--cloud azure --log-level $log_level --output /var/log/cloud/azure/autoscale.log --host localhost --port $mgmt_port --user $user --password-url file://$passwd_file --password-encrypted $static $external_tag --license-pool --big-iq-host $big_iq_address --big-iq-user $big_iq_user --big-iq-password-uri file://$big_iq_password --big-iq-password-encrypted --license-pool-name $big_iq_lic_pool_name --big-ip-mgmt-address $big_ip_ext_mgmt_addr --big-ip-mgmt-port $big_ip_ext_mgmt_port --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,azCredentialsEncrypted:true,resourceGroup:$resource_group --cluster-action update --device-group Sync $dns_options\"" > $script_loc
else
    echo "/usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs --log-level $log_level --autoscale \"--cloud azure --log-level $log_level --output /var/log/cloud/azure/autoscale.log --host localhost --port $mgmt_port --user $user --password-url file://$passwd_file --password-encrypted $static $external_tag --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,azCredentialsEncrypted:true,resourceGroup:$resource_group --cluster-action update --device-group Sync $dns_options\"" > $script_loc
fi
icall_handler_name="ClusterUpdateHandler"
icall_script_name="ClusterUpdate"
# First check if iCall already exists
tmsh list sys icall handler | grep $icall_handler_name
if [[ $? != 0 ]]; then
    tmsh create sys icall script $icall_script_name definition { exec bash $script_loc }
    tmsh create sys icall handler periodic /Common/$icall_handler_name { first-occurrence now interval 120 script /Common/$icall_script_name }
else
    echo "Appears the $icall_handler_name icall already exists!"
fi

# Create iCall to run Application Insights Provider code if required
if [[ ! -z $app_insights_key ]]; then
    icall_handler_name="MetricsCollectorHandler"
    icall_script_name="MetricsCollector"
    # First check if iCall already exists
    tmsh list sys icall handler | grep $icall_handler_name
    if [[ $? != 0 ]]; then
        tmsh create sys icall script $icall_script_name definition { exec /usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs-azure/scripts/appInsightsProvider.js --key $app_insights_key --mgmt-port $mgmt_port --log-level info }
        tmsh create sys icall handler periodic /Common/$icall_handler_name { first-occurrence now interval 60 script /Common/$icall_script_name }
        # Check to determine when the custom Application Insights metric just created (possibly)
        # is available for consumption by VM Scale sets
        if [ -f /config/cloud/master ]; then
            api_key_create=$(/usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs-azure/scripts/appInsightsApiKeyProvider.js --key-operation create | grep 'Response: ' | awk -F 'Response: ' '{print $2}')
            api_key=$(echo "$api_key_create" | jq -r .apiKey)
            api_key_id=$(echo "$api_key_create" | jq -r .id | awk -F '/apikeys/' '{print $2}')
            app_insights_id=$(echo "$api_key_create" | jq -r .appInsightsId)
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
                    /usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs-azure/scripts/appInsightsApiKeyProvider.js --key-operation delete --key-id $api_key_id
                    break
                fi
            done
        fi
    else
        echo "Appears the $icall_handler_name icall already exists!"
    fi
fi

# Create Backup UCS iCall and script
if [[ ! -z $backup_ucs ]]; then
    script_loc="/config/cloud/backupUcsScript.sh"
    echo "/usr/bin/f5-rest-node /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs/scripts/azure/runScripts.js --base-dir /config/cloud/azure/node_modules/@f5devcentral/f5-cloud-libs --log-level $log_level --autoscale \"--cloud azure --log-level $log_level --output /var/log/cloud/azure/autoscale.log --host localhost --port $mgmt_port --user $user --password-url file://$passwd_file --password-encrypted $static $external_tag --provider-options scaleSet:$vmss_name,azCredentialsUrl:file://$azure_secret_file,azCredentialsEncrypted:true,resourceGroup:$resource_group --cluster-action backup-ucs --max-ucs-files $backup_ucs\"" > $script_loc
    icall_handler_name="BackupUCSHandler"
    icall_script_name="BackupUCS"
    # First check if iCall already exists
    tmsh list sys icall handler | grep $icall_handler_name
    if [[ $? != 0 ]]; then
        tmsh create sys icall script $icall_script_name definition { exec bash $script_loc }
        tmsh create sys icall handler periodic /Common/$icall_handler_name { first-occurrence `date +%Y-%m-%d`:23:59:59 interval 86400 script /Common/$icall_script_name }
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
# Exit autoscale script
exit
