# One command from a cold start, and one to put it back.
#
# Teardown being a single command is not a convenience — it is what makes the
# habit stick. The same reasoning applies to the AWS side in stage 02: if
# `make down` is easy, it gets run, and the bill stays small.

SHELL := /bin/bash
export DOCKER_BUILDKIT := 1

.PHONY: help dev up down clean logs ps test spec build fmt

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

dev: up ## Build and start everything, then wait until it is actually usable
	@echo "waiting for health..."
	@for i in $$(seq 1 60); do \
	  if [ "$$(docker compose ps --format '{{.Health}}' | grep -c healthy)" -ge 6 ]; then break; fi; \
	  sleep 2; \
	done
	@docker compose ps --format 'table {{.Service}}\t{{.Status}}'
	@echo ""
	@echo "  web        http://localhost:8090"
	@echo "  api        http://localhost:3000"
	@echo "  minio      http://localhost:59001  (nook / nook_local_only)"

up: ## Build images and start the stack
	docker compose up -d --build

down: ## Stop the stack, keeping data
	docker compose down

clean: ## Stop the stack and delete volumes — everything goes
	docker compose down -v

ps: ## What is running
	docker compose ps

logs: ## Follow logs (make logs S=api)
	docker compose logs -f $(S)

test: ## Run the collaboration integration checks against the running stack
	cd services/collab && \
	  API_URL=http://localhost:8090 \
	  COLLAB_URL_A=ws://localhost:3001 \
	  COLLAB_URL_B=ws://localhost:3002 \
	  node test/two-clients.mjs

spec: ## Regenerate the OpenAPI document from the code
	cd services/api && pnpm build && \
	  DATABASE_URL=postgres://nook:nook_local_only@localhost:55432/nook \
	  REDIS_URL=redis://localhost:56379 \
	  JWT_SECRET=local_dev_secret_replace_in_every_real_environment \
	  S3_ENDPOINT=http://localhost:59000 S3_BUCKET=nook-attachments \
	  S3_ACCESS_KEY=nook S3_SECRET_KEY=nook_local_only \
	  node dist/openapi.js > openapi.json
	@echo "wrote services/api/openapi.json"

build: ## Typecheck and build every service
	pnpm -r build
	cd services/exporter && go build ./...
