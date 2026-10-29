FROM node:24-bookworm-slim
EXPOSE 8000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/ src/
COPY entry/node.ts entry/
USER node
CMD ["npm", "start"]
