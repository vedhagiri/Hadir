FROM node:20-alpine

WORKDIR /app

# Install only the package manifests first so this layer caches when source
# changes. node_modules is mounted as a named volume in compose so it
# survives container restarts and stays Linux-built (not macOS-built).
COPY package.json ./
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]
