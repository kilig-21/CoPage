# Browser smoke fallback when the upstream registry cannot serve the pinned images.
FROM golang:1.24.6-bookworm@sha256:ab1d1823abb55a9504d2e3e003b75b36dbeb1cbcc4c92593d85a84ee46becc6c AS minio-build
WORKDIR /src
RUN git init -q && \
    git fetch --depth 1 -q https://github.com/minio/minio.git 07c3a429bfed433e49018cb0f78a52145d4bedeb && \
    git checkout --detach -q FETCH_HEAD && \
    CGO_ENABLED=0 go build -p=3 -trimpath -o /minio .

FROM golang:1.24.6-bookworm@sha256:ab1d1823abb55a9504d2e3e003b75b36dbeb1cbcc4c92593d85a84ee46becc6c AS mc-build
WORKDIR /src
RUN git init -q && \
    git fetch --depth 1 -q https://github.com/minio/mc.git 7394ce0dd2a80935aded936b09fa12cbb3cb8096 && \
    git checkout --detach -q FETCH_HEAD && \
    CGO_ENABLED=0 go build -p=3 -trimpath -o /mc .

FROM curlimages/curl:8.12.1@sha256:94e9e444bcba979c2ea12e27ae39bee4cd10bc7041a472c4727a558e213744e6 AS server
USER root
COPY --from=minio-build /minio /usr/local/bin/minio
ENTRYPOINT ["/usr/local/bin/minio"]

FROM busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec AS client
COPY --from=mc-build /mc /usr/local/bin/mc
ENTRYPOINT ["/usr/local/bin/mc"]
