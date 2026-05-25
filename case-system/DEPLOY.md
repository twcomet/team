# 繪新管理系統 — VPS 部署說明

## 環境需求
- Ubuntu 22.04+
- Node.js 18+（建議用 nvm 安裝）
- PM2（process manager）
- Nginx（反向代理 + HTTPS）

## 部署步驟

### 1. 安裝 Node.js + PM2
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 20
npm install -g pm2
```

### 2. 拉程式碼
```bash
git clone https://github.com/twcomet/team.git /var/www/huixin
cd /var/www/huixin/case-system
npm install --production
```

### 3. 設定環境變數
```bash
cp .env.example .env
nano .env   # 填入 SESSION_SECRET（用隨機字串）
```

### 4. 啟動服務
```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup   # 跟著指示設定開機自啟
```

### 5. Nginx 設定（/etc/nginx/sites-available/huixin）
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 6. 申請 SSL（Let's Encrypt 免費）
```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

### 7. 更新程式碼
```bash
cd /var/www/huixin
git pull
cd case-system && npm install --production
pm2 restart huixin-case-system
```

## 資料備份
SQLite 檔案在 `case-system/huixin.db`，建議每日備份：
```bash
# 加進 crontab: crontab -e
0 2 * * * cp /var/www/huixin/case-system/huixin.db /backup/huixin-$(date +\%Y\%m\%d).db
```

## LINE OA 串接
部署完成後，在 LINE Developers Console 設定 Webhook URL：
```
https://your-domain.com/api/line/webhook
```

---

## Zeabur 部署（目前使用）

### 資料持久化（跨裝置同步的關鍵）

Zeabur 每次部署會重建 Docker image，若 SQLite 放在 container 內會被清空。  
必須掛載 Persistent Volume 並設定 `DB_PATH` 環境變數：

**步驟：**
1. Zeabur Dashboard → 服務 → Storage → 新增 Volume，掛載路徑設為 `/data`
2. 環境變數設定：
   ```
   DB_PATH=/data/huixin.db
   SESSION_SECRET=<隨機長字串>
   NODE_ENV=production
   ```

設定後，`huixin.db`（案件資料）和 `sessions.db`（登入 session）都會存在 `/data/`，  
重新部署不會遺失資料，所有裝置存取同一份資料庫。

### 快速確認資料是否在持久化路徑
登入後呼叫（需 owner 帳號）：
```
GET /api/auth/me → 確認 session 正常
```
或在 Zeabur 的 Terminal 執行：
```bash
ls -lh /data/
```
若看到 `huixin.db`，表示持久化設定正確。
