# BoneHost CS2 dedicated server image
# Game files persist in the mounted volume (/home/steam/cs2data) so container
# recreation (config changes, update passes) never re-downloads 60GB.
FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip tar lib32gcc-s1 lib32stdc++6 libicu72 jq procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 steam

USER steam
WORKDIR /home/steam
RUN mkdir -p steamcmd cs2data \
    && curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz -C steamcmd

COPY --chown=steam:steam entrypoint.sh install_addons.sh /home/steam/
RUN chmod +x /home/steam/entrypoint.sh /home/steam/install_addons.sh

ENTRYPOINT ["/home/steam/entrypoint.sh"]
