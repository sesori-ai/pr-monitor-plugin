# Release automation. Two commands:
#
#   make bump VERSION=X.Y.Z   set the version everywhere and cut the CHANGELOG section (then commit + PR as usual)
#   make publish              from a clean, up-to-date main: full check matrix, publish both npm packages,
#                             verify the registry, then create and push the annotated Claude/Codex plugin tag
#
# Every step is a separate recipe line, so a failure stops exactly where it happened and nothing after it runs.
# npm versions are immutable, which is why both publishes and both registry checks happen before the tag.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

VERSION ?= $(shell node -p "require('./opencode/package.json').version")
TAG := v$(VERSION)
OPENCODE_CLI ?= $(shell command -v opencode || true)
OMP_VERSION ?= 18.0.4

.PHONY: help bump check publish preflight publish-npm verify-npm tag

help:
	@sed -n '2,8p' Makefile | sed 's/^# \{0,1\}//'

## make bump VERSION=X.Y.Z — one version across both npm workspaces, the lockfile, both plugin manifests,
## the MCP server, and CHANGELOG.md.
bump:
	@test -n "$(filter-out $(shell node -p "require('./opencode/package.json').version"),$(VERSION))" || \
	  echo "manifests already at $(VERSION); only the CHANGELOG section will be cut"
	node scripts/bump-version.mjs $(VERSION)
	npm install --package-lock-only --ignore-scripts --no-audit --no-fund
	npm run build:claude
	npm run version:check
	@echo "Bumped to $(VERSION). Review CHANGELOG.md, then commit and open the release PR."

## The complete pre-publish matrix from the README, on a fresh install.
check:
	npm ci --no-audit --no-fund
	npm run release:check
	@if [ -n "$(OPENCODE_CLI)" ]; then OPENCODE_CLI="$(OPENCODE_CLI)" npm run host:check:opencode; \
	  else echo "opencode not on PATH; skipping current OpenCode host check"; fi
	OMP_VERSION=$(OMP_VERSION) npm run host:check:omp
	git diff --exit-code -- claude-code/dist/mcp-server.mjs

## Refuse to publish anything that is not the reviewed main commit.
preflight:
	@test -z "$$(git status --porcelain)" || { echo "working tree is not clean"; exit 1; }
	@test "$$(git branch --show-current)" = main || { echo "publish from main (current: $$(git branch --show-current))"; exit 1; }
	git fetch -q origin main
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "local main differs from origin/main"; exit 1; }
	@! git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || { echo "$(TAG) already exists locally"; exit 1; }
	@! git ls-remote --exit-code --tags origin "refs/tags/$(TAG)" >/dev/null || { echo "$(TAG) already exists on origin"; exit 1; }
	@grep -q '^## \[$(VERSION)\]' CHANGELOG.md || { echo "CHANGELOG.md has no [$(VERSION)] section (run make bump)"; exit 1; }
	npm whoami
	@! npm view @sesori/pr-monitor-opencode@$(VERSION) version >/dev/null 2>&1 || { echo "@sesori/pr-monitor-opencode@$(VERSION) is already published"; exit 1; }
	@! npm view @sesori/pr-monitor-pi@$(VERSION) version >/dev/null 2>&1 || { echo "@sesori/pr-monitor-pi@$(VERSION) is already published"; exit 1; }
	@echo "preflight ok: publishing $(VERSION) from $$(git rev-parse --short HEAD)"

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

## make publish — everything above, in order, stopping at the first failure.
publish: preflight check publish-npm verify-npm tag
