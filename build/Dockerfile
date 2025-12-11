# FROM --platform=linux/amd64 nearprotocol/nearcore:2.9.1
FROM --platform=linux/amd64 nearprotocol/nearcore:latest

RUN apt-get update
RUN apt-get install -y wget
RUN apt-get clean

COPY files/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# default config
COPY files/config.json /app/config.json.default
COPY files/genesis.json /app/genesis.json

ENTRYPOINT /app/entrypoint.sh
