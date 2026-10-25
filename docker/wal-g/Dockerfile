# Static WAL-G for the Alpine-based supabase/postgres image, which ships none. Writes walg/wal-g:
#   checkout: docker build -f docker/wal-g/Dockerfile -o docker/walg docker/wal-g
#   release:  docker build -f wal-g/Dockerfile -o walg wal-g
FROM golang:1.25-alpine3.23 AS build
ARG WALG_VERSION=v3.0.9
RUN apk add --no-cache build-base git libsodium-dev libsodium-static
RUN git clone --depth 1 --branch "$WALG_VERSION" https://github.com/wal-g/wal-g /src
WORKDIR /src
# WAL-G imports encoding/json/v2, which Go 1.25 only builds under this experiment.
ENV GOEXPERIMENT=jsonv2 CGO_ENABLED=1
RUN go build -tags libsodium -o /out/wal-g \
      -ldflags "-s -w -linkmode external -extldflags -static \
        -X github.com/wal-g/wal-g/cmd/pg.walgVersion=$WALG_VERSION \
        -X github.com/wal-g/wal-g/cmd/pg.gitRevision=$(git rev-parse --short HEAD)" \
      ./main/pg

FROM scratch
COPY --from=build /out/wal-g /wal-g
