#!/bin/bash

echo "Starting NEAR node on network $NETWORK"

# Check if this node has been initialized already
if [ ! -f /root/.near/config.json ]; then

    # Initialize chain
    NEARD_INIT="neard init --chain-id $NETWORK --download-genesis"
    echo "No config found - initializing node: $NEARD_INIT"
    $NEARD_INIT

    # Download a snapshot to sync faster
    echo "Downloading chain snapshot & unpack"

    SNAPSHOT_URL="https://near-protocol-public.s3.ca-central-1.amazonaws.com/backups/$NETWORK/rpc/data.tar"
    echo "Retrieving snapshot from $SNAPSHOT_URL"
    mkdir -p /root/.near/data
    cd /root/.near/data
    wget -qO- $SNAPSHOT_URL | tar xv
    echo "Download of snapshot complete."
fi

ls -l /root/.near

neard run
