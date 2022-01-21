FROM nearprotocol/nearcore:1.23.1

RUN apt-get update
RUN apt-get install -y wget
RUN apt-get clean

COPY files/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT /app/entrypoint.sh
