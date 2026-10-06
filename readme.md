<div align="center">

# 🤖 Baileys Assistant Bot

**A lightweight, RAM-aware WhatsApp bot built with [Baileys](https://github.com/WhiskeySockets/Baileys)**

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Baileys](https://img.shields.io/badge/Baileys-7.0--rc-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)

_📥 Direct downloads • ⚡ Priority queue • 🧠 Smart RAM protection • 🔐 Auto owner detection_

</div>

---

## 📖 Table of Contents

- [✨ Features](#-features)
- [🚀 Quick Start](#-quick-start)
- [⚙️ Configuration](#️-configuration)
- [📱 Deployment](#-deployment)
- [🎮 Commands](#-commands)
- [🧠 How It Works](#-how-it-works)
- [📁 Project Structure](#-project-structure)
- [🔧 Troubleshooting](#-troubleshooting)

---

## ✨ Features

|                        |                                                           |
| ---------------------- | --------------------------------------------------------- |
| 📥 **Smart Downloads** | Direct links with real-time RAM validation                |
| ⚡ **Priority Queue**  | Reorder or fast-track downloads anytime                   |
| 🔐 **Flexible Auth**   | Interactive prompt, owner-only, or whitelist              |
| 🎯 **LID Resolution**  | Works with phone numbers **or** LIDs                      |
| ☁️ **Cloud-Ready**     | Environment variable support for Railway / Koyeb / Render |
| 🖥️ **System Info**     | OS, RAM, CPU, and uptime at a glance                      |

---

## 🚀 Quick Start

**Prerequisites:** Node.js v18+ and an active WhatsApp account.

```bash
git clone https://github.com/yourusername/baileys-assistant-bot.git
cd baileys-assistant-bot
npm install
npm start
```

### 🎬 First Run

The bot prompts you on startup:

```text
───────────────────────────────────────────────────────
🤖  Bot Startup Setup
───────────────────────────────────────────────────────

  1) 🔑 Pairing Code
  2) 📷 QR Code

  Choose [1/2]: _
```

**Steps:**

1. Choose `1` (pairing) or `2` (QR)
2. _(Pairing only)_ Enter your WhatsApp number — **digits only**, e.g. `94768830907`
3. Enter allowed users separated by commas — **or press Enter for owner-only** 🔒
4. Enter the pairing code in WhatsApp → **Linked Devices**

**✅ Done!** Your bot is now live.

---

## ⚙️ Configuration

Pick **one** of three methods (priority order):

### 🥇 1. Environment Variables _(recommended for cloud)_

Set in **Railway / Koyeb / Render → Variables** tab:

| Variable           | Example                   |
| ------------------ | ------------------------- |
| `USE_PAIRING_CODE` | `true`                    |
| `PAIRING_NUMBER`   | `94768830907`             |
| `ALLOWED_USERS`    | `94711111111,94722222222` |

### 🥈 2. `config.js` _(recommended for VPS)_

```js
export default {
  prefix: ".",
  botName: "Baileys Assistant Bot",

  usePairingCode: true, // true = Pairing | false = QR
  pairingNumber: "94768830907", // digits only

  allowedUsers: ["94711111111", "94722222222"],
  // [] = owner only 🔒
};
```

### 🥉 3. Interactive Prompt _(local only)_

Do nothing — the bot asks on startup.

> 📊 **Priority:** Env Vars → `config.js` → Prompt

---

## 📱 Deployment

### 🚂 Railway

1. Push your code to GitHub
2. **New Project** → **Deploy from GitHub repo**
3. **Variables** tab → add:
   ```
   USE_PAIRING_CODE=true
   PAIRING_NUMBER=94768830907
   ALLOWED_USERS=94711111111,94722222222
   ```
4. **Deployments → View Logs** → copy the pairing code
5. Enter it in WhatsApp → **Linked Devices**

> ⚠️ Railway has no interactive terminal — environment variables are required.

### 🎨 Koyeb / Render / Heroku

Same approach: push to GitHub, add env vars, deploy, check logs for the pairing code.

### 🖥️ VPS / Raspberry Pi

```bash
npm install -g pm2
pm2 start index.js --name baileys-bot
pm2 save && pm2 startup
pm2 logs baileys-bot
```

---

## 🎮 Commands

> All commands use the prefix `.` (configurable)

### 📥 Download

| Command            | Description                          |
| ------------------ | ------------------------------------ |
| **`.dl <link>`**   | Download a file from a direct link   |
| **`.qf <number>`** | Move a queue item to the top         |
| **`.qf <link>`**   | Add an urgent link next in line      |
| **`.du`**          | Check active download progress       |
| **`.q`**           | View the full download queue         |
| **`.dq`**          | Cancel active download + clear queue |

### ⚙️ Utility

| Command          | Description                           |
| ---------------- | ------------------------------------- |
| **`.menu`**      | Show command menu                     |
| **`.fw <jids>`** | Forward a replied message without tag |
| **`.jid`**       | Show current chat JID                 |
| **`.sys`**       | Show OS, RAM, CPU, uptime             |

### 💡 Examples

```bash
# Download a file
.dl https://example.com/file.pdf

# Add an urgent link (jumps queue)
.qf https://example.com/urgent.zip

# Move queue item #4 to the top
.qf 4

# Check progress
.du

# View queue
.q

# Cancel everything
.dq

# Forward to 2 recipients
.fw 94711111111 94722222222

# System info
.sys
```

---

## 🧠 How It Works

### 🔐 Authorization

```text
New message
    │
    ├─ Owner?             → ✅ Allow
    ├─ allowedUsers []?   → 🔒 Owner only
    ├─ In allowed list?   → ✅ Allow
    └─ Otherwise          → ❌ Ignore
```

### 🎯 LID → Phone Resolution

Modern WhatsApp uses **LIDs** (`102404955582676@lid`) instead of raw phone numbers. The bot resolves them via a 4-step fallback chain:

1. **Cache** — instant after first lookup
2. **`signalRepository.lidMapping.getPNForLID()`** — official Baileys API
3. **Contacts sync** — background population
4. **Manual `config.lidMapping`** — emergency fallback

### 💾 RAM-Aware Downloads

Every download checks free RAM in real time:

```text
Safe Limit = Free RAM − 150 MB (safety buffer)
```

Files exceeding this are **auto-blocked** to prevent server crashes.

| Free RAM | Max Download |
| -------- | ------------ |
| 2 GB     | ~1.85 GB     |
| 1 GB     | ~850 MB      |
| 500 MB   | ~350 MB      |
| 100 MB   | ❌ Blocked   |

---

## 📁 Project Structure

```text
baileys-assistant-bot/
├── index.js                  # Main entry + WhatsApp socket
├── config.js                 # Static configuration
├── package.json
├── lib/
│   ├── startup.js            # Interactive setup prompt
│   ├── utils.js              # RAM, formatting, OS helpers
│   └── downloader.js         # Queue processor
├── handlers/
│   └── commandHandler.js     # Command dispatcher
├── session/                  # (auto) WhatsApp auth state
└── temp/                     # (auto) Temporary downloads
```

---

## 🔧 Troubleshooting

**❌ Bot reconnecting (status 401)**
Delete `session/` and re-pair:

```bash
rm -rf session && npm start
```

**❌ Pairing code never appears**
Empty `pairingNumber` with `usePairingCode: true`. Set a real number or switch to QR mode.

**❌ Railway deploy hangs**
No TTY. Use environment variables instead of the interactive prompt.

**❌ Allowed users can't trigger commands**
Wait 2–3 minutes for contacts sync. The **owner always works**; only whitelist users are affected by LID delay.

**❌ Command not working**
Check the [Commands](#-commands) section for the correct command names.

**❌ EMFILE: too many open files**
File handle leak from aborted downloads. Ensure `downloader.js` calls `writer.destroy()` in the abort / error / `finally` paths.

**❌ Disk full after deleting a file (Linux)**
Open file handle keeps space reserved. Restart the bot, then update `downloader.js`.

---

<div align="center">

**⭐ If this project helped you, consider giving it a star!**

</div>
