# Linux toolchain for a macOS .dmg (the recipe Bitcoin Core uses): xorrisofs
# writes a Rock Ridge image macOS mounts (exec bits and symlinks survive), and
# libdmg-hfsplus's `dmg` compresses it into a UDZO disk image.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      xorriso cmake make g++ zlib1g-dev libbz2-dev libssl-dev git ca-certificates \
  && git clone https://github.com/fanquake/libdmg-hfsplus /src \
  && git -C /src checkout --quiet 1cc791e4173da9cb0b0cc16c5a1aaa25d5eb5efa \
  && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release \
  && make -C /src/build dmg-bin \
  && install -m755 /src/build/dmg/dmg /usr/local/bin/dmg \
  && rm -rf /src /var/lib/apt/lists/*
