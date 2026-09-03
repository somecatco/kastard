# check=skip=InvalidDefaultArgInFrom
ARG RUNTIME_IMAGE
FROM ${RUNTIME_IMAGE}

ARG KASTARD_CHANNEL=development
ARG KASTARD_PRODUCT_VERSION
ARG KASTARD_SOURCE_REVISION

WORKDIR /app
COPY LICENSE LICENSE
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/common/package.json packages/common/package.json
RUN bun install --frozen-lockfile --production --filter @kastard/worker

COPY apps/worker/src apps/worker/src
COPY apps/worker/tsconfig.json apps/worker/tsconfig.json
COPY --chmod=0755 apps/worker/scripts/worker-entrypoint.sh /usr/local/bin/kastard-worker-entrypoint
COPY packages/common/src packages/common/src

ENV PORT=5278 \
	KASTARD_CHANNEL=$KASTARD_CHANNEL \
	KASTARD_PRODUCT_VERSION=$KASTARD_PRODUCT_VERSION \
	KASTARD_SOURCE_REVISION=$KASTARD_SOURCE_REVISION \
	PATH=/opt/kastard/runtime/bin:$PATH \
	KASTARD_COMFYUI_ROOT=/workspace/kastard \
	KASTARD_RUNTIME_PYTHON=/opt/kastard/runtime/bin/python \
	KASTARD_RUNTIME_MANIFEST=/opt/kastard/runtime-manifest.json \
	UV_CONSTRAINT=/opt/kastard/runtime-constraints.txt
EXPOSE 22 2222

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD ["bun", "-e", "const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 5278}/health`); if (!response.ok) process.exit(1)"]

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/kastard-worker-entrypoint"]
WORKDIR /app/apps/worker
CMD ["bun", "run", "src/index.ts"]
