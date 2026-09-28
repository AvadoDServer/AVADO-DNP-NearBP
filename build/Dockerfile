# nearcore, pinned by version AND digest (the multi-arch index Docker Hub serves
# for the tag), so a moved or re-pushed tag cannot change what a package
# contains. The bump bot (.github/pipeline/bump.mjs) writes this line; by hand,
# take the digest from https://hub.docker.com/v2/repositories/nearprotocol/nearcore/tags/<version>
# and keep "upstream" in dappnode_package.json the same version.
FROM --platform=linux/amd64 nearprotocol/nearcore:2.13.4@sha256:07b16f7bdac9634b571586406177bdfe8add7537bc5838d54f34d505534397a3

RUN apt-get update
RUN apt-get install -y wget
RUN apt-get clean

COPY files/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# default config
COPY files/config.json /app/config.json.default
COPY files/genesis.json /app/genesis.json

ENTRYPOINT ["/app/entrypoint.sh"]
