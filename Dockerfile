FROM node:22-bookworm-slim AS assets
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=1 go build -trimpath -o /out/temp .

FROM assets AS test
COPY --from=build /out/temp /usr/local/bin/temp
COPY index.html openapi.json ./
COPY static ./static
COPY test ./test
CMD ["npm","test"]

FROM debian:bookworm-slim AS runtime
WORKDIR /app
RUN mkdir data && chown 1000:1000 data
COPY --from=build /out/temp /usr/local/bin/temp
COPY --from=assets /app/node_modules ./node_modules
COPY index.html openapi.json ./
COPY static ./static
USER 1000:1000
ENV BIND=0.0.0.0 PORT=3443
EXPOSE 3443
ENTRYPOINT ["/usr/local/bin/temp"]
