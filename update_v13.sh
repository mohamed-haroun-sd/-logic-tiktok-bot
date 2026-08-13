#!/bin/bash

echo "🚀 Updating TikTok Bot to V13..."

# Stop current bot
pm2 stop all || true

# Install new dependencies
echo "📦 Installing dependencies..."
npm install jsqr pngjs playwright-extra puppeteer-extra-plugin-stealth express

# Ensure directories exist
mkdir -p public_html
mkdir -p screenshots
mkdir -p tiktok_proxy_data

# Clear old session data if requested (optional)
# rm -rf tiktok_proxy_data/*
# rm tiktok_session.json

# Start the Master Dashboard
echo "🎬 Starting V13 Master Dashboard..."
xvfb-run --auto-servernum node dashboard.js &

echo "✅ V13 is now running!"
echo "📱 Open: http://$(curl -s ifconfig.me):3000 on your phone"
