# Linux toolchain for a macOS .dmg (the recipe Bitcoin Core uses): xorrisofs
# writes a Rock Ridge image macOS mounts (exec bits and symlinks survive), and
# libdmg-hfsplus's `dmg` compresses it into a UDZO disk image.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      xorriso cmake make g++ zlib1g-dev libbz2-dev libssl-dev git ca-certificates \
  && git clone --depth 1 https://github.com/fanquake/libdmg-hfsplus /src \
  && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release \
  && make -C /src/build dmg-bin \
  && install -m755 /src/build/dmg/dmg /usr/local/bin/dmg \
  && rm -rf /src /var/lib/apt/lists/*
