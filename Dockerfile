FROM node:22-slim

RUN apt-get update && apt-get install -y curl git bash && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ src/
COPY public/ public/

EXPOSE 3100

CMD ["node", "src/server.js"]
