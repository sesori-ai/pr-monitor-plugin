# Release automation — one command, run on a clean, up-to-date main:
#
#   make publish                 (asks for the new version; pass VERSION=X.Y.Z to skip the prompt)
#
# In order, stopping at the first failure: preflight guards → write the version everywhere and cut the
# CHANGELOG section (committed to main as "Release vX.Y.Z" when anything changed) → full check matrix →
# push main → publish both npm packages → verify the registry → create and push the annotated plugin tag.
# npm versions are immutable, which is why both publishes and both registry checks happen before the tag.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

VERSION ?=
TAG := v$(VERSION)
MANIFEST_VERSION := $(shell node -p "require('./opencode/package.json').version")
OPENCODE_CLI ?= $(shell command -v opencode || true)
OMP_VERSION ?= 18.0.4

.PHONY: help publish release preflight bump check push-main publish-npm verify-npm tag

help:
	@sed -n '2,8p' Makefile | sed 's/^# \{0,1\}//'

## Refuse to release anything that is not a clean, current main.
preflight:
	@test -z "$$(git status --porcelain)" || { echo "working tree is not clean"; exit 1; }
	@test "$$(git branch --show-current)" = main || { echo "run from main (current: $$(git branch --show-current))"; exit 1; }
	git fetch -q origin main
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "local main differs from origin/main"; exit 1; }
	@! git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || { echo "$(TAG) already exists locally"; exit 1; }
	@! git ls-remote --exit-code --tags origin "refs/tags/$(TAG)" >/dev/null || { echo "$(TAG) already exists on origin"; exit 1; }
	npm whoami
	@! npm view @sesori/pr-monitor-opencode@$(VERSION) version >/dev/null 2>&1 || { echo "@sesori/pr-monitor-opencode@$(VERSION) is already published"; exit 1; }
	@! npm view @sesori/pr-monitor-pi@$(VERSION) version >/dev/null 2>&1 || { echo "@sesori/pr-monitor-pi@$(VERSION) is already published"; exit 1; }
	@echo "preflight ok: releasing $(VERSION) from $$(git rev-parse --short HEAD)"

## One version across both npm workspaces, the lockfile, both plugin manifests, the MCP server (and its committed
## bundle), and CHANGELOG.md — committed to main only if anything actually changed.
bump:
	node scripts/bump-version.mjs $(VERSION)
	npm install --package-lock-only --ignore-scripts --no-audit --no-fund
	npm run build:claude
	npm run version:check
	@grep -q '^## \[$(VERSION)\]' CHANGELOG.md || { echo "CHANGELOG.md has no [$(VERSION)] section"; exit 1; }
	@if [ -n "$$(git status --porcelain)" ]; then git add -A && git commit -q -m "Release $(TAG)" && echo "committed Release $(TAG)"; \
	  else echo "already at $(VERSION); nothing to commit"; fi

## The complete pre-publish matrix from the README, on a fresh install.
check:
	npm ci --no-audit --no-fund
	npm run release:check
	@if [ -n "$(OPENCODE_CLI)" ]; then OPENCODE_CLI="$(OPENCODE_CLI)" npm run host:check:opencode; \
	  else echo "opencode not on PATH; skipping current OpenCode host check"; fi
	OMP_VERSION=$(OMP_VERSION) npm run host:check:omp
	git diff --exit-code -- claude-code/dist/mcp-server.mjs

## The release commit reaches origin before anything immutable is published.
push-main:
	git push origin main

publish-npm:
	npm publish --workspace @sesori/pr-monitor-opencode --access public
	npm publish --workspace @sesori/pr-monitor-pi --access public

verify-npm:
	test "$$(npm view @sesori/pr-monitor-opencode@$(VERSION) version)" = "$(VERSION)"
	test "$$(npm view @sesori/pr-monitor-pi@$(VERSION) version)" = "$(VERSION)"

tag:
	git tag -a $(TAG) -m "$(TAG)"
	git push origin $(TAG)
	@echo "released $(TAG): both npm packages published, plugin tag pushed"

## Entry point. Without VERSION, show where things stand and ask; then run the ordered release with it set.
publish:
	@if [ -z "$(VERSION)" ]; then \
	  published="$$(npm view @sesori/pr-monitor-opencode version 2>/dev/null || echo none)"; \
	  last_tag="$$(git describe --tags --abbrev=0 2>/dev/null || echo none)"; \
	  echo "Last published version is $$published (last tag $$last_tag, manifests at $(MANIFEST_VERSION))"; \
	  read -r -p "What should the new version be? [$(MANIFEST_VERSION)] " answer </dev/tty; \
	  exec $(MAKE) release VERSION="$${answer:-$(MANIFEST_VERSION)}"; \
	else exec $(MAKE) release VERSION="$(VERSION)"; fi

release: preflight bump check push-main publish-npm verify-npm tag
