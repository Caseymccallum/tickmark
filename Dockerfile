# One container, one volume, no build step and nothing to install.
#
# There is no `npm install` in this file because there are no dependencies: the
# database and the crypto come from the runtime. For software that holds other
# people's financial records, the shortest possible supply chain is a feature the
# operator can see for themselves in `package.json`.
FROM node:24-alpine

WORKDIR /app

# The application is source. There is nothing to compile and nothing to fetch.
COPY package.json ./
COPY src ./src
# `web/` is not optional. The server imports the envelope format from it so that it can tell an
# encrypted upload from a plaintext one, and it serves those files to the browser as the scripts that
# do the encrypting and the opening. The image builds without them and then cannot start — which is
# how this line came to be written.
COPY web ./web

# Data on a volume, so that stopping the container does not delete a practice's
# records and so that a backup is a file copy. Owned by the unprivileged user the
# process runs as; a bind mount may need the same `chown` done on the host.
ENV TICKMARK_DATA=/data/tickmark.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

CMD ["node", "src/server.js"]