FROM node:24-bookworm AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci
COPY frontend/ ./frontend/
COPY shared/ ./shared/
RUN npm --prefix frontend run build

FROM golang:1.26.10-bookworm AS build
WORKDIR /src
COPY backends/go/go.mod backends/go/go.sum ./
RUN go mod download
COPY backends/go/ ./
RUN rm -rf ./internal/polaris/web
COPY --from=frontend /src/public/ ./internal/polaris/web/
RUN CGO_ENABLED=0 go build -tags release -trimpath -ldflags="-s -w" -o /polaris ./cmd/polaris && mkdir /data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /polaris /polaris
COPY --from=build --chown=65532:65532 /data /data
ENV POLARIS_ADDR=0.0.0.0:8080 \
    POLARIS_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/polaris"]
