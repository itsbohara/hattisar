FROM node:24-alpine AS os
RUN apk add --no-cache postgresql17-client \
  && mkdir /data \
  && chown node:node /data
ENV HATTISAR_DATA_DIR=/data \
  COREPACK_HOME=/opt/corepack \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

FROM os AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install && pnpm install --frozen-lockfile

FROM deps AS dev
COPY tsconfig.json ./
COPY src ./src
USER node
VOLUME /data
EXPOSE 8000
CMD ["pnpm", "dev"]

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM os AS runtime
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
VOLUME /data
EXPOSE 8000
CMD ["node", "dist/main.js"]
