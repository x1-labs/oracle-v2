FROM python:3.13-slim

RUN useradd --system --uid 10001 --create-home oracle

WORKDIR /app
COPY price-feed/price-feed.py ./price-feed.py

USER oracle
EXPOSE 8281

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8281/healthz', timeout=2)"]

CMD ["python", "-u", "price-feed.py"]
