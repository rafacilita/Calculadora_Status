name: Snapshot diário CRR5

on:
  workflow_dispatch:
  schedule:
    # 00:01 BRT (UTC-3) = 03:01 UTC
    - cron: "1 3 * * *"

permissions:
  contents: write

jobs:
  snapshot:
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"
      METRICS_URL: ${{ secrets.METRICS_URL }}

    steps:
      - name: Checkout repo
        uses: actions/checkout@v4
        with:
          persist-credentials: true
          fetch-depth: 0

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Run snapshot script
        run: node scripts/snapshot.js

      - name: Commit & push (if changed)
        run: |
          git config user.name "crr5-snapshot-bot"
          git config user.email "crr5-snapshot-bot@users.noreply.github.com"

          if [ -n "$(git status --porcelain)" ]; then
            git add data/*.json || true
            git commit -m "chore(snapshot): daily metrics snapshot"
            git push
          else
            echo "No changes to commit."
          fi
