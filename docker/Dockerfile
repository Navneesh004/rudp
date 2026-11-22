FROM node:22-slim

# iproute2 provides `tc` (netem), tcpdump captures traffic, procps provides pkill.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iproute2 tcpdump procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY baseline baseline
RUN npm run build

CMD ["sleep", "infinity"]
