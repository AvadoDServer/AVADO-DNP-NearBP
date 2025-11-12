#!/bin/bash

echo "Starting NEAR node on network $NETWORK"

# Check if this node has been initialized already
if [ ! -f /root/.near/config.json ]; then

    echo "No data found - initializing chain"

    # Initialize chain
    NEARD_INIT="neard init --chain-id $NETWORK --download-genesis"
    echo "No config found - initializing node: $NEARD_INIT"
    $NEARD_INIT

fi

echo "Copying default config to node"
cp /app/config.json.default /root/.near/config.json


echo "List items in /root/.near"
ls -l /root/.near

neard run

sleep 9999
