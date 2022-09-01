#!/bin/bash

echo "Starting NEAR node on network $NETWORK"

# Check if this node has been initialized already
if [ ! -f /root/.near/config.json ]; then

    echo "No data found - initializing chain"

    # Initialize chain
    NEARD_INIT="neard init --chain-id $NETWORK --download-genesis"
    echo "No config found - initializing node: $NEARD_INIT"
    $NEARD_INIT

    # Download a snapshot to sync faster
    echo "Downloading chain snapshot"

    LATEST=`/app/s5cmd --no-sign-request=true cat s3://near-protocol-public/backups/$NETWORK/rpc/latest`
    if [ -z "$LATEST" ]; then
        echo "ERROR: cannot find latest snapshot tag.. Waiting 1 hour to retry"
        date
        sleep 3600 
        exit
    fi

    SNAPSHOT_BUCKET="s3://near-protocol-public/backups/$NETWORK/rpc/$LATEST/*"
    echo "Latest snapshot at: $SNAPSHOT_BUCKET"

    echo "Retrieving snapshot from $SNAPSHOT_BUCKET"
    mkdir -p /root/.near/data
    cd /root/.near/data
    /app/s5cmd --no-sign-request=true cp $SNAPSHOT_BUCKET .
    echo "Download of snapshot complete."
fi

echo "Copying default config to node"
cp /root/.near/config.json.default /root/.near/config.json

ls -l /root/.near

neard run
