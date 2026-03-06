#!/bin/bash
cd /home/rdp06c/Apex

# Fetch latest from origin
git fetch origin main 2>/dev/null

# Check if there are new commits
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
    echo "$(date): New changes detected, pulling..."
    git pull origin main

    # Rebuild if source files changed
    CHANGED=$(git diff --name-only $LOCAL $REMOTE)
    if echo "$CHANGED" | grep -qE '^(src/|server/)'; then
        echo "Source/server files changed — rebuilding and restarting..."
        bash build.sh
        # Delay restart so any in-flight HTTP response can complete
        ( sleep 2 && sudo systemctl restart apex ) &

        # Notify via ntfy
        TOPIC=$(grep NTFY_TOPIC ~/Apex/.env | cut -d= -f2)
        SUMMARY=$(git log --oneline $LOCAL..$REMOTE | head -3)
        curl -s -H "Title: APEX Auto-Updated" -H "Priority: default" -H "Tags: arrows_counterclockwise" \
            -d "Pulled and restarted:\n$SUMMARY" "https://ntfy.sh/$TOPIC" >/dev/null
        echo "Restarted and notified."
    else
        echo "No source/server changes — skip restart."
    fi
else
    echo "$(date): Up to date."
fi
