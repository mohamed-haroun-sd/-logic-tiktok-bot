#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# cleanup_bot.sh — Full clean-state reset for the TikTok bot
#
# Run on the VPS:
#   cd /root/tiktok-bot
#   wget -q https://raw.githubusercontent.com/mohamed-haroun-sd/-logic-tiktok-bot/main/cleanup_bot.sh
#   bash cleanup_bot.sh          # dry-run preview
#   bash cleanup_bot.sh --yes    # actually clean
# ═══════════════════════════════════════════════════════════════════

set -e
REAL_RUN=0
if [ "$1" = "--yes" ]; then REAL_RUN=1; fi

echo "═══════════════════════════════════════════════════════════"
echo "🧹 TikTok Bot — Clean State Reset"
echo "═══════════════════════════════════════════════════════════"

if [ "$REAL_RUN" = "0" ]; then
    echo ""
    echo "👀 DRY-RUN MODE — showing what WOULD be done."
    echo "   Run 'bash cleanup_bot.sh --yes' to execute."
    echo ""
fi

# ── 1. Stop everything ──
echo "⏸️  Step 1: Stopping services..."
pm2 stop tiktok-bot 2>/dev/null || true
systemctl stop beinty 2>/dev/null || true

# kill any stray node/chrome (safety net)
pkill -f "node login.js" 2>/dev/null || true

# ── 2. Bot files ──
echo "📁 Step 2: Cleaning bot state files..."
BOT_DIR="/root/tiktok-bot"

cleanup_file () {
    local p="$BOT_DIR/$1"
    if [ -e "$p" ]; then
        if [ "$REAL_RUN" = "1" ]; then
            rm -rf "$p"
            echo "   🗑️  Deleted: $p"
        else
            echo "   👀 Would delete: $p"
        fi
    else
        echo "   ⬜ Not found (skip): $p"
    fi
}

cleanup_file "tiktok_session.json"
cleanup_file "tiktok_proxy_data"
cleanup_file "processed_orders.json"
cleanup_file "screenshots"

# ── 3. Database: reset stuck orders ──
echo "🗃️  Step 3: Resetting stuck orders in bot_data.json..."
DB="/root/beinty/bot_data.json"
if [ -f "$DB" ]; then
    if [ "$REAL_RUN" = "1" ]; then
        python3 - <<'EOF'
import json, sys, datetime

DB = "/root/beinty/bot_data.json"
with open(DB, encoding="utf-8") as f:
    d = json.load(f)

orders = d.get("tiktok_orders", {})
if not orders:
    print("   ⬜ No tiktok_orders found")
    sys.exit(0)

moved = []
for oid, o in list(orders.items()):
    st = (o.get("status") or "").lower()
    # Only reset orders that are genuinely stuck (never succeeded)
    if st in ("processing", "waiting_link", "pending", "wait_login", "logged_in", "charging"):
        # Archive the stuck attempt inside the order record
        o["reset_at"] = datetime.datetime.now().isoformat()
        o["reset_from"] = st
        o["status"] = "failed"
        moved.append(oid)
        print(f"   🗑️  Order {oid} ({st}) → marked failed (archived)")

d["tiktok_orders"] = orders
with open(DB, "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)

print(f"   ✅ {len(moved)} stuck order(s) archived → failed")
EOF
    else
        echo "   👀 Would reset all stuck orders (processing/waiting_link/pending/charging) → failed"
    fi
else
    echo "   ⚠️  DB not found at $DB — skipping"
fi

# ── 4. Restart everything ──
if [ "$REAL_RUN" = "1" ]; then
    echo "🚀 Step 4: Restarting services..."
    systemctl start beinty
    cd "$BOT_DIR" && pm2 start login.js --name tiktok-bot 2>/dev/null || pm2 start "$BOT_DIR/login.js" --name tiktok-bot
    sleep 3
    echo ""
    echo "✅ DONE — Clean state restored"
    echo ""
    pm2 status tiktok-bot
    systemctl is-active beinty
    echo ""
    echo "📋 Verification:"
    ls -la "$BOT_DIR" | grep -E "tiktok_session|tiktok_proxy_data|processed_orders" && echo "   ⚠️  State files still exist!" || echo "   ✅ No stale state files remain"
    pgrep -f "login.js" | wc -l | xargs echo "   🧩 Running bot instances:"
else
    echo ""
    echo "   👀 Would restart: systemctl start beinty && pm2 start tiktok-bot"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
if [ "$REAL_RUN" = "1" ]; then
    echo "🎉 Ready for a fresh test order."
else
    echo "👀 Nothing was changed (dry-run)."
fi
echo "═══════════════════════════════════════════════════════════"
