FROM ghcr.io/cloud-cli/image-node:latest

WORKDIR /home/app
ENV NODE_ENV=production

USER root
COPY . .
RUN chown -R node:node /home/app
USER node
RUN pnpm install --prod --frozen-lockfile

# The mounted workspace must be writable for commits and release snapshots.
USER root

CMD ["npm", "start"]
