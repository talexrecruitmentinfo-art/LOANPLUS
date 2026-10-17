FROM node:24-slim

ENV PNPM_HOME="/pnpm"
ENV COREPACK_HOME="/home/node/.cache/node/corepack"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

RUN corepack enable
COPY --chmod=644 package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY apps/web apps/web

RUN pnpm install --filter @loanplus/web... --frozen-lockfile \
    && pnpm --filter @loanplus/web build

RUN mkdir -p apps/web/.next/cache /home/node/.cache/node/corepack \
    && chown -R node:node apps/web/.next/cache /home/node/.cache
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["pnpm", "--filter", "@loanplus/web", "start"]