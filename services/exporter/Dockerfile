# syntax=docker/dockerfile:1.10

FROM golang:1.23-bookworm@sha256:e87b2a5f6df2dff71ea330d55d54f4979eb380ae58a7e3aabc9d53121243e689 AS build
WORKDIR /src
COPY services/exporter/go.mod ./
RUN go mod download
COPY services/exporter/ ./

# CGO_ENABLED=0 gives a static binary with no libc dependency, which is what
# makes a distroless static base possible at all. -s -w strips the symbol
# table and DWARF data; the binary is not being debugged in production, it is
# being replaced.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/exporter .

# static:nonroot has no shell, no package manager, no libc — nothing to pivot
# to if the process is compromised. It also means `docker exec` into this
# container gives you nothing, which is the trade: harder to debug, far less
# to attack. Stage 08 covers how you debug it anyway (ephemeral containers).
FROM gcr.io/distroless/static-debian12:nonroot@sha256:52dcfbabb7457ea47c82f6e13af8c8a4a1d9f7b0145142b3ecab20f2b888411d
COPY --from=build /out/exporter /exporter
USER nonroot:nonroot
EXPOSE 3003
ENTRYPOINT ["/exporter"]
