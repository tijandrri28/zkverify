# Railway Dockerfile — zkVerify Agent Games agent "caramel".
# Long-lived Node.js HTTP server. Railway injects PORT at runtime;
# the server reads it from the environment (see src/config.js).
#
# The circuit binaries (.wasm/.zkey) are NOT vendored in the repo (they are
# binary and cannot be pushed via the GitHub snapshot API); they are
# downloaded at build time from the official Agent Games site and verified
# against the sha256 hashes recorded in circuits/README.md.
FROM node:20-slim

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the server source and the text circuit artifacts (vk.json, README).
COPY server.js ./
COPY src ./src
COPY circuits ./circuits

# Download the binary circuit artifacts from the official site and verify.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL -o circuits/gatekeeper.wasm https://agentgames.zkverify.io/circuits/gatekeeper.wasm \
 && curl -fsSL -o circuits/gatekeeper_final.zkey https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey \
 && curl -fsSL -o circuits/vfy-policy.wasm https://agentgames.zkverify.io/circuits/vfy-policy.wasm \
 && curl -fsSL -o circuits/vfy-policy_final.zkey https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey \
 && echo "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f  circuits/gatekeeper.wasm" | sha256sum -c - \
 && echo "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d  circuits/gatekeeper_final.zkey" | sha256sum -c - \
 && echo "bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2  circuits/vfy-policy.wasm" | sha256sum -c - \
 && echo "f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41  circuits/vfy-policy_final.zkey" | sha256sum -c - \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Run as a non-root user.
RUN chown -R node:node /app
USER node

# Railway sets PORT; EXPOSE is documentation only.
EXPOSE 3000

CMD ["node", "server.js"]
