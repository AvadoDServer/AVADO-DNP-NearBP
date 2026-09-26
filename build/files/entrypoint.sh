#!/bin/bash

echo "Starting NEAR node on network $NETWORK"

# Initialise the node when its files are missing. "neard init" writes
# config.json before genesis.json and node_key.json, so a first start that was
# cut short can leave config.json without the others; neard then fails on every
# start. neard init refuses to run while config.json exists, so it is removed
# first (the default config is copied over it below anyway). neard init keeps
# an existing node_key.json and validator_key.json; this script never touches
# the key files.
if [ ! -f /root/.near/config.json ] || [ ! -f /root/.near/genesis.json ] || [ ! -f /root/.near/node_key.json ]; then

    rm -f /root/.near/config.json

    NEARD_INIT="neard init --chain-id $NETWORK --download-genesis"
    echo "Node files missing - initializing node: $NEARD_INIT"
    $NEARD_INIT

fi

echo "Copying default config to node"
cp /app/config.json.default /root/.near/config.json


echo "List items in /root/.near"
ls -l /root/.near

# exec: neard becomes PID 1, so "docker stop" (every update) reaches it and it
# can shut the database down cleanly. If neard exits, the container exits and
# Docker restarts it, instead of the old "sleep 9999" leaving it down for hours.
exec neard run
