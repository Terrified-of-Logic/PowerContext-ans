FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements-lock.txt ./
RUN pip install --no-cache-dir -r requirements-lock.txt
COPY game.py service.py ./
ENV MIDNIGHT_DATA=/data
EXPOSE 8765
CMD ["uvicorn", "service:create_app", "--factory", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
