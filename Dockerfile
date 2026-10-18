# The copy runner as a container (hosted on Cloudflare Containers, see platform/host/). Everything a copy job needs:
# Node + Playwright's Chromium (from the base image, matching harness/package.json), Python with fonttools for font
# subsetting, and ffmpeg for background video.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3-pip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY harness/requirements.txt harness/
RUN pip3 install --break-system-packages --no-cache-dir -r harness/requirements.txt

COPY harness/package.json harness/package-lock.json harness/
COPY platform/package.json platform/package-lock.json platform/
RUN cd harness && npm ci --omit=dev --ignore-scripts && cd ../platform && npm ci --omit=dev
COPY harness harness
COPY platform platform

# Which code made each copy (recorded on every version): pass the commit when building.
ARG PIPELINE_VERSION=unknown
ENV PIPELINE_VERSION=$PIPELINE_VERSION \
    PORT=8080 \
    RUN_DIR=/tmp/runs \
    RUNNER_SLOTS=2
EXPOSE 8080
CMD ["node", "platform/runner.mjs"]
