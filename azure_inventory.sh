#!/usr/bin/env bash

echo "=========================================" > azure_inventory.txt
echo " Azure Migration Inventory" >> azure_inventory.txt
echo "=========================================" >> azure_inventory.txt
echo "" >> azure_inventory.txt

log() {
    echo "$1"
    echo "$1" >> azure_inventory.txt
}

run() {
    log ""
    log "### $1"
    shift
    "$@" >> azure_inventory.txt 2>&1
}

# One find with the vendored/tooling trees pruned (not just filtered — pruned, so we never
# descend into them). Every section shares this list; the old per-section copies drifted and
# let node_modules *.py and .claude worktree checkouts flood the inventory.
finder() {
    find . \( \
        -path "*/node_modules" \
        -o -path "*/.git" \
        -o -path "*/venv" \
        -o -path "*/.venv" \
        -o -path "*/__pycache__" \
        -o -path "*/.claude" \
        -o -path "*/.next" \
        \) -prune -o \( "$@" \) -print | drop_ignored
}

# This report gets committed, so whatever .gitignore keeps out of the repo stays out of the
# report too — data/ and profiles/generated/ hold the real client roster/KB ("keep local"),
# and the Delinea recovery artifacts are marked "not for git". Outside a git checkout this
# passes everything through.
drop_ignored() {
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        while IFS= read -r p; do
            git check-ignore -q "$p" || printf '%s\n' "$p"
        done
    else
        cat
    fi
}

log "Date: $(date)"
log "Current Directory: $(pwd)"

run "Operating System" uname -a

run "Python Version" python3 --version
run "Node Version" node --version
run "NPM Version" npm --version
run "Git Version" git --version

if command -v docker >/dev/null; then
    run "Docker Version" docker --version
else
    log ""
    log "### Docker Version"
    log "Docker not installed"
fi

if command -v az >/dev/null; then
    run "Azure CLI Version" az version
else
    log ""
    log "### Azure CLI Version"
    log "Azure CLI not installed"
fi

log ""
log "### Directory Structure"

finder -maxdepth 3 | sort >> azure_inventory.txt

log ""
log "### Python Files"

finder \( -name "*.py" \
    -o -name "requirements.txt" \
    -o -name "pyproject.toml" \
    -o -name "Pipfile" \) >> azure_inventory.txt

log ""
log "### FastAPI Files"

grep -R "FastAPI(" . \
    --exclude-dir=node_modules \
    --exclude-dir=.git \
    --exclude-dir=venv \
    --exclude-dir=.venv \
    --exclude-dir=.claude \
    --exclude-dir=.next \
    --exclude-dir=data \
    --exclude-dir=generated \
    --exclude=azure_inventory.sh \
    --exclude=azure_inventory.txt \
    >> azure_inventory.txt 2>/dev/null

log ""
log "### package.json Files"

package_jsons=$(finder -name package.json | sort)

printf '%s\n' "$package_jsons" >> azure_inventory.txt

while IFS= read -r f; do
    [ -n "$f" ] || continue
    log ""
    log "===== $f ====="

    python3 - "$f" <<'EOF' >> azure_inventory.txt 2>&1
import json, sys
try:
    with open(sys.argv[1]) as fp:
        p=json.load(fp)
    print("name:",p.get("name"))
    print("version:",p.get("version"))
    print("scripts:")
    for k,v in p.get("scripts",{}).items():
        print(" ",k,"=",v)
except Exception as e:
    print(e)
EOF

done <<< "$package_jsons"

log ""
log "### Docker Files"

finder \( -name Dockerfile \
    -o -name docker-compose.yml \
    -o -name compose.yml \
    -o -name docker-compose.yaml \) >> azure_inventory.txt

log ""
log "### Environment Files"

finder \( -name ".env*" -o -name "*.env" \) >> azure_inventory.txt

log ""
log "### Git"

git remote -v >> azure_inventory.txt 2>/dev/null

git branch >> azure_inventory.txt 2>/dev/null

log ""
log "### Requirements"

finder -name requirements.txt | while IFS= read -r f
do
    log ""
    log "===== $f ====="
    cat "$f" >> azure_inventory.txt 2>&1
done

log ""
log "========================================="
log "Inventory Complete"
log "Output saved to:"
log "$(pwd)/azure_inventory.txt"
