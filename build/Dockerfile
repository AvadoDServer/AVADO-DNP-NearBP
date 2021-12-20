FROM nearprotocol/nearcore:master-4425c94a810f9b169c27a9198e95a8b13afd35a2

RUN apt-get update
RUN apt-get install -y wget
RUN apt-get clean

COPY files/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT /app/entrypoint.sh
