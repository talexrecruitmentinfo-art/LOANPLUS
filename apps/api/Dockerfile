FROM node:24-slim

ENV PNPM_HOME="/pnpm"
ENV COREPACK_HOME="/home/node/.cache/node/corepack"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY --chmod=644 package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api apps/api

RUN pnpm install --filter @loanplus/api... --frozen-lockfile \
    && pnpm --filter @loanplus/api db:generate \
    && pnpm --filter @loanplus/api build \
    && mkdir -p /app/uploads/website \
    && chown -R node:node /app/uploads

RUN mkdir -p /home/node/.cache/node/corepack && chown -R node:node /home/node/.cache
ENV NODE_ENV=production
EXPOSE 4000
USER node
CMD ["node", "apps/api/dist/src/main.js"]