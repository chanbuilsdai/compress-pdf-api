# editpdf.tools Compress PDF API - compression service (Google Cloud Run)
FROM node:22-bookworm-slim

# Ghostscript (AGPL, used unmodified) + qpdf (Apache-2.0, used only to check files)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ghostscript qpdf \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./

# Run as the built-in non-root user
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
